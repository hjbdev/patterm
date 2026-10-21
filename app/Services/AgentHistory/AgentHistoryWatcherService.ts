import fs from 'node:fs';
import path from 'node:path';
import type { historyImportInput } from './AgentHistoryImportService';
import type { z } from 'zod';
import type { AgentHistoryProvider, HistorySourceCandidate } from './AgentHistoryTypes';
import { walkFilesAsync } from './HistoryAdapterUtils';

interface WatchedPath {
  sourceKey: string;
  path: string;
  watcher: fs.FSWatcher;
}

interface WatchSourceStatus {
  provider: AgentHistoryProvider;
  path: string;
  exists: boolean;
  watchedPaths: string[];
  missing: boolean;
  degraded: boolean;
  scanning: boolean;
  lastEventAt: string | null;
  lastScheduledAt: string | null;
  lastScanStartedAt: string | null;
  lastScanFinishedAt: string | null;
  lastError: string | null;
}

export class AgentHistoryWatcherService {
  private readonly watchers = new Map<string, WatchedPath>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly pendingSince = new Map<string, number>();
  private readonly scanTimers = new Map<string, NodeJS.Timeout>();
  private readonly sources = new Map<string, HistorySourceCandidate>();
  private readonly sourceStatus = new Map<string, WatchSourceStatus>();
  private generation = 0;

  constructor(
    private readonly imports: { enabledWatchSources(): HistorySourceCandidate[]; import(input: z.input<typeof historyImportInput>): unknown },
    private readonly options: { debounceMs?: number; opencodeDebounceMs?: number; maxWaitMs?: number } = {}
  ) {}

  start(): void {
    this.stop();
    for (const source of this.imports.enabledWatchSources()) {
      this.watchSource(source);
    }
  }

  stop(): void {
    this.generation += 1;
    for (const watcher of this.watchers.values()) watcher.watcher.close();
    this.watchers.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pendingSince.clear();
    for (const timer of this.scanTimers.values()) clearTimeout(timer);
    this.scanTimers.clear();
    this.sources.clear();
    this.sourceStatus.clear();
  }

  restart(): void {
    this.start();
  }

  // Imports a provider's sources now, when an Integrated turn ends and its
  // native file holds the whole turn. A pending debounced import still runs:
  // the queue may drop this one behind a busy import, and a harness can finish
  // writing after it reports the turn's end. The rescan also watches folders
  // created since, such as Codex's daily directories.
  flush(provider: AgentHistoryProvider): void {
    for (const source of this.sources.values()) {
      if (source.provider !== provider) continue;
      this.scheduleScan(source);
      this.imports.import({ provider: source.provider, path: source.path, trigger: 'watcher' });
    }
  }

  private watchSource(source: HistorySourceCandidate): void {
    const sourceKey = keyFor(source);
    this.sources.set(sourceKey, source);
    this.updateStatus(source, { exists: fs.existsSync(source.path), watchedPaths: [], missing: !fs.existsSync(source.path), degraded: false, lastError: null });
    const watchPaths = this.immediateWatchPaths(source);
    for (const watchPath of watchPaths) {
      this.installWatcher(source, watchPath);
    }
    this.updateStatus(source, { watchedPaths: this.watchedPathsFor(sourceKey), missing: !fs.existsSync(source.path) });
    this.scheduleScan(source, 0);
  }

  private immediateWatchPaths(source: HistorySourceCandidate): string[] {
    const existing = nearestExistingPath(source.path);
    if (!existing) return [];
    let stat: fs.Stats;
    try {
      stat = fs.statSync(existing);
    } catch {
      return [];
    }
    if (stat.isFile()) return [path.dirname(existing)];
    if (existing !== source.path) return [existing];
    return [existing];
  }

  private async watchPaths(source: HistorySourceCandidate): Promise<string[]> {
    const existing = nearestExistingPath(source.path);
    if (!existing) return [];
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(existing);
    } catch {
      return [];
    }
    if (stat.isFile()) return [path.dirname(existing)];
    if (existing !== source.path) return [existing];
    const directories = new Set<string>([existing]);
    for (const filePath of await walkFilesAsync(existing, (candidate) => watchedFile(source.provider, candidate))) {
      directories.add(path.dirname(filePath));
    }
    return Array.from(directories);
  }

  private installWatcher(source: HistorySourceCandidate, watchPath: string): boolean {
    const sourceKey = keyFor(source);
    const watcherKey = `${sourceKey}:${watchPath}`;
    if (this.watchers.has(watcherKey)) return true;
    try {
      const watcher = fs.watch(watchPath, { persistent: false }, () => {
        const current = this.sources.get(sourceKey) ?? source;
        this.updateStatus(current, { lastEventAt: new Date().toISOString() });
        this.scheduleScan(current);
        this.schedule(current);
      });
      this.watchers.set(watcherKey, { sourceKey, path: watchPath, watcher });
      return true;
    } catch (error) {
      // Native watching is best-effort; manual import and startup scan remain available.
      this.updateStatus(source, { degraded: true, lastError: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  private scheduleScan(source: HistorySourceCandidate, delayMs = 5_000): void {
    const key = keyFor(source);
    const existing = this.scanTimers.get(key);
    if (existing) clearTimeout(existing);
    const generation = this.generation;
    this.scanTimers.set(key, setTimeout(() => {
      this.scanTimers.delete(key);
      void this.reconcileSource(source, generation);
    }, delayMs));
  }

  private async reconcileSource(source: HistorySourceCandidate, generation: number): Promise<void> {
    if (generation !== this.generation) return;
    const sourceKey = keyFor(source);
    this.updateStatus(source, { scanning: true, lastScanStartedAt: new Date().toISOString(), lastError: null });
    try {
      const desired = new Set(await this.watchPaths(source));
      if (generation !== this.generation) return;
      for (const [watcherKey, watched] of this.watchers) {
        if (watched.sourceKey !== sourceKey || desired.has(watched.path)) continue;
        watched.watcher.close();
        this.watchers.delete(watcherKey);
      }
      let degraded = false;
      for (const watchPath of desired) {
        degraded = !this.installWatcher(source, watchPath) || degraded;
      }
      this.updateStatus(source, {
        watchedPaths: this.watchedPathsFor(sourceKey),
        missing: !fs.existsSync(source.path),
        degraded,
        scanning: false,
        lastScanFinishedAt: new Date().toISOString()
      });
    } catch (error) {
      if (generation !== this.generation) return;
      this.updateStatus(source, { degraded: true, scanning: false, lastScanFinishedAt: new Date().toISOString(), lastError: error instanceof Error ? error.message : String(error) });
    }
  }

  private schedule(source: HistorySourceCandidate): void {
    const key = keyFor(source);
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    // Active agents write constantly, so cap the trailing debounce to keep
    // finished conversations from waiting until every agent goes quiet.
    const now = Date.now();
    const since = this.pendingSince.get(key) ?? now;
    this.pendingSince.set(key, since);
    const delay = Math.max(0, Math.min(watcherImportDelayMs(source, this.options), since + (this.options.maxWaitMs ?? 120_000) - now));
    this.updateStatus(source, { lastScheduledAt: new Date().toISOString() });
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      this.pendingSince.delete(key);
      this.imports.import({ provider: source.provider, path: source.path, trigger: 'watcher' });
    }, delay));
  }

  status() {
    const sources = Array.from(this.sourceStatus.values()).map((source) => ({ ...source, watchedPaths: [...source.watchedPaths] }));
    return {
      sourceCount: sources.length,
      watchedPathCount: this.watchers.size,
      missingCount: sources.filter((source) => source.missing).length,
      degradedCount: sources.filter((source) => source.degraded).length,
      sources
    };
  }

  private watchedPathsFor(sourceKey: string): string[] {
    return Array.from(this.watchers.values()).filter((watcher) => watcher.sourceKey === sourceKey).map((watcher) => watcher.path).sort();
  }

  private updateStatus(source: HistorySourceCandidate, patch: Partial<WatchSourceStatus>): void {
    const sourceKey = keyFor(source);
    const existing = this.sourceStatus.get(sourceKey);
    this.sourceStatus.set(sourceKey, {
      provider: source.provider,
      path: source.path,
      exists: fs.existsSync(source.path),
      watchedPaths: [],
      missing: !fs.existsSync(source.path),
      degraded: false,
      scanning: false,
      lastEventAt: null,
      lastScheduledAt: null,
      lastScanStartedAt: null,
      lastScanFinishedAt: null,
      lastError: null,
      ...existing,
      ...patch
    });
  }
}

function keyFor(source: HistorySourceCandidate): string {
  return `${source.provider}:${source.path}`;
}

function watchedFile(provider: AgentHistoryProvider, filePath: string): boolean {
  const base = path.basename(filePath);
  if (provider === 'opencode') return base === 'opencode.db' || base === 'opencode.db-wal' || base === 'opencode.db-shm';
  return filePath.endsWith('.jsonl');
}

function watcherImportDelayMs(source: HistorySourceCandidate, options: { debounceMs?: number; opencodeDebounceMs?: number }): number {
  if (source.provider === 'opencode' && source.sourceKind === 'opencode_db' && options.opencodeDebounceMs !== undefined) {
    return options.opencodeDebounceMs;
  }
  return options.debounceMs ?? 30_000;
}

function nearestExistingPath(targetPath: string): string | null {
  let current = targetPath;
  while (current && current !== path.dirname(current)) {
    if (fs.existsSync(current)) return current;
    current = path.dirname(current);
  }
  return fs.existsSync(current) ? current : null;
}
