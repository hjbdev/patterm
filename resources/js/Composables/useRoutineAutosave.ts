import { ref } from 'vue';
import type { RoutinePatch, RoutineRecord } from '../lib/routines';

interface PendingEdit {
  routineId: string;
  patch: RoutinePatch;
}

export interface RoutineAutosaveOptions {
  save: (routineId: string, patch: RoutinePatch) => Promise<RoutineRecord>;
  onSaved: (saved: RoutineRecord) => void;
  // Null clears an earlier error for that routine.
  onError: (routineId: string, message: string | null) => void;
  delayMs?: number;
}

// Saves routine edits shortly after they are made, one request at a time. Edits
// belong to the routine they were made on, so switching routines never sends
// one routine's edits to another, and a failed save keeps its edits for retry.
export function useRoutineAutosave(options: RoutineAutosaveOptions) {
  const delay = options.delayMs ?? 400;
  const saving = ref(false);
  // Edits not yet sent, for the routine they were made on.
  let pending: PendingEdit | null = null;
  // Edits whose save failed, per routine; the routine's next save resends them.
  const retry = new Map<string, RoutinePatch>();
  // Saves queued or in flight, per routine. A reply only replaces the draft once
  // none is left, so an older reply never overwrites newer edits.
  const queued = new Map<string, number>();
  const settle = (routineId: string) => {
    const count = (queued.get(routineId) ?? 1) - 1;
    if (count > 0) queued.set(routineId, count);
    else queued.delete(routineId);
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let active = 0;

  function change(routineId: string, patch: RoutinePatch): void {
    if (pending && pending.routineId !== routineId) void flush();
    pending = { routineId, patch: { ...pending?.patch, ...patch } };
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), delay);
  }

  // Sends the pending edits, or with a routine ID, makes sure that routine's
  // edits have saved. Resolves false when they could not be saved, so callers
  // such as Run now never act on settings the server rejected.
  async function flush(routineId?: string): Promise<boolean> {
    if (timer) clearTimeout(timer);
    timer = null;
    // Captured now, so a later selection change cannot redirect these edits.
    const captured = pending;
    pending = null;
    const target = captured?.routineId ?? routineId ?? null;
    if (captured) queued.set(captured.routineId, (queued.get(captured.routineId) ?? 0) + 1);
    const previous = queue;
    const result = (async () => {
      await previous;
      if (!target) return true;
      const failed = retry.get(target);
      retry.delete(target);
      if (!captured && !failed) return true;
      // A retry with nothing new captured still counts as a queued save.
      if (!captured) queued.set(target, (queued.get(target) ?? 0) + 1);
      const patch = { ...failed, ...captured?.patch };
      active += 1;
      saving.value = true;
      try {
        const saved = await options.save(target, patch);
        settle(target);
        options.onError(target, null);
        options.onSaved(saved);
        return true;
      } catch (cause) {
        settle(target);
        retry.set(target, { ...patch, ...retry.get(target) });
        options.onError(target, cause instanceof Error ? cause.message : String(cause));
        return false;
      } finally {
        active -= 1;
        saving.value = active > 0;
      }
    })();
    queue = result;
    return result;
  }

  function hasPending(routineId: string): boolean {
    return pending?.routineId === routineId || retry.has(routineId) || queued.has(routineId);
  }

  function discard(routineId: string): void {
    retry.delete(routineId);
    if (pending?.routineId !== routineId) return;
    pending = null;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return { saving, change, flush, hasPending, discard };
}
