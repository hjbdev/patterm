import os from 'node:os';
import path from 'node:path';
import {
  builtinClaudeCatalog,
  CATALOG_HARNESSES,
  parseClaudeCatalog,
  parseCodexCatalog,
  parseOpenCodeCatalog,
  type HarnessModelCatalog,
  type HarnessProviderCatalog
} from '../Harness/ModelCatalog';
import { execFileResolved, spawnResolved, stopChild } from '../Platform/ServiceProcess';
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
  openCodeServer?: Pick<OpenCodeServerService, 'listModels'>;
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
    this.refreshPromise ??= this.runRefresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async runRefresh(): Promise<HarnessModelCatalog> {
    const current = this.read();
    const providers = { ...current.providers };
    for (const harness of CATALOG_HARNESSES) {
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
    }
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
      throw new Error(`${harness === 'codex' ? 'Codex' : 'OpenCode'} was not discovered.`);
    }
    if (harness === 'codex') {
      const output = await this.run(executable, ['debug', 'models'], this.codexTimeoutMs);
      return {
        harness,
        source: 'cli',
        refreshedAt: this.now(),
        error: null,
        models: parseCodexCatalog(JSON.parse(output))
      };
    }
    const response = this.deps.openCodeServer
      ? await this.deps.openCodeServer.listModels(executable)
      : JSON.parse(await this.run(executable, ['api', 'GET', '/api/model'], this.openCodeTimeoutMs));
    return {
      harness,
      source: 'api',
      refreshedAt: this.now(),
      error: null,
      models: parseOpenCodeCatalog(response)
    };
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
