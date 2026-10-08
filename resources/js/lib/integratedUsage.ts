import type { IntegratedUsage } from './integratedConversation';

export function compactTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(value >= 10_000_000_000 ? 0 : 1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.round(value));
}

export function contextPercent(usage: IntegratedUsage | null): number | null {
  if (usage?.contextTokens === undefined || !usage.contextWindow) return null;
  return Math.min(100, Math.round((usage.contextTokens / usage.contextWindow) * 100));
}

export function formatCost(costUsd: number): string {
  return `$${costUsd < 10 ? costUsd.toFixed(2) : costUsd.toFixed(0)}`;
}

export interface UsageRow {
  label: string;
  value: string;
}

// Every figure the provider reported, for the usage tooltip.
export function usageRows(usage: IntegratedUsage | null): UsageRow[] {
  if (!usage) return [];
  const rows: UsageRow[] = [];
  if (usage.contextTokens !== undefined) {
    const percent = contextPercent(usage);
    rows.push({
      label: 'Context',
      value: usage.contextWindow
        ? `${compactTokens(usage.contextTokens)} / ${compactTokens(usage.contextWindow)} (${percent}%)`
        : compactTokens(usage.contextTokens)
    });
  }
  if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
    rows.push({ label: 'Tokens', value: `${compactTokens(usage.inputTokens ?? 0)} in · ${compactTokens(usage.outputTokens ?? 0)} out` });
  }
  if (usage.costUsd !== undefined) rows.push({ label: 'Cost', value: formatCost(usage.costUsd) });
  for (const limit of usage.limits ?? []) rows.push({ label: limit.label, value: `${Math.round(limit.usedPercent)}% used` });
  return rows;
}

// Calm until the context runs low.
export function usageToneClass(percent: number | null): string {
  if (percent !== null && percent >= 90) return 'text-destructive';
  if (percent !== null && percent >= 75) return 'text-warning';
  return 'text-foreground/70';
}
