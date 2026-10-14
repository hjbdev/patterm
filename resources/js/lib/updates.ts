import { onMounted, shallowRef } from 'vue';
import { useContextRefresh } from './projectContext';

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

async function load(): Promise<void> {
  try { state.value = await window.patterm.call('settings_updates_get', {}) as UpdateState; }
  catch { /* A failed read keeps the last state; the next announcement retries. */ }
}

export function useUpdates() {
  useContextRefresh(() => void load(), { topics: ['updates'], lifecycle: false });
  onMounted(() => { void load(); });
  return state;
}

export async function saveUpdateSettings(settings: UpdateState['settings']): Promise<void> {
  state.value = await window.patterm.call('settings_updates_update', settings) as UpdateState;
}

export async function checkForUpdates(): Promise<void> {
  state.value = await window.patterm.call('settings_updates_check', {}) as UpdateState;
}

// Starts the installer. On the desktop the caller then quits Patterm; a
// server restarts itself.
export async function applyUpdate(): Promise<{ quit: boolean }> {
  const result = await window.patterm.call('settings_updates_apply', { confirmed: true }) as { quit: boolean; state: UpdateState };
  state.value = result.state;
  return result;
}
