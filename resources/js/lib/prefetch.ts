import { onScopeDispose, watch } from 'vue';
import { useWorkbench } from '../Composables/useWorkbench';
import type { ProjectWorkbench, SessionRecord } from '../types';
import { hasCachedConversation, normaliseConversation, rememberConversation } from './integratedConversation';
import { contextRead, projectContextVersion } from './projectContext';

// Reads what the user is likely to open next into the client caches, within
// what the connection allows. Background reads only fill caches: they never
// subscribe to a terminal, take control, or change any server state.

// --- How much the connection allows -------------------------------------

export type PrefetchPreference = 'auto' | 'always' | 'never';
export type LinkClass = 'fast' | 'cellular' | 'slow';

const PREFERENCE_KEY = 'patterm.prefetch.conversations';

// Whether conversations prefetch on this device. Context always prefetches,
// because it is small.
export function prefetchPreference(): PrefetchPreference {
  try {
    const value = localStorage.getItem(PREFERENCE_KEY);
    return value === 'always' || value === 'never' ? value : 'auto';
  } catch {
    return 'auto';
  }
}

export function setPrefetchPreference(value: PrefetchPreference): void {
  try { localStorage.setItem(PREFERENCE_KEY, value); } catch { /* Applies to this page only. */ }
}

interface NetworkInformation { effectiveType?: string; saveData?: boolean; type?: string; rtt?: number }

// Time to first byte of recent calls to the server, the lowest of which is
// close to the round trip. Only Chromium reports navigator.connection, and
// only Android its type, so this is measured for every browser.
const roundTrips: number[] = [];
let observing = false;
function recordRoundTrips(entries: PerformanceEntryList): void {
  for (const entry of entries as PerformanceResourceTiming[]) {
    if (!entry.name.includes('/api/rpc') || !entry.responseStart || !entry.requestStart) continue;
    roundTrips.push(entry.responseStart - entry.requestStart);
    if (roundTrips.length > 20) roundTrips.shift();
  }
}

// Reads the calls made so far at once, so the first decision after load
// already has them, then follows new ones.
function observeRoundTrips(): void {
  if (observing || typeof PerformanceObserver === 'undefined') return;
  observing = true;
  try {
    recordRoundTrips(performance.getEntriesByType('resource'));
    new PerformanceObserver((list) => recordRoundTrips(list.getEntries())).observe({ type: 'resource' });
  } catch { /* Fall back to what navigator.connection reports. */ }
}

export function measuredRoundTrip(): number | null {
  observeRoundTrips();
  return roundTrips.length >= 3 ? Math.min(...roundTrips) : null;
}

// fast: the desktop app, or a link under ~100 ms that isn't cellular or saving
// data. slow: data saver, 2G, or over ~300 ms. cellular: the rest, and touch
// devices that report nothing, such as every iPhone browser.
export function linkClass(): LinkClass {
  if (window.patterm?.runtime === 'desktop') return 'fast';
  const connection = (navigator as Navigator & { connection?: NetworkInformation }).connection;
  const roundTrip = measuredRoundTrip() ?? connection?.rtt ?? null;
  if (connection?.saveData || connection?.effectiveType === '2g' || connection?.effectiveType === 'slow-2g') return 'slow';
  if (roundTrip !== null && roundTrip > 300) return 'slow';
  if (connection?.type === 'cellular') return 'cellular';
  const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  if (connection?.type === 'wifi' || connection?.type === 'ethernet') return roundTrip !== null && roundTrip > 100 ? 'cellular' : 'fast';
  if (touch) return 'cellular';
  return roundTrip !== null && roundTrip > 100 ? 'cellular' : 'fast';
}

// --- The queue -----------------------------------------------------------

// Lower runs first: what the pointer is on, then the open project, then other
// projects, then conversations in the background.
export const Tier = { Intent: 0, Current: 1, Other: 2, Transcript: 3 } as const;
export type Tier = typeof Tier[keyof typeof Tier];

// `eligible` is checked again just before a task reads, so a queued task
// whose session ended, or that the connection or preference no longer allows,
// is dropped without reading.
interface Task { key: string; tier: Tier; notBefore: number; eligible: () => boolean; run: () => Promise<void> }

const MAX_RUNNING = 2;
const queue = new Map<string, Task>();
const running = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

function enqueue(task: Task): void {
  if (running.has(task.key)) return;
  const queued = queue.get(task.key);
  if (queued && queued.tier <= task.tier && queued.notBefore <= task.notBefore) return;
  queue.set(task.key, task);
  schedule(0);
}

// Drops queued tasks that are no longer eligible, such as those for agents
// that ended while the tab was hidden.
function prune(): void {
  for (const [key, task] of queue) if (!task.eligible()) queue.delete(key);
}

function schedule(delay: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; pump(); }, delay);
}

function pump(): void {
  // A hidden tab reads nothing; the queue resumes when it is shown.
  if (document.visibilityState !== 'visible') return;
  const now = Date.now();
  while (running.size < MAX_RUNNING) {
    let next: Task | undefined;
    let wake = Infinity;
    for (const task of queue.values()) {
      if (task.notBefore > now) { wake = Math.min(wake, task.notBefore); continue; }
      if (!next || task.tier < next.tier) next = task;
    }
    if (!next) {
      if (wake !== Infinity) schedule(wake - now);
      return;
    }
    const task = next;
    queue.delete(task.key);
    if (!task.eligible()) continue;
    running.add(task.key);
    void task.run().catch(() => { /* A view reads it again when opened. */ }).finally(() => {
      running.delete(task.key);
      schedule(0);
    });
  }
}

// --- What to read --------------------------------------------------------

// Bytes of conversations read in the background, per window, by link class.
// Context reads are small and not counted.
const TRANSCRIPT_WINDOW_MS = 10 * 60_000;
const TRANSCRIPT_BUDGET: Record<LinkClass, number> = { fast: 16_000_000, cellular: 2_000_000, slow: 0 };
const transcriptReads: Array<{ at: number; bytes: number; processId: string }> = [];

function transcriptBytes(now: number): number {
  while (transcriptReads.length && transcriptReads[0]!.at < now - TRANSCRIPT_WINDOW_MS) transcriptReads.shift();
  return transcriptReads.reduce((total, read) => total + read.bytes, 0);
}

// Whether a conversation may be read ahead. On cellular each conversation is
// read at most once per window, and only for the open project unless the
// pointer is on it.
function transcriptAllowed(processId: string, inCurrentProject: boolean, tier: Tier): boolean {
  const preference = prefetchPreference();
  if (preference === 'never') return false;
  const link = preference === 'always' ? 'fast' : linkClass();
  if (link === 'slow') return false;
  const now = Date.now();
  if (transcriptBytes(now) >= TRANSCRIPT_BUDGET[link]) return false;
  if (link === 'cellular') {
    if (!inCurrentProject && tier !== Tier.Intent) return false;
    if (transcriptReads.some((read) => read.processId === processId)) return false;
  }
  return true;
}

// Reads an Integrated conversation into the cache its pane paints from. The
// pane still takes its own snapshot when opened; this only lets it show
// something at once. Conversations the user has opened are never evicted.
// A read in flight counts against the budget at this size until its real
// size is known, so reads started together can't overshoot it.
const TRANSCRIPT_ESTIMATE_BYTES = 100_000;

async function readTranscript(processId: string): Promise<void> {
  if (hasCachedConversation(processId)) return;
  const read = { at: Date.now(), bytes: TRANSCRIPT_ESTIMATE_BYTES, processId };
  transcriptReads.push(read);
  let result: Record<string, unknown>;
  try {
    result = await window.patterm.call('integrated_get', { process_id: processId, transcript_only: true }) as Record<string, unknown>;
  } catch (error) {
    transcriptReads.splice(transcriptReads.indexOf(read), 1);
    throw error;
  }
  read.bytes = JSON.stringify(result).length;
  if (hasCachedConversation(processId)) return;
  const cursor = result.history_cursor as Record<string, unknown> | null | undefined;
  rememberConversation(processId, {
    ...normaliseConversation(result),
    controls: { selectors: [], commands: [] },
    provider: typeof result.provider === 'string' ? result.provider : null,
    streaming: result.streaming === true,
    historyTruncated: result.history_truncated === true,
    historyUnavailable: result.history_unavailable === true,
    historyCursor: result.history_truncated === true && typeof cursor?.next === 'string' ? cursor.next : null,
    historyLoaded: false
  }, { evict: false });
}

// At most this many sessions per project are read in the background.
const SESSIONS_PER_PROJECT = 12;

function runningSessions(project: ProjectWorkbench): SessionRecord[] {
  return project.projectSessions.filter((session) => !session.exitedAt && session.processId).slice(-SESSIONS_PER_PROJECT);
}

// Whether a session is still running. The cap above bounds project sweeps,
// not a tab the pointer is on.
function stillRunning(projectId: string, sessionId: string): boolean {
  const project = useWorkbench().projects.value.find((item) => item.project.id === projectId);
  return Boolean(project?.projectSessions.some((session) => session.id === sessionId && !session.exitedAt && session.processId));
}

// Reads one session's context panel, and its conversation if allowed. The
// context read uses the panel's own arguments, so the panel finds it cached.
export function prefetchSession(projectId: string, session: SessionRecord, tier: Tier, delay = 0): void {
  const notBefore = Date.now() + delay;
  const live = () => stillRunning(projectId, session.id);
  enqueue({ key: `context\0${projectId}\0${session.id}`, tier, notBefore, eligible: live, run: () => contextRead('session_context', projectId, { session_id: session.id, limit: 100 }).then(() => undefined) });
  const processId = session.processId;
  // A paired host's agent, as in `workstation:process_7`, is never read ahead:
  // an older host would treat transcript_only as an ordinary read, which can
  // change the agent's activity or deliver its held prompts.
  if (session.interfaceMode !== 'integrated' || !processId || processId.includes(':')) return;
  const allowed = () => transcriptAllowed(processId, projectId === prefetchState.activeProjectId, tier);
  if (allowed()) {
    enqueue({ key: `transcript\0${processId}`, tier: tier === Tier.Intent ? Tier.Intent : Tier.Transcript, notBefore, eligible: () => live() && allowed(), run: () => readTranscript(processId) });
  }
}

// A tab the pointer is on. A tab still under the pointer after a project
// switch belongs to the project that lists it, not the one now open.
export function prefetchTab(session: SessionRecord): void {
  const project = useWorkbench().projects.value.find((item) => item.projectSessions.some((candidate) => candidate.id === session.id));
  if (project) prefetchSession(project.project.id, session, Tier.Intent);
}

export function prefetchProject(projectId: string, tier: Tier, delay = 0): void {
  const project = useWorkbench().projects.value.find((item) => item.project.id === projectId);
  // A slow link reads only the open project ahead, unless set to Always.
  if (!project) return;
  if (linkClass() === 'slow' && prefetchPreference() !== 'always' && tier !== Tier.Intent && projectId !== prefetchState.activeProjectId) return;
  for (const session of runningSessions(project)) prefetchSession(projectId, session, tier, delay);
}

// --- When to read --------------------------------------------------------

const prefetchState = { activeProjectId: null as string | null };
// Other projects wait a moment after a change, so a burst of writes there
// reads once.
const OTHER_PROJECT_DELAY_MS = 3_000;
const SETTLE_MS = 1_000;

// Reads ahead once the page is idle, and again whenever a project's context
// or its running agents change. Call once per page.
export function startPrefetch(activeProjectId: () => string | null): void {
  const { projects, lifecycleRevision, loaded } = useWorkbench();
  observeRoundTrips();
  const idle = (callback: () => void) => {
    const request = (window as Window & { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
    if (request) request(callback, { timeout: 2_000 });
    else setTimeout(callback, 500);
  };
  // Nothing reads ahead until the page has loaded and settled, so it never
  // competes with the first view.
  let settled = false, disposed = false;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  const plan = () => settled && !disposed && idle(() => {
    if (disposed) return;
    prune();
    const active = prefetchState.activeProjectId;
    for (const project of projects.value) {
      const id = project.project.id;
      if (id === active) prefetchProject(id, Tier.Current);
      else prefetchProject(id, Tier.Other, OTHER_PROJECT_DELAY_MS);
    }
  });
  watch(activeProjectId, (id) => { prefetchState.activeProjectId = id; plan(); }, { immediate: true });
  const settle = () => { settleTimer = setTimeout(() => { settled = true; plan(); }, SETTLE_MS); };
  if (loaded.value) settle();
  else { const stop = watch(loaded, (value) => { if (value) { stop(); settle(); } }); }
  watch(lifecycleRevision, plan);
  // A change to one project reads that project again; its cached reads are
  // keyed by the old version.
  let versions = new Map<string, string | null>();
  watch(() => projects.value.map((project) => [project.project.id, projectContextVersion(project.project.id)] as const), (next) => {
    const previous = versions;
    versions = new Map(next);
    for (const [id, version] of next) {
      if (!previous.has(id) || previous.get(id) === version) continue;
      if (id === prefetchState.activeProjectId) prefetchProject(id, Tier.Current);
      else prefetchProject(id, Tier.Other, OTHER_PROJECT_DELAY_MS);
    }
  }, { immediate: true });
  const resume = () => { if (document.visibilityState === 'visible') schedule(0); };
  document.addEventListener('visibilitychange', resume);
  onScopeDispose(() => {
    disposed = true;
    document.removeEventListener('visibilitychange', resume);
    if (settleTimer) clearTimeout(settleTimer);
    queue.clear();
  });
}
