import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch, type Ref } from 'vue';
import {
  buildDiffTree,
  diffTotals,
  filterDiffFiles,
  orderedDiffFiles,
  type DiffFilters,
  type DiffScope,
  type DiffStyle,
  type DiffTotals,
  type WorktreeDiffFile,
  type WorktreeDiffFileContents,
  type WorktreeDiffSummary
} from '../lib/worktreeDiff';

// Agents keep editing while the viewer is open. The service caches each
// summary for a moment, so the sidebar and viewer polls share git work.
const VIEWER_POLL_MS = 5_000;
const SIDEBAR_POLL_MS = 15_000;

// Recently opened and prefetched contents, least recently used first. Keys
// include the base and content version, so changed files are fetched again.
const FILE_CACHE_SIZE = 40;
const fileContents = new Map<string, Promise<WorktreeDiffFileContents>>();

export function loadDiffFile(worktreeId: string, scope: DiffScope, baseCommit: string, file: WorktreeDiffFile): Promise<WorktreeDiffFileContents> {
  const key = `${worktreeId}\0${scope}\0${baseCommit}\0${file.path}\0${file.version}`;
  const cached = fileContents.get(key);
  if (cached) {
    fileContents.delete(key);
    fileContents.set(key, cached);
    return cached;
  }
  const request = window.patterm.call('patterm.diff.file', { worktree_id: worktreeId, path: file.path, scope }) as Promise<WorktreeDiffFileContents>;
  fileContents.set(key, request);
  request.catch(() => { if (fileContents.get(key) === request) fileContents.delete(key); });
  while (fileContents.size > FILE_CACHE_SIZE) fileContents.delete(fileContents.keys().next().value!);
  return request;
}

const FILTERS_KEY = 'patterm.diff.filters';
// Reopening a worktree returns to the file last reviewed in it.
const lastSelection = new Map<string, string>();
const SCOPE_KEY = 'patterm.diff.scope';
const STYLE_KEY = 'patterm.diff.style';

function preference(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch { /* Preferences remain for this page. */ }
}

function storedFilters(): DiffFilters {
  try {
    const value = JSON.parse(preference(FILTERS_KEY) ?? '{}') as Partial<DiffFilters>;
    return { excludeDocs: value.excludeDocs === true, excludeTests: value.excludeTests === true };
  } catch {
    return { excludeDocs: false, excludeTests: false };
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// Calls `poll` on an interval while the document is visible, and at once when
// it becomes visible again.
function useVisiblePolling(poll: () => Promise<void>, interval: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    if (stopped || document.visibilityState !== 'visible') return;
    timer = setTimeout(() => void poll().finally(schedule), interval);
  }
  function visibilityChanged(): void {
    if (document.visibilityState === 'visible') void poll().finally(schedule);
    else schedule();
  }
  onMounted(() => document.addEventListener('visibilitychange', visibilityChanged));
  onBeforeUnmount(() => {
    stopped = true;
    if (timer) clearTimeout(timer);
    document.removeEventListener('visibilitychange', visibilityChanged);
  });
  return { schedule };
}

export function useWorktreeDiffViewer(worktreeId: Readonly<Ref<string>>) {
  const scope = ref<DiffScope>(preference(SCOPE_KEY) === 'uncommitted' ? 'uncommitted' : 'branch');
  const filters = ref<DiffFilters>(storedFilters());
  const diffStyle = ref<DiffStyle>(preference(STYLE_KEY) === 'unified' ? 'unified' : 'split');
  // Replaced on each read, never mutated, so file rows stay unproxied.
  const summary = shallowRef<WorktreeDiffSummary | null>(null);
  const loading = ref(false);
  const error = ref('');
  const selectedPath = ref<string | null>(lastSelection.get(worktreeId.value) ?? null);

  const filtered = computed(() => filterDiffFiles(summary.value?.files ?? [], filters.value));
  const tree = computed(() => buildDiffTree(filtered.value));
  const files = computed(() => orderedDiffFiles(tree.value));
  const totals = computed<DiffTotals>(() => diffTotals(filtered.value));
  const hiddenFiles = computed(() => (summary.value?.files.length ?? 0) - filtered.value.length);
  const selectedFile = computed(() => files.value.find((file) => file.path === selectedPath.value) ?? null);
  const selectedIndex = computed(() => (selectedFile.value ? files.value.indexOf(selectedFile.value) : -1));

  let generation = 0;
  let lastSummary = '';
  async function refresh(): Promise<void> {
    const current = ++generation;
    const requestedScope = scope.value;
    loading.value = summary.value === null || summary.value.scope !== requestedScope;
    try {
      const result = await window.patterm.call('patterm.diff.current', { worktree_id: worktreeId.value, scope: requestedScope }) as WorktreeDiffSummary;
      if (current !== generation) return;
      error.value = '';
      // Most polls find nothing new; keep the same summary so nothing re-renders.
      const serialised = JSON.stringify(result);
      if (serialised === lastSummary) return;
      lastSummary = serialised;
      summary.value = result;
    } catch (cause) {
      if (current === generation) error.value = errorMessage(cause);
    } finally {
      if (current === generation) loading.value = false;
    }
  }

  const polling = useVisiblePolling(refresh, VIEWER_POLL_MS);
  watch(worktreeId, (id) => {
    summary.value = null;
    lastSummary = '';
    selectedPath.value = lastSelection.get(id) ?? null;
  });
  watch(selectedPath, (path) => { if (path) lastSelection.set(worktreeId.value, path); });
  watch([worktreeId, scope], () => void refresh().finally(polling.schedule), { immediate: true });

  // Keep the selection on screen when filters or new changes remove its file.
  watch(files, (list) => {
    if (list.length && !list.some((file) => file.path === selectedPath.value)) selectedPath.value = list[0]!.path;
  });

  // Fetch and highlight the files either side of the selection in the
  // background, so stepping through files shows each one straight away.
  watch([selectedFile, summary], () => {
    const current = summary.value;
    const index = selectedIndex.value;
    if (!current || index < 0) return;
    for (const file of [files.value[index + 1], files.value[index - 1]]) {
      if (!file || file.binary) continue;
      void loadDiffFile(worktreeId.value, current.scope, current.base.commit, file).then((contents) => {
        if (contents.binary || contents.tooLarge) return;
        const id = worktreeId.value;
        // Pierre and Shiki load with the first diff rather than with the app.
        void import('../lib/diffHighlighter').then(({ diffFileContents, primeDiffHighlight }) => primeDiffHighlight(diffFileContents(id, current.base.commit, file, contents)));
      }, () => { /* The file reports its own error when it opens. */ });
    }
  });

  watch(filters, (value) => storePreference(FILTERS_KEY, JSON.stringify(value)), { deep: true });
  watch(scope, (value) => storePreference(SCOPE_KEY, value));
  watch(diffStyle, (value) => storePreference(STYLE_KEY, value));

  function select(path: string): void {
    selectedPath.value = path;
  }

  function step(delta: number): void {
    const list = files.value;
    if (!list.length) return;
    const index = Math.min(list.length - 1, Math.max(0, selectedIndex.value + delta));
    selectedPath.value = list[index]!.path;
  }

  // Reactive so components can pass the whole viewer down and read plain values.
  return reactive({ scope, filters, diffStyle, summary, loading, error, tree, files, totals, hiddenFiles, selectedFile, selectedIndex, select, step, refresh });
}

export type WorktreeDiffViewerState = ReturnType<typeof useWorktreeDiffViewer>;

// Review progress per worktree. A file stops counting as viewed when its
// content changes again.
export function useViewedDiffFiles(worktreeId: Readonly<Ref<string>>) {
  const viewed = ref<Record<string, string>>({});
  const key = () => `patterm.diff.viewed.${worktreeId.value}`;
  watch(worktreeId, () => {
    try {
      const value = JSON.parse(preference(key()) ?? '{}') as unknown;
      viewed.value = value && typeof value === 'object' ? value as Record<string, string> : {};
    } catch {
      viewed.value = {};
    }
  }, { immediate: true });

  function isViewed(file: WorktreeDiffFile): boolean {
    return viewed.value[file.path] === file.version;
  }

  function setViewed(file: WorktreeDiffFile, value: boolean): void {
    const next = { ...viewed.value };
    if (value) next[file.path] = file.version;
    else delete next[file.path];
    viewed.value = next;
    storePreference(key(), JSON.stringify(next));
  }

  return { isViewed, setViewed };
}

export interface WorktreeDiffTotalsState { totals: DiffTotals | null; error: string }

// Branch totals for the session sidebar, unfiltered so they match `git diff`.
export function useWorktreeDiffTotals(worktreeIds: Ref<string[]>) {
  const states = shallowRef(new Map<string, WorktreeDiffTotalsState>());
  let generation = 0;

  async function refresh(): Promise<void> {
    const current = ++generation;
    const ids = [...worktreeIds.value];
    const results = await Promise.all(ids.map(async (id): Promise<[string, WorktreeDiffTotalsState]> => {
      try {
        const result = await window.patterm.call('patterm.diff.current', { worktree_id: id, scope: 'branch' }) as WorktreeDiffSummary;
        return [id, { totals: result.totals, error: '' }];
      } catch (cause) {
        return [id, { totals: null, error: errorMessage(cause) }];
      }
    }));
    if (current === generation) states.value = new Map(results);
  }

  const polling = useVisiblePolling(refresh, SIDEBAR_POLL_MS);
  watch(() => worktreeIds.value.join('\n'), () => void refresh().finally(polling.schedule), { immediate: true });

  return { states, refresh };
}
