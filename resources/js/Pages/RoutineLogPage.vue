<template>
  <div class="flex h-dvh min-h-0 flex-col overflow-hidden bg-[#080808] text-foreground">
    <header class="flex h-11 shrink-0 items-center gap-3 px-3">
      <Button variant="ghost" size="icon" class="h-8 w-8 rounded-tab text-muted-foreground" aria-label="Back to Scheduled" as-child>
        <RouterLink :to="{ name: 'routines' }"><ArrowLeft class="h-4 w-4" /></RouterLink>
      </Button>
      <div class="min-w-0 flex-1">
        <h1 class="text-sm font-semibold">Reports</h1>
        <p class="truncate text-[11px] text-muted-foreground">What routine runs reported.</p>
      </div>
    </header>

    <main class="mx-1.5 mb-1.5 min-h-0 flex-1 overflow-hidden rounded-xl border-t border-white/5 bg-background">
      <div class="h-full overflow-y-auto">
        <div class="mx-auto w-full max-w-[44rem] px-3 pb-10 pt-4 sm:px-4">
          <p v-if="error" role="alert" class="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{{ error }}</p>

          <div v-if="filters.length > 2" class="mb-4 flex flex-wrap gap-1" role="radiogroup" aria-label="Routine">
            <button
              v-for="option in filters"
              :key="option.id"
              type="button"
              role="radio"
              :aria-checked="filter === option.id"
              class="h-6 rounded-full px-2.5 text-xs transition-colors"
              :class="filter === option.id ? 'bg-white/[0.09] text-foreground' : 'text-muted-foreground hover:text-foreground'"
              @click="setFilter(option.id)"
            >{{ option.label }}</button>
          </div>

          <div v-if="!loaded" class="space-y-3" aria-busy="true">
            <div v-for="index in 3" :key="index" class="h-16 animate-pulse rounded-lg bg-card/60" />
          </div>
          <p v-else-if="!runs.length" class="py-16 text-center text-xs text-muted-foreground">No reports yet. Each run's report appears here.</p>
          <template v-else>
            <RoutineLog :runs="runs" :routines="routines" :now="now" @open="openRun" />
            <Button v-if="hasMore" variant="ghost" size="sm" class="-ml-2 mt-2 h-7 px-2 text-xs text-muted-foreground" :disabled="loadingMore" @click="loadMore">Show more</Button>
          </template>
        </div>
      </div>
    </main>

    <RoutineReportDialog :run="reportRun" :title="routineName(reportRun?.routine_id)" :now="now" @close="reportRun = null" @open-conversation="openConversation" />
    <RoutineRunDialog :process-id="runProcessId" :title="runTitle" @close="runProcessId = null" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { ArrowLeft } from 'lucide-vue-next';
import RoutineLog from '../Components/routines/RoutineLog.vue';
import RoutineReportDialog from '../Components/routines/RoutineReportDialog.vue';
import RoutineRunDialog from '../Components/routines/RoutineRunDialog.vue';
import { Button } from '../Components/ui/button';
import { useRoutineRunViewer } from '../Composables/useRoutineRunViewer';
import { useTopicRefresh } from '../lib/serverQuery';
import { listRoutines, routineLog, type RoutineRecord, type RoutineRunRecord } from '../lib/routines';

const PAGE = 30;
const routines = ref<RoutineRecord[]>([]);
const runs = ref<RoutineRunRecord[]>([]);
const filter = ref('all');
const loaded = ref(false);
const loadingMore = ref(false);
const hasMore = ref(false);
const error = ref('');
const now = ref(Date.now());
const clock = setInterval(() => { now.value = Date.now(); }, 30_000);
onBeforeUnmount(() => clearInterval(clock));

// One-offs run once each, so only repeating routines get a filter.
const filters = computed(() => [{ id: 'all', label: 'All' }, ...routines.value.filter((routine) => !routine.run_at).map((routine) => ({ id: routine.routine_id, label: routine.name }))]);

function routineName(routineId: string | undefined): string {
  return routines.value.find((entry) => entry.routine_id === routineId)?.name ?? 'Routine run';
}

const { reportRun, runProcessId, runTitle, openRun, openConversation, refreshReport } = useRoutineRunViewer(routineName);

function page(offset: number, limit = PAGE): Promise<RoutineRunRecord[]> {
  return routineLog({ limit, offset, ...(filter.value === 'all' ? {} : { routine_id: filter.value }) });
}

// Replies for an earlier filter are dropped.
let generation = 0;

// Reloads everything shown so far, 100 at a time (the server's page limit),
// so a new report appears without losing the older pages already loaded.
async function refresh(): Promise<void> {
  const token = ++generation;
  try {
    const wanted = Math.max(PAGE, runs.value.length);
    const [list, latest] = await Promise.all([listRoutines(), loadRange(wanted), refreshReport()]);
    if (token !== generation) return;
    routines.value = list;
    runs.value = latest;
    hasMore.value = latest.length >= wanted;
    error.value = '';
  } catch (cause) {
    if (token === generation) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (token === generation) loaded.value = true;
  }
}

async function loadRange(count: number): Promise<RoutineRunRecord[]> {
  const result: RoutineRunRecord[] = [];
  while (result.length < count) {
    const size = Math.min(100, count - result.length);
    const batch = await page(result.length, size);
    result.push(...batch);
    if (batch.length < size) break;
  }
  return result;
}

async function loadMore(): Promise<void> {
  loadingMore.value = true;
  const token = generation;
  try {
    const older = await page(runs.value.length);
    if (token !== generation) return;
    const seen = new Set(runs.value.map((run) => run.run_id));
    runs.value = [...runs.value, ...older.filter((run) => !seen.has(run.run_id))];
    hasMore.value = older.length === PAGE;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loadingMore.value = false;
  }
}

function setFilter(id: string): void {
  if (filter.value === id) return;
  filter.value = id;
  runs.value = [];
  loaded.value = false;
  void refresh();
}

useTopicRefresh(['routines'], () => void refresh(), { lifecycle: true });
void refresh();
</script>
