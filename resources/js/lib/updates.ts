import { onMounted, shallowRef } from 'vue';
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
function remember(): void {
  reads++;
  topicChanged('updates');
}

export function useUpdates() {
  useTopicRefresh(['updates'], () => void load());
  onMounted(() => { void load(); });
  return state;
}

export async function saveUpdateSettings(settings: UpdateState['settings']): Promise<void> {
  const next = await window.patterm.call('settings_updates_update', settings) as UpdateState;
  remember();
  state.value = next;
}

export async function checkForUpdates(): Promise<void> {
  const next = await window.patterm.call('settings_updates_check', {}) as UpdateState;
  remember();
  state.value = next;
}

// Starts the installer for the version the owner confirmed. On the desktop
// the caller then quits Patterm; a server restarts itself.
export async function applyUpdate(version: string): Promise<{ quit: boolean }> {
  const result = await window.patterm.call('settings_updates_apply', { confirmed: true, version }) as { quit: boolean; state: UpdateState };
  remember();
  state.value = result.state;
  return result;
}
