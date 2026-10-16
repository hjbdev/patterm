import { onBeforeUnmount, ref, shallowRef, watch, type Ref } from 'vue';

export type UsageRange = 1 | 7 | 30 | 90;

export interface UsageTokens {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  responses: number;
  // At pay-as-you-go API prices; unpricedTokens are left out of it.
  costUsd: number;
  unpricedTokens: number;
}

export interface UsageLimit {
  harness: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  observedAt: string;
  expired: boolean;
}

export interface UsageSkill {
  name: string;
  agentUses: number;
  userUses: number;
  providers: string[];
  lastUsedAt: string | null;
}

export interface UsageSummary {
  since: string;
  days: number;
  // Every day in the range on the server's calendar, as YYYY-MM-DD.
  dayKeys: string[];
  historyAvailable: boolean;
  totals: UsageTokens;
  autoSummaries: UsageTokens;
  daily: Array<UsageTokens & { day: string; provider: string }>;
  models: Array<UsageTokens & { provider: string; model: string | null }>;
  projects: Array<UsageTokens & { projectId: string | null; name: string | null }>;
  limits: UsageLimit[];
  skills: UsageSkill[];
}

export const HARNESSES = ['claude', 'codex', 'opencode'] as const;
export const HARNESS_LABELS: Record<string, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };

// Fresh work the model processed: everything except cache reads, which are
// cheap and dwarf the rest.
export function processedTokens(tokens: UsageTokens): number {
  return tokens.inputTokens + tokens.cacheWriteTokens + tokens.outputTokens;
}

export type UsageMetric = 'tokens' | 'cost';

export function metricValue(tokens: UsageTokens, metric: UsageMetric): number {
  return metric === 'cost' ? tokens.costUsd : processedTokens(tokens);
}

const dollars = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const cents = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function formatUsd(value: number): string {
  return value >= 100 ? dollars.format(value) : cents.format(value);
}

export function harnessLabel(harness: string): string {
  return HARNESS_LABELS[harness] ?? harness;
}

// Time until a window resets, such as 2h 14m or 3d 4h.
export function untilLabel(value: string | null, now: number): string {
  if (!value) return '';
  const minutes = Math.max(0, Math.round((Date.parse(value) - now) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

// Imports run in the background, so the page re-reads on a slow interval
// rather than waiting for a change announcement.
export function useUsage(days: Ref<UsageRange>) {
  const summary = shallowRef<UsageSummary | null>(null);
  const error = ref('');
  let request = 0;

  async function refresh(): Promise<void> {
    const current = ++request;
    try {
      const result = await window.patterm.call('usage_summary', { days: days.value }) as UsageSummary;
      if (current !== request) return;
      summary.value = result;
      error.value = '';
    } catch (caught) {
      if (current === request) error.value = caught instanceof Error ? caught.message : String(caught);
    }
  }

  watch(days, () => void refresh());
  const interval = setInterval(() => void refresh(), 60_000);
  onBeforeUnmount(() => clearInterval(interval));
  void refresh();
  return { summary, error, refresh };
}
