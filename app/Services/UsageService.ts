import type { DatabaseService } from './DatabaseService';
import type { HistoryDatabaseService } from './HistoryDatabaseService';
import { apiCost, modelPrice } from './ModelPrices';

export interface UsageTokens {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  responses: number;
  // What the tokens would cost at API list prices, or OpenCode's own figure
  // for models without one.
  costUsd: number;
  // Processed tokens from models without a known price, left out of costUsd.
  unpricedTokens: number;
}

export interface UsageLimit {
  harness: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  observedAt: string;
  // The window ended after this observation, so its figure no longer applies.
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
  // Every day in the range on the server's calendar, which daily rows use.
  dayKeys: string[];
  historyAvailable: boolean;
  totals: UsageTokens;
  daily: Array<UsageTokens & { day: string; provider: string }>;
  models: Array<UsageTokens & { provider: string; model: string | null }>;
  projects: Array<UsageTokens & { projectId: string | null; name: string | null }>;
  limits: UsageLimit[];
  skills: UsageSkill[];
}

const STALE_LIMIT_MS = 7 * 24 * 60 * 60_000;

// One row per local day, model, and project; every view sums these.
interface UsageGroup {
  day: string;
  provider: string;
  model: string | null;
  projectId: string | null;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  responses: number;
  reportedCost: number | null;
}

type PricedGroup = UsageGroup & Pick<UsageTokens, 'costUsd' | 'unpricedTokens'>;

// Token usage comes from imported native transcripts in history.db; quota
// windows come from both transcripts and live Integrated sessions.
export class UsageService {
  private readonly written = new Map<string, string>();

  constructor(private readonly database: DatabaseService, private readonly history: HistoryDatabaseService | null) {}

  // Every snapshot repeats the session's latest windows, including an idle
  // session's old ones. Each window carries when the provider reported it,
  // and only a newer report replaces the stored one.
  recordLimits(harness: string, limits: unknown): void {
    if (!Array.isArray(limits)) return;
    const upsert = this.database.connection.prepare(`
      insert into harness_rate_limits (harness, label, used_percent, resets_at, observed_at) values (?, ?, ?, ?, ?)
      on conflict(harness, label) do update set used_percent = excluded.used_percent, resets_at = excluded.resets_at, observed_at = excluded.observed_at
      where excluded.observed_at > harness_rate_limits.observed_at
    `);
    for (const limit of limits) {
      if (!limit || typeof limit !== 'object') continue;
      const { label, usedPercent, resetsAt, observedAt } = limit as Record<string, unknown>;
      if (typeof label !== 'string' || typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) continue;
      // Hosts started before observation times existed cannot date their windows.
      if (typeof observedAt !== 'string' || Number.isNaN(Date.parse(observedAt))) continue;
      const observed = new Date(observedAt).toISOString();
      const resets = typeof resetsAt === 'string' ? resetsAt : null;
      const key = `${harness}\u0000${label}`;
      if (this.written.get(key) === observed) continue;
      upsert.run(harness, label, usedPercent, resets, observed);
      this.written.set(key, observed);
    }
  }

  summary(days: number, now = new Date()): UsageSummary {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));
    const since = start.toISOString();
    const dayKeys = Array.from({ length: days }, (_, index) => {
      const day = new Date(start);
      day.setDate(start.getDate() + index);
      return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    });
    const empty: UsageSummary = { since, days, dayKeys, historyAvailable: false, totals: emptyTokens(), daily: [], models: [], projects: [], limits: [], skills: [] };
    const db = this.historyConnection();
    if (!db) return { ...empty, limits: this.limits(null, now) };

    // Days follow the server's local calendar, like the rest of the app.
    const rows = db.prepare(`
      select date(occurred_at, 'localtime') as day, conversation_usage.provider as provider, model, conversations.project_id as projectId,
        sum(input_tokens) as inputTokens, sum(cache_read_tokens) as cacheReadTokens, sum(cache_write_tokens) as cacheWriteTokens,
        sum(cache_write_1h_tokens) as cacheWrite1hTokens, sum(output_tokens) as outputTokens, sum(reasoning_tokens) as reasoningTokens,
        count(*) as responses, sum(cost_usd) as reportedCost
      from conversation_usage join conversations on conversations.id = conversation_usage.conversation_id
      where occurred_at >= ?
      group by day, conversation_usage.provider, model, conversations.project_id
    `).all(since) as unknown as UsageGroup[];
    const groups = rows.map(priceGroup);
    const totals = sumGroups(groups, () => 'all')[0]?.tokens ?? emptyTokens();
    const daily = sumGroups(groups, (group) => `${group.day}\u0000${group.provider}`)
      .map(({ first, tokens }) => ({ day: first.day, provider: first.provider, ...tokens }))
      .sort((a, b) => a.day.localeCompare(b.day) || a.provider.localeCompare(b.provider));
    const models = sumGroups(groups, (group) => `${group.provider}\u0000${group.model}`)
      .map(({ first, tokens }) => ({ provider: first.provider, model: first.model, ...tokens }))
      .sort((a, b) => processed(b) - processed(a));
    const projectRows = sumGroups(groups, (group) => group.projectId ?? '')
      .map(({ first, tokens }) => ({ projectId: first.projectId, ...tokens }))
      .sort((a, b) => processed(b) - processed(a));
    const names = this.projectNames(projectRows.map((row) => row.projectId).filter((id): id is string => Boolean(id)));
    const projects = projectRows.map((row) => ({ ...row, name: row.projectId ? names.get(row.projectId) ?? null : null }));
    return { since, days, dayKeys, historyAvailable: true, totals, daily, models, projects, limits: this.limits(db, now), skills: this.skills(db, since) };
  }

  private limits(history: ReturnType<UsageService['historyConnection']>, now: Date): UsageLimit[] {
    const live = this.database.connection.prepare(`select harness, label, used_percent as usedPercent, resets_at as resetsAt, observed_at as observedAt from harness_rate_limits`).all() as unknown as Omit<UsageLimit, 'expired'>[];
    const recorded = history
      ? history.prepare(`select provider as harness, label, used_percent as usedPercent, resets_at as resetsAt, observed_at as observedAt from provider_rate_limits`).all() as unknown as Omit<UsageLimit, 'expired'>[]
      : [];
    const newest = new Map<string, Omit<UsageLimit, 'expired'>>();
    for (const limit of [...live, ...recorded]) {
      const key = `${limit.harness}\u0000${limit.label}`;
      const current = newest.get(key);
      if (!current || limit.observedAt > current.observedAt) newest.set(key, limit);
    }
    return [...newest.values()]
      .map((limit) => ({ ...limit, expired: Boolean(limit.resetsAt && Date.parse(limit.resetsAt) <= now.getTime()) }))
      // A quota not seen for a week, such as one for a retired model, is dropped once it has reset.
      .filter((limit) => !limit.expired || now.getTime() - Date.parse(limit.observedAt) < STALE_LIMIT_MS)
      .sort((a, b) => a.harness.localeCompare(b.harness) || windowOrder(a.label) - windowOrder(b.label) || a.label.localeCompare(b.label));
  }

  // Skills with the same name count together across harnesses.
  private skills(db: NonNullable<ReturnType<UsageService['historyConnection']>>, since: string): UsageSkill[] {
    const rows = db.prepare(`
      select skill as name, sum(invoked_by = 'agent') as agentUses, sum(invoked_by = 'user') as userUses,
        group_concat(distinct provider) as providers, max(occurred_at) as lastUsedAt
      from conversation_skill_uses where occurred_at >= ?
      group by skill order by count(*) desc, skill
    `).all(since) as Array<Omit<UsageSkill, 'providers'> & { providers: string }>;
    return rows.map((row) => ({ ...row, providers: row.providers.split(',').sort() }));
  }

  private projectNames(ids: string[]): Map<string, string> {
    if (!ids.length) return new Map();
    const rows = this.database.connection.prepare(`select id, name from projects where id in (${ids.map(() => '?').join(', ')})`).all(...ids) as Array<{ id: string; name: string }>;
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  // The worker migrates history.db in the background, so the usage tables
  // may not exist yet when the main process reads it.
  private historyConnection() {
    if (!this.history?.ensureAvailable()) return null;
    const db = this.history.connection;
    const tables = db.prepare(`select count(*) as count from sqlite_master where type = 'table' and name in ('conversation_usage', 'provider_rate_limits', 'conversation_skill_uses')`).get() as { count: number };
    return tables.count === 3 ? db : null;
  }
}

function windowOrder(label: string): number {
  if (label.includes('5h')) return 0;
  if (label.includes('Weekly')) return 1;
  return 2;
}

function emptyTokens(): UsageTokens {
  return { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, responses: 0, costUsd: 0, unpricedTokens: 0 };
}

function processed(tokens: UsageTokens): number {
  return tokens.inputTokens + tokens.cacheWriteTokens + tokens.outputTokens;
}

// List prices win: OpenCode reports $0 for models billed to a subscription.
function priceGroup(group: UsageGroup): PricedGroup {
  const price = modelPrice(group.model);
  if (price) return { ...group, costUsd: apiCost(price, group), unpricedTokens: 0 };
  if (group.reportedCost !== null) return { ...group, costUsd: group.reportedCost, unpricedTokens: 0 };
  return { ...group, costUsd: 0, unpricedTokens: group.inputTokens + group.cacheWriteTokens + group.outputTokens };
}

function sumGroups(groups: PricedGroup[], keyOf: (group: PricedGroup) => string): Array<{ first: PricedGroup; tokens: UsageTokens }> {
  const sums = new Map<string, { first: PricedGroup; tokens: UsageTokens }>();
  for (const group of groups) {
    const key = keyOf(group);
    const entry = sums.get(key) ?? { first: group, tokens: emptyTokens() };
    const tokens = entry.tokens;
    tokens.inputTokens += group.inputTokens;
    tokens.cacheReadTokens += group.cacheReadTokens;
    tokens.cacheWriteTokens += group.cacheWriteTokens;
    tokens.outputTokens += group.outputTokens;
    tokens.reasoningTokens += group.reasoningTokens;
    tokens.responses += group.responses;
    tokens.costUsd += group.costUsd;
    tokens.unpricedTokens += group.unpricedTokens;
    sums.set(key, entry);
  }
  return [...sums.values()];
}
