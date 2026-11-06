import { reactive } from 'vue';
import { toast } from 'vue-sonner';
import { EMPTY_TAB_LAYOUT, readLegacyTabLayout, type TabLayout } from '../lib/tabStrip';
import { topicChanged, topicRead, useTopicRefresh } from '../lib/serverQuery';

// Each scope's tab layout as the server has it, shared by every view. An edit
// is a change to the layout, not a new copy: it shows at once, on top of the
// last saved layout, and saves in turn, one at a time. Saved against a layout
// another window has changed since, it is applied again to theirs, so neither
// window's change is lost.
export type TabLayoutEdit = (layout: TabLayout) => TabLayout;
interface Saved extends TabLayout { revision: number }
interface ScopeState {
  // What views show: the edits still to save, on top of the saved layout.
  layout: TabLayout;
  // The newest layout the server has given, or null until the first read.
  saved: Saved | null;
  // Until the first read, the layout this device had before.
  placeholder: TabLayout;
  edits: TabLayoutEdit[];
  loading: boolean;
  writing: boolean;
}

// Each state is reactive; the map isn't, so a view reading a scope for the
// first time doesn't change state it depends on.
const scopes = new Map<string, ScopeState>();

function stateFor(scope: string): ScopeState {
  let state = scopes.get(scope);
  if (!state) {
    const placeholder = readLegacyTabLayout(scope) ?? EMPTY_TAB_LAYOUT;
    state = reactive<ScopeState>({ layout: placeholder, saved: null, placeholder, edits: [], loading: false, writing: false });
    scopes.set(scope, state);
    void load(scope);
  }
  return state;
}

const body = ({ order, folders, filed }: TabLayout): TabLayout => ({ order, folders, filed });
// A plain copy: Electron's IPC can't clone Vue's reactive proxies.
const plain = (layout: TabLayout): TabLayout => JSON.parse(JSON.stringify(body(layout))) as TabLayout;

function show(state: ScopeState): void {
  state.layout = state.edits.reduce((layout, edit) => edit(layout), state.saved ? body(state.saved) : state.placeholder);
}

// Revisions only grow, so a read that answers late can't undo a newer one.
function adopt(state: ScopeState, saved: Saved): void {
  if (state.saved && saved.revision < state.saved.revision) return;
  state.saved = saved;
  show(state);
}

async function fetchSaved(scope: string, fresh = false): Promise<Saved> {
  const read = async () => await window.patterm.call('settings_tab_layout_get', { scope }) as Saved;
  return fresh ? await read() : await topicRead('layout', ['settings_tab_layout_get', scope], read);
}

// Before the first read, edits wait for it; if it fails, they can't save, so
// they are dropped with an error and the next edit tries reading again.
async function load(scope: string): Promise<void> {
  const state = scopes.get(scope);
  if (!state || state.loading) return;
  state.loading = true;
  let saved: Saved;
  try { saved = await fetchSaved(scope); }
  catch {
    if (!state.saved && state.edits.length) {
      state.edits = [];
      show(state);
      toast.error('Could not load the tab layout, so the change was not saved');
    }
    return;
  } finally {
    state.loading = false;
  }
  // Nothing saved yet: this device's old layout becomes everyone's, unless
  // another window saved one first.
  if (!state.saved && saved.revision === 0) {
    const legacy = readLegacyTabLayout(scope);
    if (legacy) state.edits.unshift((layout) => layout.order.length || layout.folders.length ? layout : legacy);
  }
  adopt(state, saved);
  void write(scope);
}

// Saves the edits in order. One refused because the layout changed elsewhere
// is applied again to the newer layout, once; any other failure drops it.
async function write(scope: string): Promise<void> {
  const state = scopes.get(scope);
  if (!state || state.writing || !state.saved || !state.edits.length) return;
  state.writing = true;
  try {
    while (state.edits.length && state.saved) {
      const edit = state.edits[0]!;
      for (let attempt = 0; ; attempt += 1) {
        const base = state.saved;
        try {
          adopt(state, await window.patterm.call('settings_tab_layout_save', { scope, base_revision: base.revision, ...plain(edit(body(base))) }) as Saved);
          break;
        } catch (caught) {
          const conflict = caught instanceof Error && caught.message.includes('changed elsewhere');
          if (conflict && attempt === 0) {
            try { adopt(state, await fetchSaved(scope, true)); continue; }
            catch { /* Reported below. */ }
          }
          toast.error(caught instanceof Error ? caught.message : 'Could not save the tab layout');
          break;
        }
      }
      state.edits.shift();
      show(state);
    }
  } finally {
    state.writing = false;
    topicChanged('layout');
  }
}

function save(scope: string, edit: TabLayoutEdit): void {
  const state = stateFor(scope);
  state.edits.push(edit);
  show(state);
  if (state.saved) void write(scope);
  else void load(scope);
}

// Call during a component's setup.
export function useTabLayouts() {
  useTopicRefresh(['layout'], () => { for (const scope of scopes.keys()) void load(scope); });
  return {
    layout: (scope: string): TabLayout => stateFor(scope).layout,
    save
  };
}
