import { z } from 'zod';

// Cached per-harness model catalog. Discovery is best-effort: Claude Code lists
// models in its stream-json `initialize` reply, with a built-in alias fallback;
// Codex renders its catalog via `debug models`; OpenCode exposes models through
// its HTTP API.

export const catalogHarnessInput = z.enum(['claude', 'codex', 'opencode']);
export const CATALOG_HARNESSES = catalogHarnessInput.options;

export const harnessModelInput = z.object({
  id: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(200),
  reasoning: z.array(z.string().trim().min(1).max(60)).max(16).default([]),
  defaultReasoning: z.string().trim().min(1).max(60).nullable().default(null),
  // Codex service tiers beyond Standard, such as `priority` labelled Fast.
  serviceTiers: z.array(z.object({ id: z.string().trim().min(1).max(60), label: z.string().trim().min(1).max(60) })).max(16).optional()
});

export type HarnessModel = z.infer<typeof harnessModelInput>;

export const harnessProviderCatalogInput = z.object({
  harness: catalogHarnessInput,
  source: z.enum(['builtin', 'cli', 'api']),
  refreshedAt: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  models: z.array(harnessModelInput).max(2000).default([])
});

export type HarnessProviderCatalog = z.infer<typeof harnessProviderCatalogInput>;

function providerCatalogSlot() {
  return harnessProviderCatalogInput.nullable().default(null);
}

export const harnessModelCatalogInput = z.object({
  providers: z.object({
    claude: providerCatalogSlot(),
    codex: providerCatalogSlot(),
    opencode: providerCatalogSlot(),
  }).default({ claude: null, codex: null, opencode: null })
});

export type HarnessModelCatalog = z.infer<typeof harnessModelCatalogInput>;

export function emptyHarnessModelCatalog(): HarnessModelCatalog {
  return { providers: { claude: null, codex: null, opencode: null } };
}

// Claude Code accepts aliases for the latest model in each family plus full
// model IDs, and its `--effort` flag takes these levels. New full IDs can be
// typed into a preset directly; aliases are the stable options.
const CLAUDE_REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function builtinClaudeCatalog(refreshedAt: string): HarnessProviderCatalog {
  const reasoning = [...CLAUDE_REASONING_LEVELS];
  const aliases: Array<{ id: string; label: string }> = [
    { id: 'fable', label: 'Fable (latest)' },
    { id: 'opus', label: 'Opus (latest)' },
    { id: 'sonnet', label: 'Sonnet (latest)' },
    { id: 'haiku', label: 'Haiku (latest)' }
  ];
  return {
    harness: 'claude',
    source: 'builtin',
    refreshedAt,
    error: null,
    models: aliases.map((alias) => ({ ...alias, reasoning, defaultReasoning: null }))
  };
}

interface ClaudeCatalogModel {
  value?: unknown;
  displayName?: unknown;
  supportedEffortLevels?: unknown;
}

// The `initialize` control response carries `models: [...]`. The `default`
// entry is omitted because a preset without a model already uses it.
export function parseClaudeCatalog(value: unknown): HarnessModel[] {
  const models = asRecord(value)?.models;
  if (!Array.isArray(models)) throw new Error('Claude model catalog is not valid JSON');
  const parsed: HarnessModel[] = [];
  for (const entry of models as ClaudeCatalogModel[]) {
    const record = asRecord(entry);
    const id = typeof record?.value === 'string' ? record.value.trim() : '';
    if (!record || !id || id === 'default') continue;
    const label = typeof record.displayName === 'string' && record.displayName.trim() ? record.displayName.trim() : id;
    const reasoning = Array.isArray(record.supportedEffortLevels)
      ? (record.supportedEffortLevels as unknown[]).filter((level): level is string => typeof level === 'string' && level.trim().length > 0)
      : [];
    parsed.push({ id, label, reasoning, defaultReasoning: null });
  }
  if (!parsed.length) throw new Error('Claude model catalog has no selectable models');
  return parsed;
}

interface CodexCatalogModel {
  slug?: unknown;
  display_name?: unknown;
  visibility?: unknown;
  default_reasoning_level?: unknown;
  supported_reasoning_levels?: unknown;
  service_tiers?: unknown;
}

// `codex debug models` prints `{ models: [...] }`. Only entries marked for the
// model picker are offered; hidden/internal entries stay out of presets.
export function parseCodexCatalog(value: unknown): HarnessModel[] {
  const models = asRecord(value)?.models;
  if (!Array.isArray(models)) throw new Error('Codex model catalog is not valid JSON');
  const parsed: HarnessModel[] = [];
  for (const entry of models as CodexCatalogModel[]) {
    const record = asRecord(entry);
    if (!record) continue;
    const slug = typeof record.slug === 'string' ? record.slug.trim() : '';
    if (!slug || record.visibility !== 'list') continue;
    const label = typeof record.display_name === 'string' && record.display_name.trim() ? record.display_name.trim() : slug;
    const reasoning = Array.isArray(record.supported_reasoning_levels)
      ? (record.supported_reasoning_levels as unknown[])
          .map((level) => asRecord(level)?.effort)
          .filter((effort): effort is string => typeof effort === 'string' && effort.trim().length > 0)
      : [];
    const defaultReasoning = typeof record.default_reasoning_level === 'string' && record.default_reasoning_level.trim()
      ? record.default_reasoning_level.trim()
      : null;
    const serviceTiers = Array.isArray(record.service_tiers)
      ? (record.service_tiers as unknown[]).map(asRecord).flatMap((tier) => typeof tier?.id === 'string' && tier.id.trim()
        ? [{ id: tier.id.trim(), label: typeof tier.name === 'string' && tier.name.trim() ? tier.name.trim() : tier.id.trim() }]
        : [])
      : [];
    parsed.push({ id: slug, label, reasoning, defaultReasoning, serviceTiers });
  }
  if (!parsed.length) throw new Error('Codex model catalog has no selectable models');
  return parsed;
}

interface OpenCodeCatalogModel {
  id?: unknown;
  modelID?: unknown;
  providerID?: unknown;
  name?: unknown;
  enabled?: unknown;
  variants?: unknown;
}

// `GET /api/model` returns `{ data: [...] }`; each entry is a provider/model
// pair with optional reasoning-effort variants.
export function parseOpenCodeCatalog(value: unknown): HarnessModel[] {
  const data = asRecord(value)?.data;
  if (!Array.isArray(data)) throw new Error('OpenCode model catalog is not valid JSON');
  const parsed: HarnessModel[] = [];
  for (const entry of data as OpenCodeCatalogModel[]) {
    const record = asRecord(entry);
    if (!record) continue;
    const providerID = typeof record.providerID === 'string' ? record.providerID.trim() : '';
    const modelID = typeof record.modelID === 'string' ? record.modelID.trim() : typeof record.id === 'string' ? record.id.trim() : '';
    if (!providerID || !modelID || record.enabled === false) continue;
    const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : modelID;
    const reasoning = Array.isArray(record.variants)
      ? (record.variants as unknown[])
          .map((variant) => asRecord(variant)?.id)
          .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      : [];
    parsed.push({ id: `${providerID}/${modelID}`, label: name, reasoning, defaultReasoning: null });
  }
  if (!parsed.length) throw new Error('OpenCode model catalog has no models');
  return parsed.sort((a, b) => a.id.localeCompare(b.id));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}
