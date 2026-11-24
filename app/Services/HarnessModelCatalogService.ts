import os from 'node:os';
import path from 'node:path';
import {
  builtinClaudeCatalog,
  CATALOG_HARNESSES,
  parseClaudeCatalog,
  parseCodexCatalog,
  parseOpenCodeCatalog,
  type HarnessModel,
  type HarnessModelCatalog,
  type HarnessProviderCatalog
} from '../Harness/ModelCatalog';
import { execFileResolved, spawnResolved, stopChild } from '../Platform/ServiceProcess';
import type { AgentAdapterRegistry } from '../Agents/AgentAdapterRegistry';
import type { DatabaseService } from './DatabaseService';
import type { DebugLogService } from './DebugLogService';
import type { OpenCodeServerService } from './OpenCodeServerService';
import type { SettingsService } from './SettingsService';

const CODEX_OUTPUT_LIMIT = 8 * 1024 * 1024;
const DEFAULT_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

export interface HarnessModelCatalogOptions {
  database: DatabaseService;
  settings: SettingsService;
  env: NodeJS.ProcessEnv;
  adapters?: AgentAdapterRegistry;
  openCodeServer?: Pick<OpenCodeServerService, 'listModels' | 'listProviders'>;
  liveClaudeModels?: () => Promise<HarnessModel[] | null>;
  liveCodexModels?: () => Promise<HarnessModel[] | null>;
  debugLog?: Pick<DebugLogService, 'write'>;
  now?: () => string;
  codexTimeoutMs?: number;
  claudeTimeoutMs?: number;
  openCodeTimeoutMs?: number;
  refreshIntervalMs?: number;
  // Called after each refresh saves the catalog, so clients read it again.
  onChanged?: () => void;
}

// Discovers selectable models for each agent harness and caches them in the
// settings table. A failing provider keeps its previous list and records the
// error; the UI shows stale options instead of losing them.
export class HarnessModelCatalogService {
  private refreshPromise: Promise<HarnessModelCatalog> | null = null;
  private staleRefreshPromise: Promise<HarnessModelCatalog> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => string;
  private readonly codexTimeoutMs: number;
  private readonly claudeTimeoutMs: number;
  private readonly openCodeTimeoutMs: number;
  private readonly refreshIntervalMs: number;

  constructor(private readonly deps: HarnessModelCatalogOptions) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.codexTimeoutMs = deps.codexTimeoutMs ?? 20_000;
    this.claudeTimeoutMs = deps.claudeTimeoutMs ?? 20_000;
    this.openCodeTimeoutMs = deps.openCodeTimeoutMs ?? 20_000;
    this.refreshIntervalMs = deps.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
  }

  read(): HarnessModelCatalog {
    return this.deps.settings.harnessModelCatalog();
  }

  start(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      void this.refresh().catch(() => { /* refresh records provider errors itself */ });
    }, this.refreshIntervalMs);
    this.refreshTimer.unref?.();
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  async refresh(): Promise<HarnessModelCatalog> {
    this.refreshPromise ??= (async () => {
      await this.staleRefreshPromise?.catch(() => undefined);
      return this.runRefresh(CATALOG_HARNESSES);
    })().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  // Skips providers whose cached catalog is fresh and error-free; still
  // refreshes any missing, stale, or errored provider.
  async refreshIfStale(): Promise<HarnessModelCatalog> {
    if (this.refreshPromise) return this.refreshPromise;
    const current = this.read();
    const stale = CATALOG_HARNESSES.filter((harness) => this.isStale(harness, current.providers[harness]));
    if (!stale.length) return current;
    this.staleRefreshPromise ??= this.runRefresh(stale).finally(() => {
      this.staleRefreshPromise = null;
    });
    return this.staleRefreshPromise;
  }

  private isStale(harness: (typeof CATALOG_HARNESSES)[number], previous: HarnessProviderCatalog | null): boolean {
    if (!previous || previous.error !== null || !previous.refreshedAt || !previous.models.length) return true;
    if (harness === 'claude' && previous.source === 'builtin' && this.executableFor('claude')) return true;
    const refreshedAtMs = Date.parse(previous.refreshedAt);
    const nowMs = Date.parse(this.now());
    if (!Number.isFinite(refreshedAtMs) || !Number.isFinite(nowMs)) return true;
    const ageMs = nowMs - refreshedAtMs;
    return ageMs < 0 || ageMs >= this.refreshIntervalMs;
  }

  private async runRefresh(targets: readonly (typeof CATALOG_HARNESSES)[number][]): Promise<HarnessModelCatalog> {
    const current = this.read();
    const providers = { ...current.providers };
    await Promise.allSettled(targets.map(async (harness) => {
      const previous = current.providers[harness];
      const startedAt = Date.now();
      try {
        providers[harness] = await this.discover(harness, previous);
        this.deps.debugLog?.write('harness-models', 'refresh', {
          harness,
          elapsed_ms: Date.now() - startedAt,
          models: providers[harness]?.models.length ?? 0
        });
      } catch (error) {
        providers[harness] = {
          harness,
          source: previous?.source ?? (harness === 'opencode' ? 'api' : 'cli'),
          refreshedAt: previous?.refreshedAt ?? null,
          error: error instanceof Error ? error.message : String(error),
          models: previous?.models ?? []
        };
        this.deps.debugLog?.write('harness-models', 'refresh.failed', {
          harness,
          elapsed_ms: Date.now() - startedAt,
          message: providers[harness]?.error ?? null
        });
      }
    }));
    const catalog = this.deps.settings.updateHarnessModelCatalog({ providers });
    this.deps.onChanged?.();
    return catalog;
  }

  private async discover(harness: (typeof CATALOG_HARNESSES)[number], previous: HarnessProviderCatalog | null): Promise<HarnessProviderCatalog> {
    if (harness === 'claude') {
      // Claude Code has no list command; its stream-json `initialize` reply
      // names the account's models. The built-in aliases cover a missing CLI.
      const executable = this.executableFor(harness);
      if (!executable) return builtinClaudeCatalog(this.now());
      const live = await this.liveModelsFor('claude');
      if (live?.length) {
        return { harness, source: 'cli', refreshedAt: this.now(), error: null, models: live };
      }
      return {
        harness,
        source: 'cli',
        refreshedAt: this.now(),
        error: null,
        models: parseClaudeCatalog(await this.initializeClaude(executable, this.claudeTimeoutMs))
      };
    }
    const executable = this.executableFor(harness);
    if (!executable) {
      throw new Error(`${harness} was not discovered.`);
    }
    if (harness === 'codex') {
      const live = await this.liveModelsFor('codex');
      if (live?.length) {
        return { harness, source: 'cli', refreshedAt: this.now(), error: null, models: live };
      }
      const output = await this.run(executable, ['debug', 'models'], this.codexTimeoutMs);
      return {
        harness,
        source: 'cli',
        refreshedAt: this.now(),
        error: null,
        models: parseCodexCatalog(JSON.parse(output))
      };
    }
    if (harness === 'agy') {
      // Native listing performs no model request. Its versioned model ids
      // already encode thinking level, so do not invent reasoning options.
      const output = await this.run(executable, ['models'], this.openCodeTimeoutMs);
      const models = output.split(/\r?\n/).flatMap((line) => {
        const match = /^(\S+)\t(.+)$/.exec(line);
        return match ? [{ id: match[1]!, label: match[2]!, reasoning: [], defaultReasoning: null }] : [];
      });
      if (!models.length) throw new Error('Antigravity returned no selectable models');
      return { harness, source: 'cli', refreshedAt: this.now(), error: null, models };
    }
    const server = this.deps.openCodeServer ?? this.openCodeAdapter();
    const [response, providers] = await Promise.all([
      server
        ? server.listModels(executable)
        : this.run(executable, ['api', 'GET', '/api/model'], this.openCodeTimeoutMs).then((output) => JSON.parse(output) as unknown),
      // Provider names only label the models, so the catalog survives without them.
      (server
        ? server.listProviders(executable)
        : this.run(executable, ['api', 'GET', '/api/provider'], this.openCodeTimeoutMs).then((output) => JSON.parse(output) as unknown)
      ).catch(() => null)
    ]);
    return {
      harness,
      source: 'api',
      refreshedAt: this.now(),
      error: null,
      models: parseOpenCodeCatalog(response, providers)
    };
  }

  private async liveModelsFor(harness: 'claude' | 'codex'): Promise<HarnessModel[] | null> {
    const callback = harness === 'claude' ? this.deps.liveClaudeModels : this.deps.liveCodexModels;
    if (callback) return callback().catch(() => null);
    const adapter = this.deps.adapters?.get(harness);
    if (!adapter?.liveModels) return null;
    const result = await adapter.liveModels().catch(() => null);
    return Array.isArray(result) ? result as HarnessModel[] : null;
  }

  private openCodeAdapter(): Pick<OpenCodeServerService, 'listModels' | 'listProviders'> | undefined {
    const adapter = this.deps.adapters?.get('opencode') as Partial<Pick<OpenCodeServerService, 'listModels' | 'listProviders'>> | undefined;
    return adapter && typeof adapter.listModels === 'function' && typeof adapter.listProviders === 'function'
      ? adapter as Pick<OpenCodeServerService, 'listModels' | 'listProviders'>
      : undefined;
  }

  private executableFor(harness: string): string | null {
    const row = this.deps.database.connection
      .prepare(`select executable_path from harness_installations where harness = ? and status = 'available' order by last_checked_at desc limit 1`)
      .get(harness) as { executable_path: string } | undefined;
    return row?.executable_path?.trim() || null;
  }

  // Sends only the native `initialize` control request; no prompt is submitted
  // and the session is not persisted.
  private initializeClaude(executable: string, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child = spawnResolved(executable, [
        '-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
        '--no-session-persistence', '--strict-mcp-config'
      ], { env: this.deps.env, cwd: os.homedir(), stdio: ['pipe', 'pipe', 'ignore'] });
      let buffer = '';
      let settled = false;
      const finish = (error: Error | null, value?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stopChild(child, 'SIGTERM');
        if (error) reject(error);
        else resolve(value);
      };
      const failed = (): void => finish(new Error(`${path.basename(executable)} model discovery failed.`));
      const timer = setTimeout(failed, timeoutMs);
      child.on('error', failed);
      child.on('exit', failed);
      child.stdin.on('error', () => { /* exit reports the failure */ });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > CODEX_OUTPUT_LIMIT) return failed();
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          let event: { type?: unknown; response?: { request_id?: unknown; subtype?: unknown; response?: unknown } };
          try { event = JSON.parse(line); } catch { continue; }
          if (event.type !== 'control_response' || event.response?.request_id !== 'patterm_models') continue;
          if (event.response.subtype === 'success') finish(null, event.response.response);
          else failed();
          return;
        }
      });
      child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'patterm_models', request: { subtype: 'initialize' } })}\n`);
    });
  }

  private run(executable: string, args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      execFileResolved(
        executable,
        args,
        { env: this.deps.env, cwd: os.homedir(), timeout: timeoutMs, maxBuffer: CODEX_OUTPUT_LIMIT },
        (error, stdout) => {
          if (error) {
            // execFile errors echo argv and provider diagnostics; keep them out of logs and IPC.
            reject(new Error(`${path.basename(executable)} model discovery failed.`));
            return;
          }
          resolve(stdout);
        }
      );
    });
  }
}
