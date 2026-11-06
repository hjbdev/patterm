import { reactive } from 'vue';
import { toast } from 'vue-sonner';
import { EMPTY_TAB_LAYOUT, readLegacyTabLayout, type TabLayout } from '../lib/tabStrip';
import { topicChanged, topicRead, useTopicRefresh } from '../lib/serverQuery';

// Each scope's tab layout as the server has it, shared by every view. Edits
// show at once and save in the background; a save the server refuses, because
// another window changed the layout first, reads it again instead.
interface Saved extends TabLayout { revision: number }
interface ScopeState {
  layout: TabLayout;
  // The revision `layout` was saved as, or null until the first read.
  revision: number | null;
  // Saves still on their way: until they land, reads can't replace the edit.
  pending: number;
}

// Each state is reactive; the map isn't, so a view reading a scope for the
// first time doesn't change state it depends on.
const scopes = new Map<string, ScopeState>();

function stateFor(scope: string): ScopeState {
  let state = scopes.get(scope);
  if (!state) {
    // Until the server answers, the layout this device had before.
    state = reactive<ScopeState>({ layout: readLegacyTabLayout(scope) ?? EMPTY_TAB_LAYOUT, revision: null, pending: 0 });
    scopes.set(scope, state);
    void load(scope);
  }
  return state;
}

async function read(scope: string): Promise<Saved> {
  return await topicRead('layout', ['settings_tab_layout_get', scope], async () => await window.patterm.call('settings_tab_layout_get', { scope }) as Saved);
}

async function load(scope: string): Promise<void> {
  let saved: Saved;
  try { saved = await read(scope); }
  catch { return; }
  const state = scopes.get(scope);
  if (!state || state.pending) return;
  // Nothing saved yet: this device's old layout becomes everyone's.
  if (saved.revision === 0 && state.revision === null) {
    const legacy = readLegacyTabLayout(scope);
    if (legacy) {
      state.revision = 0;
      void save(scope, legacy);
      return;
    }
  }
  state.layout = { order: saved.order, folders: saved.folders, filed: saved.filed };
  state.revision = saved.revision;
}

async function save(scope: string, layout: TabLayout): Promise<void> {
  const state = stateFor(scope);
  if (state.revision === null) await load(scope);
  const base = state.revision ?? 0;
  state.layout = layout;
  state.revision = base + 1;
  state.pending += 1;
  try {
    const saved = await window.patterm.call('settings_tab_layout_save', { scope, base_revision: base, ...layout }) as Saved;
    state.pending -= 1;
    if (!state.pending) Object.assign(state, { layout: { order: saved.order, folders: saved.folders, filed: saved.filed }, revision: saved.revision });
  } catch (caught) {
    state.pending -= 1;
    state.revision = null;
    toast.error(caught instanceof Error ? caught.message : 'Could not save the tab layout');
    void load(scope);
  } finally {
    topicChanged('layout');
  }
}

// Call during a component's setup.
export function useTabLayouts() {
  useTopicRefresh(['layout'], () => { for (const scope of scopes.keys()) void load(scope); });
  return {
    layout: (scope: string): TabLayout => stateFor(scope).layout,
    save
  };
}
