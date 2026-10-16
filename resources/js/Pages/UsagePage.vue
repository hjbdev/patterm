<template>
  <div class="flex h-dvh min-h-0 flex-col overflow-hidden bg-[#080808] text-foreground">
    <header class="flex h-11 shrink-0 items-center gap-3 px-3">
      <Button variant="ghost" size="icon" class="h-8 w-8 rounded-tab text-muted-foreground" aria-label="Back" @click="goBack">
        <ArrowLeft class="h-4 w-4" />
      </Button>
      <div class="min-w-0 flex-1">
        <h1 class="text-sm font-semibold">Usage</h1>
        <p class="truncate text-[11px] text-muted-foreground">Tokens from agent conversations and auto-summaries, plus remaining quota.</p>
      </div>
      <AssistantButton />
    </header>

    <main class="mx-1.5 mb-1.5 min-h-0 flex-1 overflow-hidden rounded-xl border-t border-white/5 bg-background">
      <div class="h-full overflow-y-auto" data-component="usage-scroller">
        <div class="mx-auto w-full max-w-[44rem] space-y-8 px-3 pb-10 pt-4 sm:px-4">
          <p v-if="error" role="alert" class="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{{ error }}</p>

          <div v-if="!summary" class="space-y-3" aria-busy="true">
            <div v-for="index in 3" :key="index" class="h-20 animate-pulse rounded-xl bg-card/60" />
          </div>

          <template v-else>
            <section aria-label="Remaining quota">
              <p class="mb-2 text-xs text-muted-foreground">Remaining</p>
              <p v-if="!summary.limits.length" class="text-xs text-muted-foreground">
                No quota windows seen yet. Claude reports them during Integrated sessions; Codex records them in its transcripts.
              </p>
              <ul v-else class="-mx-2">
                <li v-for="limit in summary.limits" :key="`${limit.harness}:${limit.label}`" class="rounded-md px-2 py-2 hover:bg-white/[0.03]" data-component="usage-limit">
                  <div class="flex items-baseline gap-2 text-sm">
                    <span class="font-medium">{{ harnessLabel(limit.harness) }}</span>
                    <span class="text-muted-foreground">{{ limit.label }}</span>
                    <span class="ml-auto tabular-nums" :class="limit.expired ? 'text-muted-foreground' : toneClass(limit.usedPercent)">
                      {{ limit.expired ? 'Reset' : `${remaining(limit)}% left` }}
                    </span>
                  </div>
                  <div class="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.06]">
                    <div v-if="!limit.expired" class="h-full rounded-full" :class="barClass(limit.usedPercent)" :style="{ width: `${Math.min(100, Math.max(0, limit.usedPercent))}%` }" />
                  </div>
                  <p class="mt-1 text-[11px] text-muted-foreground/80">
                    <!-- Each part wraps whole, breaking only between parts. -->
                    <template v-if="limit.expired"><span class="whitespace-nowrap">Window reset since last seen</span> · </template>
                    <template v-else-if="limit.resetsAt"><span class="whitespace-nowrap">Resets in {{ untilLabel(limit.resetsAt, now) }}</span> · </template>
                    <template v-if="pace(limit)"><span class="whitespace-nowrap">{{ pace(limit) }}</span> · </template>
                    <span class="whitespace-nowrap">seen {{ relativeTime(limit.observedAt, now) }}</span>
                  </p>
                </li>
              </ul>
            </section>

            <section aria-label="Token usage">
              <div class="mb-3 flex items-center gap-2">
                <p class="text-xs text-muted-foreground">Tokens</p>
                <div class="ml-auto flex gap-1" role="group" aria-label="Range">
                  <button
                    v-for="option in RANGES"
                    :key="option.days"
                    type="button"
                    class="h-7 rounded-full border px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    :class="days === option.days ? 'border-white/20 bg-white/[0.08] text-foreground' : 'border-white/[0.06] text-muted-foreground hover:bg-white/[0.04] hover:text-foreground'"
                    :aria-pressed="days === option.days"
                    @click="days = option.days"
                  >{{ option.label }}</button>
                </div>
              </div>

              <p v-if="!summary.historyAvailable" class="text-xs text-muted-foreground">
                Conversation history has not been imported yet. Turn on history sources in Settings to include conversation tokens.
              </p>
              <template v-if="summary.historyAvailable || summary.autoSummaries?.responses">
                <dl class="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-5">
                  <div v-for="stat in stats" :key="stat.label">
                    <dt class="text-[11px] text-muted-foreground">{{ stat.label }}</dt>
                    <dd class="mt-0.5 text-xl font-semibold tabular-nums" :title="stat.exact">{{ stat.value }}</dd>
                  </div>
                </dl>
                <p class="mt-2 text-[11px] text-muted-foreground/80">
                  {{ summary.totals.responses.toLocaleString() }} model responses. API prices are pay-as-you-go list rates, which your subscriptions replace; OpenCode's own figures cover models without one.
                  <template v-if="unpricedModels.length">{{ compactTokens(summary.totals.unpricedTokens) }} tokens from {{ unpricedModels.join(', ') }} have no public price and are left out.</template>
                </p>

                <p v-if="summary.autoSummaries?.responses" class="mt-2 text-[11px] text-muted-foreground" data-component="auto-summary-usage">
                  Includes auto-summaries: {{ summary.autoSummaries.responses.toLocaleString() }} model responses,
                  {{ compactTokens(processedTokens(summary.autoSummaries)) }} tokens excluding cache reads,
                  {{ formatUsd(summary.autoSummaries.costUsd) }} at API prices.
                </p>

                <p class="mt-2 text-[11px] text-muted-foreground/80">OpenCode auto-summary usage is unavailable because its summary endpoint does not report tokens.</p>

                <div v-if="summary.days > 1" class="mt-6">
                  <div class="mb-2 flex items-center gap-2">
                    <p class="text-[11px] text-muted-foreground">{{ metric === 'cost' ? 'Per day, at API prices' : 'Per day, excluding cache reads' }}</p>
                    <div class="ml-auto flex rounded-full border border-white/[0.06] p-0.5" role="group" aria-label="Chart measure">
                      <button
                        v-for="option in METRICS"
                        :key="option.value"
                        type="button"
                        class="h-6 rounded-full px-2.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        :class="metric === option.value ? 'bg-white/[0.08] text-foreground' : 'text-muted-foreground hover:text-foreground'"
                        :aria-pressed="metric === option.value"
                        @click="metric = option.value"
                      >{{ option.label }}</button>
                    </div>
                  </div>
                  <UsageDailyChart :summary="summary" :metric="metric" />
                </div>
              </template>
            </section>

            <section v-if="summary.models.length" aria-label="By model">
              <p class="mb-2 text-xs text-muted-foreground">By model</p>
              <ul class="-mx-2">
                <li v-for="row in summary.models" :key="`${row.provider}:${row.model}`" class="flex items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-white/[0.03]">
                  <span class="min-w-0 flex-1 truncate">{{ row.model ?? 'Unknown model' }} <span class="text-muted-foreground">· {{ harnessLabel(row.provider) }}</span></span>
                  <span class="hidden h-1 w-24 overflow-hidden rounded-full bg-white/[0.06] sm:block"><span class="block h-full rounded-full bg-foreground/40" :style="{ width: share(row) }" /></span>
                  <span class="w-14 text-right tabular-nums text-muted-foreground">{{ compactTokens(processedTokens(row)) }}</span>
                  <span class="w-16 text-right tabular-nums text-muted-foreground/80" :title="row.unpricedTokens ? 'No public price for some of these tokens' : undefined">{{ row.costUsd || !row.unpricedTokens ? formatUsd(row.costUsd) : '—' }}</span>
                </li>
              </ul>
            </section>

            <section v-if="summary.projects.length" aria-label="By project">
              <p class="mb-2 text-xs text-muted-foreground">By project</p>
              <ul class="-mx-2">
                <li v-for="row in summary.projects" :key="row.projectId ?? 'none'" class="flex items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-white/[0.03]">
                  <span class="min-w-0 flex-1 truncate" :class="row.name ? '' : 'text-muted-foreground'">{{ row.name ?? 'Outside Patterm projects' }}</span>
                  <span class="hidden h-1 w-24 overflow-hidden rounded-full bg-white/[0.06] sm:block"><span class="block h-full rounded-full bg-foreground/40" :style="{ width: share(row) }" /></span>
                  <span class="w-14 text-right tabular-nums text-muted-foreground">{{ compactTokens(processedTokens(row)) }}</span>
                  <span class="w-16 text-right tabular-nums text-muted-foreground/80" :title="row.unpricedTokens ? 'No public price for some of these tokens' : undefined">{{ row.costUsd || !row.unpricedTokens ? formatUsd(row.costUsd) : '—' }}</span>
                </li>
              </ul>
            </section>

            <section v-if="summary.historyAvailable" aria-label="Skills">
              <p class="mb-2 text-xs text-muted-foreground">Skills</p>
              <p v-if="!summary.skills.length" class="text-xs text-muted-foreground">No skills used in this range.</p>
              <ul v-else class="-mx-2">
                <li v-for="skill in visibleSkills" :key="skill.name" class="flex items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-white/[0.03]" data-component="usage-skill">
                  <span class="min-w-0 flex-1 truncate">{{ skill.name }} <span class="text-muted-foreground">· {{ skill.providers.map(harnessLabel).join(', ') }}</span></span>
                  <span class="hidden h-1 w-24 overflow-hidden rounded-full bg-white/[0.06] sm:block"><span class="block h-full rounded-full bg-foreground/40" :style="{ width: `${(skillUses(skill) / largestSkill) * 100}%` }" /></span>
                  <span class="w-14 text-right tabular-nums text-muted-foreground" :title="`${skill.agentUses} by the agent, ${skill.userUses} by you`">{{ skillUses(skill).toLocaleString() }}</span>
                  <span class="w-24 whitespace-nowrap text-right text-[11px] text-muted-foreground/80">{{ skill.lastUsedAt ? relativeTime(skill.lastUsedAt, now) : '' }}</span>
                </li>
              </ul>
              <button
                v-if="summary.skills.length > SKILL_LIMIT"
                type="button"
                class="mt-1 rounded text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                @click="allSkills = !allSkills"
              >{{ allSkills ? 'Show fewer' : `Show all ${summary.skills.length}` }}</button>
            </section>
          </template>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import AssistantButton from '../Components/Assistant/AssistantButton.vue';
import { computed, onBeforeUnmount, ref } from 'vue';
import { ArrowLeft } from 'lucide-vue-next';
import { Button } from '../Components/ui/button';
import UsageDailyChart from '../Components/UsageDailyChart.vue';
import { useWorkbenchNavigation } from '../Composables/useWorkbenchNavigation';
import { relativeTime } from '../lib/format';
import { compactTokens } from '../lib/integratedUsage';
import { formatUsd, harnessLabel, processedTokens, untilLabel, useUsage, type UsageLimit, type UsageMetric, type UsageRange, type UsageSkill, type UsageTokens } from '../lib/usage';

const RANGES: Array<{ days: UsageRange; label: string }> = [
  { days: 1, label: 'Today' },
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' }
];

const METRICS: Array<{ value: UsageMetric; label: string }> = [
  { value: 'tokens', label: 'Tokens' },
  { value: 'cost', label: 'Cost' }
];

const { router, activeProjectId } = useWorkbenchNavigation();
const metric = ref<UsageMetric>('tokens');
const days = ref<UsageRange>(30);
const { summary, error } = useUsage(days);
const now = ref(Date.now());
const clock = setInterval(() => { now.value = Date.now(); }, 30_000);
onBeforeUnmount(() => clearInterval(clock));

const stats = computed(() => {
  const totals = summary.value?.totals;
  if (!totals) return [];
  return [
    { label: 'Input', count: totals.inputTokens },
    { label: 'Output', count: totals.outputTokens },
    { label: 'Cache writes', count: totals.cacheWriteTokens },
    { label: 'Cache reads', count: totals.cacheReadTokens }
  ].map((stat) => ({ label: stat.label, value: compactTokens(stat.count), exact: `${stat.count.toLocaleString()} tokens` }))
    .concat({ label: 'At API prices', value: formatUsd(totals.costUsd), exact: 'What these tokens would cost at pay-as-you-go API prices' });
});

const unpricedModels = computed(() => (summary.value?.models ?? []).filter((row) => row.unpricedTokens > 0).map((row) => row.model ?? 'unknown models'));

const largestModel = computed(() => Math.max(1, ...(summary.value?.models ?? []).map(processedTokens)));
const largestProject = computed(() => Math.max(1, ...(summary.value?.projects ?? []).map(processedTokens)));
function share(row: UsageTokens & { projectId?: string | null }): string {
  const largest = 'projectId' in row ? largestProject.value : largestModel.value;
  return `${(processedTokens(row) / largest) * 100}%`;
}

function skillUses(skill: UsageSkill): number {
  return skill.agentUses + skill.userUses;
}
const SKILL_LIMIT = 12;
const allSkills = ref(false);
const visibleSkills = computed(() => {
  const skills = summary.value?.skills ?? [];
  return allSkills.value ? skills : skills.slice(0, SKILL_LIMIT);
});
const largestSkill = computed(() => Math.max(1, ...(summary.value?.skills ?? []).map(skillUses)));

function remaining(limit: UsageLimit): number {
  return Math.max(0, Math.round(100 - limit.usedPercent));
}
function pace(limit: UsageLimit): string {
  if (limit.exhaustsAt) return Date.parse(limit.exhaustsAt) > now.value ? `On pace to run out in ${untilLabel(limit.exhaustsAt, now.value)}` : '';
  if (limit.projectedPercent === null) return '';
  return `On pace for ${Math.max(0, Math.round(100 - limit.projectedPercent))}% left at reset`;
}
// Calm until the quota runs low.
function toneClass(usedPercent: number): string {
  if (usedPercent >= 90) return 'text-destructive';
  if (usedPercent >= 75) return 'text-warning';
  return 'text-foreground/80';
}
function barClass(usedPercent: number): string {
  if (usedPercent >= 90) return 'bg-destructive';
  if (usedPercent >= 75) return 'bg-warning';
  return 'bg-foreground/50';
}

function goBack(): void {
  if (typeof window.history.state?.back === 'string') {
    router.back();
  } else if (activeProjectId.value) {
    void router.push({ name: 'project', params: { projectId: activeProjectId.value } });
  } else {
    void router.push({ name: 'projects' });
  }
}
</script>
