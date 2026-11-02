// The model, reasoning and speed fields a harness profile is set up with.
// Bots are set up with the same fields, so both editors share them. The
// catalog shapes mirror app/Harness/ModelCatalog.

export type ProfileHarness = 'claude' | 'codex' | 'opencode';

export interface CatalogModel {
  id: string;
  label: string;
  reasoning: string[];
  defaultReasoning: string | null;
  serviceTiers?: Array<{ id: string; label: string }>;
}

export interface ProviderCatalog {
  harness: ProfileHarness;
  source: string;
  refreshedAt: string | null;
  error: string | null;
  models: CatalogModel[];
}

export interface ModelCatalog {
  providers: Record<ProfileHarness, ProviderCatalog | null>;
}

// What the fields hold while they're edited. `model` is a catalog ID or one
// of the two choices below; reasoning and speed use '' for no override.
export interface ProfileFieldsState {
  harness: ProfileHarness;
  model: string;
  customModel: string;
  reasoning: string;
  serviceTier: string;
}

export interface ProfileSettingsValue {
  model: string | null;
  reasoning: string | null;
  serviceTier: string | null;
}

export const CUSTOM_MODEL = '__custom__';
export const DEFAULT_MODEL = '__default__';
export const PROFILE_HARNESSES: ProfileHarness[] = ['claude', 'codex', 'opencode'];

export function emptyModelCatalog(): ModelCatalog {
  return { providers: { claude: null, codex: null, opencode: null } };
}

export function modelsFor(catalog: ModelCatalog, harness: ProfileHarness): CatalogModel[] {
  return catalog.providers[harness]?.models ?? [];
}

export function fieldsFrom(catalog: ModelCatalog, harness: ProfileHarness, value: ProfileSettingsValue): ProfileFieldsState {
  const known = value.model !== null && modelsFor(catalog, harness).some((model) => model.id === value.model);
  return {
    harness,
    model: value.model === null ? DEFAULT_MODEL : known ? value.model : CUSTOM_MODEL,
    customModel: value.model !== null && !known ? value.model : '',
    reasoning: value.reasoning ?? '',
    serviceTier: value.serviceTier ?? ''
  };
}

// The settings to save, or an error to show.
export function settingsFrom(fields: ProfileFieldsState): ProfileSettingsValue | { error: string } {
  const model = fields.model === DEFAULT_MODEL ? null : fields.model === CUSTOM_MODEL ? fields.customModel.trim() : fields.model;
  if (fields.model === CUSTOM_MODEL && !model) return { error: 'Enter a custom model ID.' };
  return {
    model,
    reasoning: model === null ? null : fields.reasoning.trim() || null,
    serviceTier: fields.harness === 'codex' ? fields.serviceTier || null : null
  };
}

function chosenModel(fields: ProfileFieldsState): string | null {
  if (fields.model === DEFAULT_MODEL) return null;
  return fields.model === CUSTOM_MODEL ? fields.customModel.trim() || null : fields.model;
}

export function reasoningFor(catalog: ModelCatalog, fields: ProfileFieldsState): string[] {
  if (fields.model === DEFAULT_MODEL) return [];
  const id = chosenModel(fields);
  return modelsFor(catalog, fields.harness).find((model) => model.id === id)?.reasoning ?? builtinReasoning(fields.harness);
}

// Without a chosen model, offer every tier any listed model supports.
export function tiersFor(catalog: ModelCatalog, harness: ProfileHarness, modelId: string | null): Array<{ id: string; label: string }> {
  const models = modelId === null ? modelsFor(catalog, harness) : modelsFor(catalog, harness).filter((model) => model.id === modelId);
  const tiers = new Map<string, string>();
  for (const model of models) for (const tier of model.serviceTiers ?? []) tiers.set(tier.id, tier.label);
  return [...tiers].map(([id, label]) => ({ id, label }));
}

export function modelChoices(catalog: ModelCatalog, harness: ProfileHarness): Array<{ value: string; label: string }> {
  return [
    { value: DEFAULT_MODEL, label: 'Harness default (no override)' },
    ...modelsFor(catalog, harness).map((model) => ({ value: model.id, label: model.label })),
    { value: CUSTOM_MODEL, label: 'Custom model ID…' }
  ];
}

export function reasoningChoices(catalog: ModelCatalog, fields: ProfileFieldsState): Array<{ value: string; label: string }> {
  const levels = reasoningFor(catalog, fields);
  return [
    { value: '', label: 'Model default' },
    ...levels.map((level) => ({ value: level, label: level })),
    ...(fields.reasoning && !levels.includes(fields.reasoning) ? [{ value: fields.reasoning, label: fields.reasoning }] : [])
  ];
}

export function speedChoices(catalog: ModelCatalog, fields: ProfileFieldsState): Array<{ value: string; label: string }> {
  const tiers = tiersFor(catalog, fields.harness, chosenModel(fields));
  return [
    { value: '', label: 'Harness default' },
    { value: 'default', label: 'Standard' },
    ...tiers.map((tier) => ({ value: tier.id, label: tier.label })),
    ...(fields.serviceTier && fields.serviceTier !== 'default' && !tiers.some((tier) => tier.id === fields.serviceTier) ? [{ value: fields.serviceTier, label: fields.serviceTier }] : [])
  ];
}

// A reasoning level the new model doesn't offer goes back to its default.
export function changeModel(catalog: ModelCatalog, fields: ProfileFieldsState, model: string): void {
  fields.model = model;
  if (fields.reasoning && !reasoningFor(catalog, fields).includes(fields.reasoning)) fields.reasoning = '';
}

export function speedLabel(catalog: ModelCatalog, harness: ProfileHarness, tier: string): string {
  if (tier === 'default') return 'Standard';
  return tiersFor(catalog, harness, null).find((candidate) => candidate.id === tier)?.label ?? tier;
}

export function modelLabel(catalog: ModelCatalog, harness: ProfileHarness, modelId: string | null): string {
  if (modelId === null) return 'Harness default';
  return modelsFor(catalog, harness).find((model) => model.id === modelId)?.label ?? modelId;
}

// The settings in one line, as a profile list shows them.
export function settingsSummary(catalog: ModelCatalog, harness: ProfileHarness, value: ProfileSettingsValue): string {
  return `${modelLabel(catalog, harness, value.model)}${value.reasoning ? ` · ${value.reasoning}` : ''}${value.serviceTier ? ` · ${speedLabel(catalog, harness, value.serviceTier)}` : ''}`;
}

function builtinReasoning(harness: ProfileHarness): string[] {
  return harness === 'claude' ? ['low', 'medium', 'high', 'xhigh', 'max'] : [];
}
