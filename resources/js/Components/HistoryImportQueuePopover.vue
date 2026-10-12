<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button variant="ghost" size="icon" class="relative h-8 w-8" aria-label="History import queue" title="History import queue">
        <Loader2 v-if="isActive" class="h-4 w-4 animate-spin" />
        <ListChecks v-else class="h-4 w-4" />
        <span v-if="activeCount > 0" class="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground">{{ activeCount }}</span>
        <span v-else-if="hasFailures" class="absolute right-0 top-0 h-2 w-2 rounded-full bg-destructive" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="end" class="w-96 max-w-[calc(100vw-2rem)] p-0">
      <div class="flex items-center justify-between gap-3 px-4 pb-2 pt-3">
        <h3 class="text-sm font-semibold">History imports</h3>
        <Button type="button" variant="ghost" size="icon" class="h-7 w-7 text-muted-foreground" aria-label="Refresh imports" title="Refresh imports" :disabled="loading" @click="void loadStatus()">
          <RefreshCw :class="['h-3.5 w-3.5', loading ? 'animate-spin' : '']" />
        </Button>
      </div>
      <div class="max-h-[min(32rem,70vh)] overflow-y-auto px-4 pb-4 text-xs">
        <p v-if="error" role="alert" class="mb-3 text-destructive">{{ error }}</p>
        <div class="flex items-start gap-2.5 py-2">
          <Loader2 v-if="liveRefresh" class="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
          <Check v-else class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div class="min-w-0 flex-1">
            <div class="flex items-center justify-between gap-3">
              <p class="font-medium">{{ liveRefresh ? 'Importing conversations…' : 'No imports running' }}</p>
              <span v-if="queue.running" class="shrink-0 tabular-nums text-muted-foreground">{{ formatElapsed(queue.running.elapsedMs) }}</span>
            </div>
            <p class="mt-1 leading-relaxed text-muted-foreground">{{ queue.running ? runningProgressText(queue.running) : summaryLine }}</p>
            <p v-if="queue.queued.length" class="mt-1 text-muted-foreground">{{ queue.queued.length }} waiting</p>
          </div>
        </div>

        <details v-if="problemFiles.length || failedJobs.length" class="mt-3 border-t border-border/60 pt-3">
          <summary class="cursor-pointer text-muted-foreground transition-colors hover:text-foreground"><span v-if="problemFiles.length">{{ problemFiles.length }} {{ plural(problemFiles.length, 'file', 'files') }} to review</span><span v-if="failedJobs.length"><span v-if="problemFiles.length"> · </span>{{ failedJobs.length }} failed {{ plural(failedJobs.length, 'import', 'imports') }}</span></summary>
          <div class="mt-2 divide-y divide-border/50">
            <div v-for="job in failedJobs" :key="job.id" class="py-3">
              <p class="font-medium text-destructive">{{ job.status === 'stale' ? 'Import stopped responding' : 'Import failed' }}</p>
              <p class="mt-1 break-words leading-relaxed text-muted-foreground">{{ job.error || jobDetail(job) }}</p>
            </div>
            <div v-for="file in problemFiles" :key="file.id" class="py-3">
              <div class="flex items-center justify-between gap-2">
                <span class="font-medium">{{ file.provider }}</span>
                <span :class="file.error ? 'text-destructive' : 'text-muted-foreground'">{{ file.status }}</span>
              </div>
              <p class="mt-1 break-words leading-relaxed text-muted-foreground">{{ problemReason(file) }}</p>
              <button type="button" class="mt-1 block max-w-full break-all text-left font-mono text-[11px] text-muted-foreground hover:text-foreground" :title="file.path" @click.stop="toggleExpandedPath(file.path)">{{ displayPath(file.path) }}</button>
              <div class="mt-2 flex gap-1">
                <Button type="button" variant="outline" size="sm" class="h-6 px-2 text-xs" @click="void retryProblemFile(file)">Retry</Button>
                <Button type="button" variant="ghost" size="sm" class="h-6 px-2 text-xs" @click="ignoreProblemFile(file)">Dismiss</Button>
                <Button type="button" variant="ghost" size="sm" class="h-6 px-2 text-xs" @click="void openProblemLocation(file)">{{ browserMode ? 'Copy path' : 'Open location' }}</Button>
              </div>
            </div>
          </div>
        </details>

        <details v-if="visibleBatches.length || jobPath(queue.running)" class="mt-3 border-t border-border/60 pt-3">
          <summary class="cursor-pointer text-muted-foreground transition-colors hover:text-foreground">Import details</summary>
          <p v-if="jobPath(queue.running)" class="mt-3 break-all font-mono text-[11px] text-muted-foreground">{{ jobPath(queue.running) }}</p>
          <div class="mt-1 divide-y divide-border/50">
            <div v-for="batch in visibleBatches" :key="batch.id" class="py-3">
              <div class="flex items-center justify-between gap-2">
                <span class="font-medium">{{ batch.provider || 'All sources' }}</span>
                <span class="text-muted-foreground">{{ batchTime(batch) }}</span>
              </div>
              <p class="mt-1 leading-relaxed text-muted-foreground">{{ batchSummary(batch) }}</p>
            </div>
          </div>
        </details>
      </div>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Check, ListChecks, Loader2, RefreshCw } from 'lucide-vue-next';
import { toast } from 'vue-sonner';
import { APPEARANCE_SETTINGS_CHANGED_EVENT, normalizeAppearanceSettings, type AppearanceSettings } from '../appearance/AppearanceSettings';
import { Button } from './ui/button';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

type QueueJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'stale';
type QueueJobAction = 'import' | 'reset_imports';

interface ImportProgress {
  batchId: string;
  currentFile: string | null;
  filesSeen: number;
  filesImported: number;
  conversationsImported: number;
  messagesImported: number;
  skippedCount: number;
  errorCount: number;
}

interface QueueJob {
  id: string;
  action: QueueJobAction;
  status: QueueJobStatus;
  trigger: string | null;
  provider: string | null;
  path: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  elapsedMs: number | null;
  position: number | null;
  error: string | null;
  progress: ImportProgress | null;
  result: unknown | null;
}

interface QueueSnapshot {
  running: QueueJob | null;
  queued: QueueJob[];
  recent: QueueJob[];
  counts: { queued: number; running: number; recentFailures: number };
}

interface ImportBatch {
  id: string;
  trigger: string;
  provider: string | null;
  sourceId: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  filesSeen: number;
  filesImported: number;
  conversationsImported: number;
  messagesImported: number;
  skippedCount: number;
  errorCount: number;
}

interface ImportFile {
  id: string;
  provider: string;
  path: string;
  sourceKind: string;
  status: string;
  warning: string | null;
  error: string | null;
}

interface ImportStatusResponse {
  batches: ImportBatch[];
  files: ImportFile[];
  queue?: QueueSnapshot;
}


const emit = defineEmits<{ imported: [] }>();

const emptyQueue = (): QueueSnapshot => ({ running: null, queued: [], recent: [], counts: { queued: 0, running: 0, recentFailures: 0 } });

const open = ref(false);
const loading = ref(false);
const error = ref('');
const status = ref<ImportStatusResponse>({ batches: [], files: [], queue: emptyQueue() });
const historyImportToasts = ref(true);
const ignoredProblemFileIds = ref(new Set<string>());
const expandedPaths = ref(new Set<string>());
const notifiedStarted = new Set<string>();
const notifiedFinished = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let requestId = 0;
let notificationsPrimed = false;
const seenBatchIds = new Set<string>();
let batchesPrimed = false;

const queue = computed(() => status.value.queue ?? emptyQueue());
const activeCount = computed(() => queue.value.counts.running + queue.value.counts.queued);
const isActive = computed(() => activeCount.value > 0);
const staleCount = computed(() => status.value.batches.filter((batch) => batch.status === 'stale').length + queue.value.recent.filter((job) => job.status === 'stale').length);
const problemFiles = computed(() => status.value.files.filter((file) => !ignoredProblemFileIds.value.has(file.id)));
const hasFailures = computed(() => queue.value.counts.recentFailures > 0 || staleCount.value > 0 || status.value.batches.some((batch) => batch.errorCount > 0) || problemFiles.value.length > 0);
const liveRefresh = computed(() => isActive.value || status.value.batches.some((batch) => batch.status === 'running'));
const failedJobs = computed(() => queue.value.recent.filter((job) => job.status === 'failed' || job.status === 'stale'));
const visibleBatches = computed(() => status.value.batches.filter((batch) => batch.status !== 'running' && !isEmptyBatch(batch)).slice(0, 5));
const lastSuccessfulBatch = computed(() => status.value.batches.find((batch) => batch.status === 'completed' && batch.finishedAt));
const summaryLine = computed(() => lastSuccessfulBatch.value?.finishedAt
  ? `Last imported ${formatRelativeTime(lastSuccessfulBatch.value.finishedAt)}`
  : 'No completed imports yet');
const browserMode = window.patterm.runtime === 'browser';

onMounted(() => {
  void loadNotificationSettings();
  window.addEventListener(APPEARANCE_SETTINGS_CHANGED_EVENT, handleAppearanceSettingsChanged as EventListener);
  void loadStatus();
});

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
  window.removeEventListener(APPEARANCE_SETTINGS_CHANGED_EVENT, handleAppearanceSettingsChanged as EventListener);
});

watch(open, (isOpen) => {
  if (isOpen) void loadStatus();
  scheduleNextPoll();
});

async function loadStatus(): Promise<void> {
  const current = ++requestId;
  loading.value = true;
  error.value = '';
  try {
    const response = await window.patterm.call('history_import_status', {}) as ImportStatusResponse;
    if (current !== requestId) return;
    const nextStatus = { batches: response.batches ?? [], files: response.files ?? [], queue: response.queue ?? emptyQueue() };
    processQueueNotifications(nextStatus.queue);
    processNewBatches(nextStatus.batches);
    status.value = nextStatus;
  } catch (caught) {
    if (current !== requestId) return;
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    if (current === requestId) {
      loading.value = false;
      scheduleNextPoll();
    }
  }
}

// Tell the parent when a finished import brought in new conversations or messages.
function processNewBatches(batches: ImportBatch[]): void {
  let imported = false;
  for (const batch of batches) {
    if (batch.status === 'running' || seenBatchIds.has(batch.id)) continue;
    seenBatchIds.add(batch.id);
    if (batch.conversationsImported > 0 || batch.messagesImported > 0) imported = true;
  }
  if (imported && batchesPrimed) emit('imported');
  batchesPrimed = true;
}

function scheduleNextPoll(): void {
  if (timer) clearTimeout(timer);
  const delay = liveRefresh.value ? 2_000 : open.value ? 5_000 : 15_000;
  timer = setTimeout(() => void loadStatus(), delay);
}

async function loadNotificationSettings(): Promise<void> {
  try {
    const settings = normalizeAppearanceSettings(await window.patterm.appearanceSettings() as Partial<AppearanceSettings> | null);
    historyImportToasts.value = settings.historyImportToasts;
  } catch {
    historyImportToasts.value = true;
  }
}

function handleAppearanceSettingsChanged(event: CustomEvent<AppearanceSettings>): void {
  historyImportToasts.value = normalizeAppearanceSettings(event.detail).historyImportToasts;
}

function processQueueNotifications(nextQueue: QueueSnapshot): void {
  if (!notificationsPrimed || !historyImportToasts.value) {
    seedNotificationIds(nextQueue);
    notificationsPrimed = true;
    return;
  }

  for (const job of [...nextQueue.recent].reverse()) {
    if (notifiedFinished.has(job.id)) continue;
    notifiedFinished.add(job.id);
    notifiedStarted.add(job.id);
    if (job.status === 'failed') {
      toast.error('History import failed', { description: job.error ?? jobDetail(job) });
    } else if (job.status === 'stale') {
      toast.error('History import became stale', { description: job.error ?? jobDetail(job) });
    }
  }
}

function seedNotificationIds(nextQueue: QueueSnapshot): void {
  if (nextQueue.running) notifiedStarted.add(nextQueue.running.id);
  for (const job of nextQueue.recent) {
    notifiedFinished.add(job.id);
    notifiedStarted.add(job.id);
  }
}

function jobDetail(job: QueueJob): string {
  return [job.provider, job.trigger, job.path].filter(Boolean).join(' · ') || job.id;
}

function jobPath(job: QueueJob | null): string | null {
  return job?.progress?.currentFile ?? job?.path ?? null;
}

function runningProgressText(job: QueueJob): string {
  const progress = job.progress;
  if (!progress) return 'Starting…';
  return `${progress.conversationsImported.toLocaleString()} conversations · ${progress.filesSeen.toLocaleString()} files checked`;
}

function formatElapsed(value: number | null): string {
  if (value === null) return 'pending';
  const seconds = Math.max(0, Math.floor(value / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatRelativeTime(value: string | null): string {
  if (!value) return 'unknown';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return 'unknown';
  const elapsed = Date.now() - parsed;
  if (elapsed < 5_000) return 'just now';
  return `${formatElapsed(elapsed)} ago`;
}

function plural(count: number, singular: string, pluralValue: string): string {
  return count === 1 ? singular : pluralValue;
}

function isEmptyBatch(batch: ImportBatch): boolean {
  return batch.status === 'completed' && batch.conversationsImported === 0 && batch.messagesImported === 0 && batch.errorCount === 0;
}

function batchSummary(batch: ImportBatch): string {
  if (batch.status === 'stale') return `No heartbeat for ${formatElapsed(batchElapsedMs(batch))}`;
  return [
    `${batch.conversationsImported.toLocaleString()} conversations`,
    batch.skippedCount ? `${batch.skippedCount} skipped` : null,
    batch.errorCount ? `${batch.errorCount} errors` : null,
    batch.status === 'failed' ? 'Failed' : null
  ].filter(Boolean).join(' · ');
}

function batchTime(batch: ImportBatch): string {
  if (batch.finishedAt) return formatRelativeTime(batch.finishedAt);
  return formatElapsed(batchElapsedMs(batch));
}

function batchElapsedMs(batch: ImportBatch): number {
  const start = Date.parse(batch.startedAt);
  if (!Number.isFinite(start)) return 0;
  const end = batch.finishedAt ? Date.parse(batch.finishedAt) : Date.now();
  return Math.max(0, (Number.isFinite(end) ? end : Date.now()) - start);
}

function problemReason(file: ImportFile): string {
  if (file.error) return firstLine(file.error);
  if (file.warning) return firstLine(file.warning);
  if (file.status === 'skipped') return 'Skipped: no new/importable conversations, or unchanged since last import.';
  return 'Import did not provide a detailed reason.';
}

function firstLine(value: string): string {
  return value.split('\n')[0]?.trim() || 'No detail provided.';
}

function displayPath(path: string): string {
  return expandedPaths.value.has(path) ? path : middleTruncatePath(path, 64);
}

function middleTruncatePath(path: string, maxLength: number): string {
  if (path.length <= maxLength) return path;
  const head = Math.max(10, Math.floor((maxLength - 3) / 3));
  const tail = maxLength - head - 3;
  return `${path.slice(0, head)}...${path.slice(-tail)}`;
}

function toggleExpandedPath(path: string): void {
  const next = new Set(expandedPaths.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  expandedPaths.value = next;
}

async function retryProblemFile(file: ImportFile): Promise<void> {
  try {
    await window.patterm.call('history_import', { provider: file.provider, path: file.path, trigger: 'manual' });
    void loadStatus();
  } catch (caught) {
    toast.error('Could not queue retry', { description: caught instanceof Error ? caught.message : String(caught) });
  }
}

function ignoreProblemFile(file: ImportFile): void {
  const next = new Set(ignoredProblemFileIds.value);
  next.add(file.id);
  ignoredProblemFileIds.value = next;
}

async function openProblemLocation(file: ImportFile): Promise<void> {
  if (browserMode) {
    await window.patterm.writeClipboardText(file.path);
    return;
  }
  try {
    await window.patterm.showItemInFolder(file.path);
  } catch (caught) {
    await window.patterm.writeClipboardText(file.path);
    toast.error('Could not open location', { description: `Path copied instead: ${caught instanceof Error ? caught.message : String(caught)}` });
  }
}
</script>
