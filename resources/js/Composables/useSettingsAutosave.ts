import { reactive } from 'vue';

export type SettingsSaveState = 'idle' | 'saving' | 'saved' | 'error';

interface SaveEntry { state: Exclude<SettingsSaveState, 'idle'>; error: string }

// Keyed by setting, such as `appearance.terminal.font`. A saved entry fades
// after a moment; a failed one stays until that setting saves.
const saves = reactive(new Map<string, SaveEntry>());
const newest = new Map<string, number>();
const fadeTimers = new Map<string, ReturnType<typeof setTimeout>>();
let sequence = 0;

// Settings save as soon as they change. If a setting changes again while it
// is saving, the newest save decides its status.
export async function autosave(key: string, task: () => Promise<unknown>): Promise<boolean> {
  const id = ++sequence;
  newest.set(key, id);
  clearTimeout(fadeTimers.get(key));
  saves.set(key, { state: 'saving', error: '' });
  let error = '';
  try {
    await task();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  if (newest.get(key) !== id) return !error;
  newest.delete(key);
  if (error) {
    saves.set(key, { state: 'error', error });
    return false;
  }
  saves.set(key, { state: 'saved', error: '' });
  fadeTimers.set(key, setTimeout(() => saves.delete(key), 2000));
  return true;
}

export function settingSaveStatus(key: string): SaveEntry | null {
  return saves.get(key) ?? null;
}

// The combined status of every setting under a prefix. Failures come first.
export function sectionSaveStatus(scope: string): { state: SettingsSaveState; error: string } {
  let state: SettingsSaveState = 'idle';
  for (const [key, entry] of saves) {
    if (key !== scope && !key.startsWith(`${scope}.`)) continue;
    if (entry.state === 'error') return { state: 'error', error: entry.error };
    if (entry.state === 'saving') state = 'saving';
    else if (state === 'idle') state = 'saved';
  }
  return { state, error: '' };
}

export function resetSettingsSaveStatus(): void {
  for (const timer of fadeTimers.values()) clearTimeout(timer);
  fadeTimers.clear();
  newest.clear();
  saves.clear();
}
