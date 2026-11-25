import { computed, onMounted, onScopeDispose, shallowRef, watch } from 'vue';
import { topicChanged, topicRead, useTopicRefresh } from './serverQuery';

// Mirrors UpdateState in app/Services/UpdateService.ts.
export interface UpdateState {
  supported: boolean;
  currentVersion: string | null;
  settings: { autoCheck: boolean; channel: 'stable' | 'prerelease' };
  status: 'idle' | 'checking' | 'up_to_date' | 'available' | 'installing' | 'error';
  checkedAt: string | null;
  error: string | null;
  latest: { version: string; prerelease: boolean; publishedAt: string; notesUrl: string } | null;
  canApply: boolean;
  applyUnavailable: string | null;
  requiresQuit?: boolean;
  restartDetail: string;
}

// One copy for the top bar's dot and Settings › About.
const state = shallowRef<UpdateState | null>(null);

let reads = 0;

// Cached until the next update announcement. A slower, older read never
// replaces a newer state.
async function load(): Promise<void> {
  const read = ++reads;
  try {
    const next = await topicRead('updates', ['settings_updates_get'], async () => await window.patterm.call('settings_updates_get', {}) as UpdateState);
    if (read === reads) state.value = next;
  }
  catch { /* A failed read keeps the last state; the next announcement retries. */ }
}

// A state this client just received outdates any read under way and the
// cached one.
function remember(next: UpdateState): void {
  reads++;
  topicChanged('updates');
  state.value = next;
}

export function useUpdates(host?: string | null) {
  if (!host) {
    useTopicRefresh(['updates'], () => void load());
    onMounted(() => { void load(); });
    return state;
  }
  const remoteState = shallowRef<UpdateState | null>(null);
  let remoteReads = 0;
  let pendingReads = 0;
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const clearPoll = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  const loadRemote = async (): Promise<void> => {
    if (disposed) return;
    const read = ++remoteReads;
    pendingReads++;
    try {
      const next = await window.patterm.call('settings_updates_get', {}, host) as UpdateState;
      if (!disposed && read === remoteReads) remoteState.value = next;
    } catch { /* Handled by the panel's actions if offline. */ }
    finally { pendingReads--; }
  };
  const syncPoll = (value: UpdateState | null): void => {
    const active = !disposed && (value?.status === 'checking' || value?.status === 'installing');
    if (active && !timer) {
      timer = setInterval(() => { if (pendingReads === 0) void loadRemote(); }, 2000);
    } else if (!active) {
      clearPoll();
    }
  };
  watch(remoteState, syncPoll);
  onScopeDispose(() => {
    disposed = true;
    clearPoll();
  });
  onMounted(() => { void loadRemote(); });
  return computed({
    get: () => remoteState.value,
    set: (next: UpdateState | null) => {
      remoteReads++;
      remoteState.value = next;
    }
  });
}

export async function saveUpdateSettings(settings: UpdateState['settings'], host?: string | null): Promise<UpdateState> {
  const next = await window.patterm.call('settings_updates_update', settings, host ?? undefined) as UpdateState;
  if (!host) remember(next);
  return next;
}

export async function checkForUpdates(host?: string | null): Promise<UpdateState> {
  const next = await window.patterm.call('settings_updates_check', {}, host ?? undefined) as UpdateState;
  if (!host) remember(next);
  return next;
}

// Starts the installer for the version the owner confirmed. On the desktop
// the caller then quits Patterm; a server restarts itself.
export async function applyUpdate(version: string, host?: string | null): Promise<{ quit: boolean; state: UpdateState }> {
  const result = await window.patterm.call('settings_updates_apply', { confirmed: true, version }, host ?? undefined) as { quit: boolean; state: UpdateState };
  if (!host) remember(result.state);
  return result;
}
