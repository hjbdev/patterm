import { computed, ref, shallowRef } from 'vue';
import type {
  HarnessInstallationRecord,
  ProcessRecord,
  ProjectWorkbench,
  SessionRecord,
  SidebarState,
} from '../types';
import { applyWorkbenchChanges, changesLifecycle, type WorkbenchPatch, type WorkbenchSnapshot } from '../lib/workbenchPatch';

interface WorkbenchVersion {
  epoch: string;
  version: number;
}

type HeldWorkbench = WorkbenchSnapshot & WorkbenchVersion;

// A full snapshot, the patches missed since the version sent, or confirmation
// that the client is current.
type WorkbenchRead = HeldWorkbench | (WorkbenchVersion & { patches: WorkbenchPatch[] }) | (WorkbenchVersion & { current: true });

// Version checks on window focus catch a connection that dropped silently.
const FOCUS_CHECK_INTERVAL_MS = 30_000;

const projects = ref<ProjectWorkbench[]>([]);
const harnesses = ref<HarnessInstallationRecord[]>([]);
const sidebarState = ref<SidebarState>({
  projects: [],
  sections: [],
  knownProjects: [],
  knownSections: [],
});
const loaded = ref(false);
// Counts applied workbench changes, for views that derive other server data
// from the workbench.
const revision = ref(0);
// Counts changes that start, stop, add, or remove sessions and processes.
// Activity and title updates leave it alone.
const lifecycleRevision = ref(0);

// The snapshot lists sessions and processes that ended in the last day.
// Older ones are read when a view opens one, and are not patched.
const archivedSessions = shallowRef(new Map<string, SessionRecord>());
const archivedProcesses = shallowRef(new Map<string, ProcessRecord>());
const archiveReads = new Set<string>();

// Each snapshot and patch carries the server's terminal state, so a client
// that loaded or reconnected while the server restarted still corrects it.
// Assumed online until the first snapshot, so loading does not flash a warning.
const sidecarAvailable = ref(true);
// The snapshot behind the refs above, as plain objects. Patches apply to it.
let held: HeldWorkbench | null = null;
let refreshInFlight: Promise<void> | null = null;
let refreshPending = false;

// Brings the workbench up to date: the server answers with what this client
// lacks, usually nothing or a few small patches. Shared at module scope so
// every consumer of useWorkbench() sees the same live data.
async function refresh(): Promise<void> {
  refreshPending = true;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    do {
      refreshPending = false;
      await refreshOnce();
    } while (refreshPending);
  })().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

// Starts on first use, not at import: the bundler may evaluate this module
// before browser.ts installs window.patterm.
let started = false;
function start(): void {
  if (started) return;
  started = true;
  void refresh();
  // Live updates arrive as versioned patches. A missed patch, a reconnect, or
  // a server restart falls back to a refresh.
  window.patterm?.onWorkbenchPatch?.((patch) => {
    applyPatch(patch as WorkbenchPatch);
  });
  // The first connection can open after the first read; only a later one
  // may have missed patches.
  let connection = window.patterm?.connectionState?.() ?? 'connected';
  let wasConnected = connection === 'connected';
  window.patterm?.onConnectionChanged?.((state) => {
    const reconnected = state === 'connected' && connection !== 'connected' && wasConnected;
    connection = state;
    if (state === 'connected') wasConnected = true;
    if (reconnected) void refresh();
  });
  let lastFocusCheck = Date.now();
  window.addEventListener('focus', () => {
    if (Date.now() - lastFocusCheck < FOCUS_CHECK_INTERVAL_MS) return;
    lastFocusCheck = Date.now();
    void refresh();
  });
}

export function useWorkbench() {
  start();
  const sidecarStatus = computed(() => (sidecarAvailable.value ? 'terminal core online' : 'terminal core not started'));

  const updateSidebarState = async (state: SidebarState): Promise<void> => {
    const saved = (await window.patterm?.sidebarStateUpdate?.(state)) as SidebarState | null | undefined;
    sidebarState.value = normalizeSidebarState(saved ?? state);
  };

  return { projects, harnesses, sidecarStatus, sidecarAvailable, sidebarState, updateSidebarState, loaded, refresh, revision, lifecycleRevision, archivedSessions, archivedProcesses, loadArchived };
}

// Reads one session or process the snapshot no longer lists. Each is read
// once per page, found or not.
async function loadArchived(projectId: string, record: { sessionId?: string; processId?: string }): Promise<void> {
  const key = `${projectId}\0${record.sessionId ?? ''}\0${record.processId ?? ''}`;
  if (archiveReads.has(key) || !window.patterm?.workbenchRecord) return;
  archiveReads.add(key);
  try {
    const result = await window.patterm.workbenchRecord({
      project_id: projectId,
      ...(record.sessionId ? { session_id: record.sessionId } : {}),
      ...(record.processId ? { process_id: record.processId } : {})
    }) as { session?: SessionRecord | null; process?: ProcessRecord | null } | null;
    if (result?.session) archivedSessions.value = new Map(archivedSessions.value).set(result.session.id, result.session);
    if (result?.process) archivedProcesses.value = new Map(archivedProcesses.value).set(result.process.id, result.process);
  } catch {
    archiveReads.delete(key);
  }
}

async function refreshOnce(): Promise<void> {
  try {
    const since = held ? { epoch: held.epoch, version: held.version } : undefined;
    const result = await window.patterm?.workbench?.(since) as WorkbenchRead | null | undefined;
    if (!result) return;
    if ('projects' in result) adopt(result);
    else if ('patches' in result) for (const patch of result.patches) applyPatch(patch);
  } catch {
    // The next change, reconnect, or focus check retries.
  } finally {
    loaded.value = true;
  }
}

function adopt(snapshot: HeldWorkbench): void {
  if (held && held.epoch === snapshot.epoch && snapshot.version < held.version) return;
  held = { ...snapshot, sidebarState: normalizeSidebarState(snapshot.sidebarState) };
  publish(true);
  sidebarState.value = held.sidebarState;
}

function applyPatch(patch: WorkbenchPatch): void {
  if (!held || patch.epoch !== held.epoch || patch.from > held.version) {
    void refresh();
    return;
  }
  if (patch.to <= held.version) return;
  const lifecycle = changesLifecycle(held, patch.changes);
  held = { ...applyWorkbenchChanges(held, patch.changes), epoch: patch.epoch, version: patch.to };
  publish(lifecycle);
  if (patch.changes.sidebarState) sidebarState.value = normalizeSidebarState(held.sidebarState);
}

function publish(lifecycle: boolean): void {
  if (!held) return;
  projects.value = held.projects;
  harnesses.value = held.harnesses;
  sidecarAvailable.value = held.terminalAvailable;
  revision.value += 1;
  if (lifecycle) lifecycleRevision.value += 1;
}

function normalizeSidebarState(state: Partial<SidebarState> | null | undefined): SidebarState {
  return {
    projects: stringArray(state?.projects),
    sections: stringArray(state?.sections),
    knownProjects: stringArray(state?.knownProjects),
    knownSections: stringArray(state?.knownSections),
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
