import { randomUUID } from 'node:crypto';
import type { WorkbenchSnapshotDto } from '../Repositories/WorkbenchRepository';
import { diffWorkbench, type WorkbenchPatch } from './WorkbenchPatch';

export interface WorkbenchVersion {
  epoch: string;
  version: number;
}

export type VersionedWorkbench = WorkbenchSnapshotDto & WorkbenchVersion;

// The version a client already holds, if any.
export interface WorkbenchSince {
  epoch?: string | undefined;
  version?: number | undefined;
}

// What a client lacks after `since`: nothing, the patches it missed, or the
// whole snapshot when the patches are no longer kept or the server restarted.
export type WorkbenchRead =
  | VersionedWorkbench
  | (WorkbenchVersion & { patches: WorkbenchPatch[] })
  | (WorkbenchVersion & { current: true });

export interface WorkbenchSyncOptions {
  // Changes within this window share one rebuild.
  delayMs?: number;
  // A steady stream of changes still publishes at least this often.
  maxDelayMs?: number;
  // Recent patches kept for clients that reconnect or catch up.
  historySize?: number;
  onError?: (error: unknown) => void;
}

// Keeps the last workbench snapshot sent to clients and publishes each change
// as a versioned patch, so clients never refetch the whole workbench to learn
// that one row changed. Every rebuild compares against the last snapshot, so a
// change that was never announced is still published by the next rebuild.
export class WorkbenchSyncService {
  private readonly epoch = randomUUID();
  private readonly listeners = new Set<(patch: WorkbenchPatch) => void>();
  private readonly history: WorkbenchPatch[] = [];
  private readonly delayMs: number;
  private readonly maxDelayMs: number;
  private readonly historySize: number;
  private current: WorkbenchSnapshotDto | null = null;
  private version = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstInvalidatedAt = 0;

  constructor(private readonly build: () => WorkbenchSnapshotDto, private readonly options: WorkbenchSyncOptions = {}) {
    this.delayMs = options.delayMs ?? 16;
    this.maxDelayMs = options.maxDelayMs ?? 100;
    this.historySize = options.historySize ?? 64;
  }

  // Schedules a rebuild. Bursts of changes publish one patch.
  invalidate(): void {
    const now = Date.now();
    if (this.timer === null) this.firstInvalidatedAt = now;
    else clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.delayMs, this.firstInvalidatedAt + this.maxDelayMs - now));
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.flush();
      } catch (error) {
        this.options.onError?.(error);
      }
    }, wait);
  }

  // Rebuilds now, publishes any change, and returns the current snapshot.
  flush(): VersionedWorkbench {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const next = this.build();
    if (this.current) {
      const changes = diffWorkbench(this.current, next);
      if (changes) {
        const patch: WorkbenchPatch = { epoch: this.epoch, from: this.version, to: this.version + 1, changes };
        this.version = patch.to;
        this.history.push(patch);
        if (this.history.length > this.historySize) this.history.shift();
        this.current = next;
        for (const listener of this.listeners) listener(patch);
      }
    } else {
      this.current = next;
    }
    return { ...this.current!, epoch: this.epoch, version: this.version };
  }

  // The snapshot as last published, rebuilt only when a change is pending.
  snapshot(): WorkbenchSnapshotDto {
    if (this.current && this.timer === null) return this.current;
    return this.flush();
  }

  // Answers a client that holds `since`. Pending changes are published first,
  // so patches sent to other clients and this answer agree.
  read(since?: WorkbenchSince | null): WorkbenchRead {
    const snapshot = this.flush();
    if (since?.epoch === this.epoch && typeof since.version === 'number') {
      if (since.version === this.version) return { epoch: this.epoch, version: this.version, current: true };
      const first = this.history.findIndex((patch) => patch.from === since.version);
      if (first >= 0) return { epoch: this.epoch, version: this.version, patches: this.history.slice(first) };
    }
    return snapshot;
  }

  onPatch(listener: (patch: WorkbenchPatch) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.listeners.clear();
  }
}
