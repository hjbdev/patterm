<template>
  <div class="flex h-dvh min-h-0 flex-col overflow-hidden bg-[#080808] text-foreground">
    <header class="flex h-11 shrink-0 items-center gap-3 px-3">
      <Button variant="ghost" size="icon" class="h-8 w-8 rounded-tab text-muted-foreground" aria-label="Back" @click="goBack">
        <ArrowLeft class="h-4 w-4" />
      </Button>
      <div class="min-w-0 flex-1">
        <h1 class="text-sm font-semibold">Scheduled</h1>
        <p class="truncate text-[11px] text-muted-foreground">Agents that start later, once or every week.</p>
      </div>
      <AssistantButton />
      <Button v-if="hasReports" variant="ghost" size="sm" class="h-7 gap-1.5 rounded-tab px-2 text-xs text-muted-foreground" @click="router.push({ name: 'routineLog' })">
        <ScrollText class="h-4 w-4" />Reports
      </Button>
      <Button variant="ghost" size="sm" class="h-7 gap-1.5 rounded-tab px-2 text-xs" :disabled="creating" @click="create()">
        <Plus class="h-4 w-4" />New routine
      </Button>
    </header>

    <main class="mx-1.5 mb-1.5 min-h-0 flex-1 overflow-hidden rounded-xl border-t border-white/5 bg-background">
      <div class="h-full overflow-y-auto">
        <div class="mx-auto w-full max-w-[44rem] space-y-8 px-3 pb-10 pt-4 sm:px-4">
          <p v-if="error" role="alert" class="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{{ error }}</p>

          <div v-if="!loaded" class="space-y-3" aria-busy="true">
            <div v-for="index in 3" :key="index" class="h-12 animate-pulse rounded-lg bg-card/60" />
          </div>

          <div v-else-if="!routines.length" class="py-16 text-center">
            <p class="text-sm">Nothing scheduled yet</p>
            <p class="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">A routine starts an agent at the time you choose, once or every week, such as a 16:30 roundup of the day's work. Agents can also schedule follow-ups for you.</p>
            <Button variant="outline" size="sm" class="mt-4 h-8 gap-1.5 text-xs" :disabled="creating" @click="create()"><Plus class="h-4 w-4" />New routine</Button>
          </div>

          <template v-else>
            <section v-if="attention.length" aria-label="Needs you">
              <ul class="-mx-2">
                <li v-for="item in attention" :key="item.run.run_id">
                  <button type="button" class="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-white/[0.03]" @click="openRun(item.run)">
                    <UnreadDot :urgency="item.run.needs_you ? 'high' : 'normal'" />
                    <span class="min-w-0 flex-1 truncate text-[13px]">
                      <span class="font-medium">{{ item.routine.name }}</span>
                      <span class="text-muted-foreground"> · {{ runStatusLabel(item.run) }}<template v-if="item.run.excerpt">: {{ item.run.excerpt }}</template></span>
                    </span>
                    <span class="shrink-0 text-xs text-muted-foreground">Open</span>
                  </button>
                </li>
              </ul>
            </section>

            <section v-if="recent.length" aria-label="Last 12 hours">
              <p class="mb-2 text-xs text-muted-foreground">Last 12 hours</p>
              <RoutineLog :runs="recent" :routines="routines" :now="now" @open="openRun" />
              <RouterLink :to="{ name: 'routineLog' }" class="mt-1 inline-block text-xs text-muted-foreground hover:text-foreground">All reports</RouterLink>
            </section>

            <section v-if="agenda.length" aria-label="Coming up">
              <p class="mb-2 text-xs text-muted-foreground">Coming up</p>
              <div v-for="group in agenda" :key="group.day" class="mb-3">
                <p class="pb-1 text-[11px] text-muted-foreground/80">{{ group.day }}</p>
                <ul class="-mx-2">
                  <li v-for="item in group.items" :key="`${item.routine.routine_id}:${item.at}`">
                    <button type="button" class="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-white/[0.03]" @click="selectedId = item.routine.routine_id">
                      <span class="w-11 shrink-0 tabular-nums text-muted-foreground">{{ formatRunTime(item.at) }}</span>
                      <AgentIcon :harness="item.routine.harness" class="h-3.5 w-3.5 text-muted-foreground" />
                      <span class="min-w-0 flex-1 truncate">{{ item.routine.name }}</span>
                      <span class="hidden truncate text-xs text-muted-foreground sm:inline">{{ item.routine.project_name ?? 'All projects' }}</span>
                    </button>
                  </li>
                </ul>
              </div>
            </section>

            <section v-if="onceList.length" aria-label="One-off">
              <p class="mb-2 text-xs text-muted-foreground">One-off</p>
              <ul class="-mx-2">
                <li v-for="routine in onceList" :key="routine.routine_id" class="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-white/[0.03]">
                  <button type="button" class="min-w-0 flex-1 text-left" @click="selectedId = routine.routine_id">
                    <span class="block truncate text-[13px]" :class="routine.enabled ? 'font-medium' : 'text-muted-foreground'">{{ routine.name }}</span>
                    <span class="block truncate text-xs text-muted-foreground">
                      {{ nextRunLabel(routine, now) }} · {{ harnessLabel(routine.harness) }} {{ describeLaunch(routine, models) }} · {{ routine.project_name ?? 'all projects' }}<template v-if="routine.last_run"> · {{ runStatusLabel(routine.last_run).toLowerCase() }}</template><template v-if="routine.created_by.type === 'agent'"> · by {{ routine.created_by.name ?? 'an agent' }}</template>
                    </span>
                  </button>
                  <Switch v-if="!onceDone(routine, now)" :model-value="routine.enabled" :aria-label="`Run ${routine.name} at its time`" @update:model-value="setEnabled(routine, Boolean($event))" />
                </li>
              </ul>
            </section>

            <section v-if="repeating.length" aria-label="Routines">
              <p class="mb-2 text-xs text-muted-foreground">Every week</p>
              <ul class="-mx-2">
                <li v-for="routine in repeating" :key="routine.routine_id" class="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-white/[0.03]">
                  <button type="button" class="min-w-0 flex-1 text-left" @click="selectedId = routine.routine_id">
                    <span class="block truncate text-[13px]" :class="routine.enabled ? 'font-medium' : 'text-muted-foreground'">{{ routine.name }}</span>
                    <span class="block truncate text-xs text-muted-foreground">
                      {{ describeSchedule(routine) }} · {{ harnessLabel(routine.harness) }} {{ describeLaunch(routine, models) }} · {{ routine.project_name ?? 'all projects' }}<template v-if="routine.last_run"> · last {{ runStatusLabel(routine.last_run).toLowerCase() }}</template>
                    </span>
                  </button>
                  <Switch :model-value="routine.enabled" :aria-label="`Run ${routine.name} on schedule`" @update:model-value="setEnabled(routine, Boolean($event))" />
                </li>
              </ul>
            </section>
          </template>
        </div>
      </div>
    </main>

    <RoutineDialog
      :routine="selected"
      :now="now"
      :harnesses="installedHarnesses"
      :projects="projectList"
      :presets="presets"
      :models="models"
      :revision="revision"
      @close="selectedId = ''"
      @saved="replace"
      @deleted="removed"
      @duplicate="duplicate"
      @open-run="openRun"
    />
    <RoutineReportDialog :run="reportRun" :title="routineName(reportRun?.routine_id)" :now="now" @close="closeReport" @open-conversation="openConversation" />
    <RoutineRunDialog :process-id="runProcessId" :title="runTitle" @close="closeRun" />
  </div>
</template>

<script setup lang="ts">
import AssistantButton from '../Components/Assistant/AssistantButton.vue';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ArrowLeft, Plus, ScrollText } from 'lucide-vue-next';
import AgentIcon from '../Components/AgentIcon.vue';
import UnreadDot from '../Components/UnreadDot.vue';
import RoutineDialog from '../Components/routines/RoutineDialog.vue';
import RoutineLog from '../Components/routines/RoutineLog.vue';
import RoutineReportDialog from '../Components/routines/RoutineReportDialog.vue';
import RoutineRunDialog from '../Components/routines/RoutineRunDialog.vue';
import { Button } from '../Components/ui/button';
import { Switch } from '../Components/ui/switch';
import { useRoutineRunViewer } from '../Composables/useRoutineRunViewer';
import { useWorkbench } from '../Composables/useWorkbench';
import { harnessLabel } from '../lib/harnesses';
import { harnessModels, harnessPresets, useTopicRefresh } from '../lib/serverQuery';
import {
  createRoutine, describeLaunch, describeSchedule, formatRunDay, formatRunTime, listRoutines, nextRunLabel, nextRuns, onceDone, routineLog, routineRun, runTime, ROUTINE_HARNESSES,
  runNeedsAttention, runStatusLabel, updateRoutine, type RoutineModelOption, type RoutinePresetOption, type RoutineRecord, type RoutineRunRecord
} from '../lib/routines';

const DAY_MS = 86_400_000;
// A failed or blocked run stays at the top for a day; one waiting on the user stays until it moves on.
const ATTENTION_MS = DAY_MS;

const router = useRouter();
const route = useRoute();
const workbench = useWorkbench();
const routines = ref<RoutineRecord[]>([]);
const presets = ref<RoutinePresetOption[]>([]);
const models = ref<Record<string, RoutineModelOption[]>>({});
const loaded = ref(false);
const creating = ref(false);
const error = ref('');
const selectedId = ref('');
const revision = ref(0);
// The newest reports; the last 12 hours of them sit at the top, the rest on the Reports page.
const RECENT_MS = 12 * 3_600_000;
const latest = ref<RoutineRunRecord[]>([]);
// Runs already listed under Needs you are not repeated.
const recent = computed(() => {
  const shown = new Set(attention.value.map((item) => item.run.run_id));
  return latest.value.filter((run) => !shown.has(run.run_id) && now.value - runTime(run) < RECENT_MS);
});
const hasReports = computed(() => latest.value.length > 0);
const now = ref(Date.now());
const clock = setInterval(() => { now.value = Date.now(); }, 30_000);

const selected = computed(() => routines.value.find((routine) => routine.routine_id === selectedId.value) ?? null);
const projectList = computed(() => workbench.projects.value.map((group) => ({ id: group.project.id, name: group.project.name })));
const installedHarnesses = computed(() => workbench.harnesses.value
  .filter((install) => install.status === 'available' && (ROUTINE_HARNESSES as readonly string[]).includes(install.harness))
  .map((install) => install.harness));

const attention = computed(() => routines.value.flatMap((routine) => {
  if (routine.waiting_run) return [{ routine, run: routine.waiting_run }];
  const run = routine.last_run;
  if (!run || !runNeedsAttention(run)) return [];
  const at = Date.parse(run.reported_at ?? run.finished_at ?? run.scheduled_for);
  return run.needs_you || now.value - at < ATTENTION_MS ? [{ routine, run }] : [];
}));

const repeating = computed(() => routines.value.filter((routine) => !routine.run_at));
// Waiting one-offs, soonest first. One that has run leaves the list once its run ends; its report stays under Reports.
const onceList = computed(() => routines.value
  .filter((routine) => routine.run_at && (!onceDone(routine, now.value) || routine.last_run?.status === 'running'))
  .sort((left, right) => Date.parse(left.run_at!) - Date.parse(right.run_at!)));

// The next seven days of runs, grouped under Today, Tomorrow, and weekday names.
const agenda = computed(() => {
  const horizon = now.value + 7 * DAY_MS;
  const items = routines.value
    .filter((routine) => routine.enabled)
    .flatMap((routine) => nextRuns(routine, now.value, 7).filter((at) => at < horizon).map((at) => ({ routine, at })))
    .sort((left, right) => left.at - right.at);
  const groups: Array<{ day: string; items: typeof items }> = [];
  for (const item of items) {
    const day = formatRunDay(item.at, now.value);
    const group = groups.at(-1);
    if (group?.day === day) group.items.push(item);
    else groups.push({ day, items: [item] });
  }
  return groups;
});

async function refresh(): Promise<void> {
  try {
    [routines.value, latest.value] = await Promise.all([listRoutines(), routineLog({ limit: 10 }), refreshReport()]);
    revision.value += 1;
    error.value = '';
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loaded.value = true;
  }
}

async function loadLaunchOptions(): Promise<void> {
  try {
    const [presetSettings, catalog] = await Promise.all([
      harnessPresets<{ presets: RoutinePresetOption[] }>().then((settings) => settings ?? { presets: [] }),
      harnessModels<{ providers: Record<string, { models: RoutineModelOption[] } | null> }>()
    ]);
    presets.value = presetSettings.presets.map((preset) => ({ harness: preset.harness, name: preset.name }));
    models.value = Object.fromEntries(Object.entries(catalog.providers).map(([harness, provider]) => [harness, provider?.models ?? []]));
  } catch {
    // Without the catalogue the sentence still lists presets and the current choice.
  }
}

useTopicRefresh(['routines'], () => void refresh(), { lifecycle: true });
// A run waiting on a permission prompt shows as agent activity, not a routine change.
let activityTimer: ReturnType<typeof setTimeout> | null = null;
watch(workbench.revision, () => {
  activityTimer ??= setTimeout(() => { activityTimer = null; void refresh(); }, 1_000);
});

onMounted(() => {
  void refresh().then(openRequestedRun);
  void openRequestedReport();
  void loadLaunchOptions();
});
// A notification clicked while this page is open only changes the query.
// Back from a notification's report removes the query, which closes it.
watch(() => route.query.report, (runId, previous) => {
  if (!runId && previous) reportRun.value = null;
  else void openRequestedReport();
});
watch(() => route.query.run, () => openRequestedRun());
onBeforeUnmount(() => {
  clearInterval(clock);
  if (activityTimer) clearTimeout(activityTimer);
});

async function create(from?: RoutineRecord): Promise<void> {
  creating.value = true;
  try {
    const harness = installedHarnesses.value.includes('claude') ? 'claude' : installedHarnesses.value[0] ?? 'claude';
    // New routines start paused, so nothing runs before it has a prompt.
    const routine = await createRoutine(from ? {
      name: `${from.name} copy`, enabled: false, project_id: from.project_id, days: from.days, time: from.time, timezone: from.timezone, prompt: from.prompt,
      harness: from.harness, preset: from.preset, model: from.model, reasoning: from.reasoning, service_tier: from.service_tier, delivery: from.delivery,
      // A copy of a one-off whose time has passed runs a day from now.
      worktree_id: from.worktree_id,
      run_at: from.run_at ? new Date(Math.max(Date.parse(from.run_at), Date.now() + DAY_MS)).toISOString() : null
    } : { name: 'New routine', enabled: false, harness, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    routines.value = [...routines.value, routine];
    selectedId.value = routine.routine_id;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    creating.value = false;
  }
}

function duplicate(routine: RoutineRecord): void {
  void create(routine);
}

async function setEnabled(routine: RoutineRecord, enabled: boolean): Promise<void> {
  replace({ ...routine, enabled });
  try {
    replace(await updateRoutine(routine.routine_id, { enabled }));
  } catch (cause) {
    replace(routine);
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

function replace(routine: RoutineRecord): void {
  routines.value = routines.value.map((entry) => entry.routine_id === routine.routine_id ? routine : entry);
}

function removed(routineId: string): void {
  selectedId.value = '';
  routines.value = routines.value.filter((routine) => routine.routine_id !== routineId);
}

function routineName(routineId: string | undefined): string {
  return routines.value.find((entry) => entry.routine_id === routineId)?.name ?? 'Routine run';
}

const { reportRun, runProcessId, runTitle, openRun, openConversation, refreshReport } = useRoutineRunViewer(routineName);

// Report notifications link to /routines?report=<run id>.
// A reply is used only while the URL still asks for that run, so a slower
// earlier request, or one for a report since closed, never replaces it.
async function openRequestedReport(): Promise<void> {
  const runId = typeof route.query.report === 'string' ? route.query.report : null;
  if (!runId) return;
  try {
    const run = await routineRun(runId);
    if (route.query.report === runId) reportRun.value = run;
  } catch (cause) {
    if (route.query.report === runId) error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

function closeReport(): void {
  reportRun.value = null;
  if (route.query.report) void router.replace({ name: 'routines' });
}

// Notifications for workspace runs link to /routines?run=<process id>.
function openRequestedRun(): void {
  const processId = typeof route.query.run === 'string' ? route.query.run : null;
  if (!processId) return;
  runTitle.value = routines.value.find((entry) => entry.last_run?.process_id === processId)?.name ?? 'Routine run';
  runProcessId.value = processId;
}

function closeRun(): void {
  runProcessId.value = null;
  if (route.query.run) void router.replace({ name: 'routines' });
}

function goBack(): void {
  if (typeof window.history.state?.back === 'string') router.back();
  else void router.push({ name: 'projects' });
}
</script>
