import { z } from 'zod';
import type { HarnessId } from './HarnessProvider';

// Named model/reasoning presets a user configures per agent harness. Presets are
// resolved to provider flags at launch time (see HarnessLauncher). `rawpty` has
// no model surface, so presets only cover agent CLIs.
export const presetHarnessInput = z.enum(['claude', 'codex', 'opencode', 'amp']);
export type PresetHarness = z.infer<typeof presetHarnessInput>;

export const PRESET_HARNESSES = presetHarnessInput.options;

export const harnessPresetInput = z.object({
  id: z.string().trim().min(1).max(80),
  harness: presetHarnessInput,
  name: z.string().trim().min(1).max(60),
  // Null keeps the CLI's own configured model, so "no override" is an explicit,
  // selectable preset rather than an absence of presets.
  model: z.string().trim().min(1).max(160).nullable().default(null),
  reasoning: z.string().trim().min(1).max(60).nullable().default(null),
  // Codex service tier ID, such as `priority` for Fast or `default` for
  // Standard. Null keeps the CLI's own configured tier.
  serviceTier: z.string().trim().min(1).max(60).nullable().default(null)
});

export type HarnessPreset = z.infer<typeof harnessPresetInput>;

const defaultPresetIds = z.object({
  claude: z.string().nullable().default(null),
  codex: z.string().nullable().default(null),
  opencode: z.string().nullable().default(null),
  amp: z.string().nullable().default(null)
});

export const harnessPresetSettingsInput = z.object({
  presets: z.array(harnessPresetInput).max(100).default([]),
  defaultPresetIdByHarness: defaultPresetIds.default({ claude: null, codex: null, opencode: null, amp: null })
}).superRefine((value, context) => {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const [index, preset] of value.presets.entries()) {
    if (ids.has(preset.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['presets', index, 'id'], message: `duplicate preset id: ${preset.id}` });
    }
    ids.add(preset.id);
    const nameKey = `${preset.harness}:${preset.name.toLowerCase()}`;
    if (names.has(nameKey)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['presets', index, 'name'], message: `duplicate preset name for ${preset.harness}: ${preset.name}` });
    }
    names.add(nameKey);
    if (preset.model === null && preset.reasoning !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['presets', index, 'reasoning'], message: 'reasoning requires a model' });
    }
    if (preset.harness === 'amp' && (preset.reasoning !== null || (preset.model !== null && !['low', 'medium', 'high', 'ultra'].includes(preset.model)))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['presets', index], message: 'Amp presets select a built-in mode without a reasoning override' });
    }
    if (preset.harness !== 'codex' && preset.serviceTier !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['presets', index, 'serviceTier'], message: 'only Codex presets select a service tier' });
    }
  }
  for (const harness of PRESET_HARNESSES) {
    const id = value.defaultPresetIdByHarness[harness];
    if (id === null) continue;
    const preset = value.presets.find((candidate) => candidate.id === id);
    if (!preset || preset.harness !== harness) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultPresetIdByHarness', harness],
        message: `default preset for ${harness} does not exist`
      });
    }
  }
});

export type HarnessPresetSettings = z.infer<typeof harnessPresetSettingsInput>;

export function emptyHarnessPresetSettings(): HarnessPresetSettings {
  return { presets: [], defaultPresetIdByHarness: { claude: null, codex: null, opencode: null, amp: null } };
}

// First-run defaults: one "Default" preset per harness that passes no model or
// reasoning flags, so each CLI keeps using its own configuration until the user
// chooses otherwise. IDs are stable so the seed can be returned without writing.
export function seededHarnessPresetSettings(): HarnessPresetSettings {
  const presets: HarnessPreset[] = PRESET_HARNESSES.map((harness) => ({
    id: `preset_default_${harness}`,
    harness,
    name: 'Default',
    model: null,
    reasoning: null,
    serviceTier: null
  }));
  return {
    presets,
    defaultPresetIdByHarness: {
      claude: 'preset_default_claude',
      codex: 'preset_default_codex',
      opencode: 'preset_default_opencode',
      amp: 'preset_default_amp'
    }
  };
}

export function findPresetByRef(settings: HarnessPresetSettings, ref: string, harness?: PresetHarness | null): HarnessPreset | null {
  const needle = ref.trim().toLowerCase();
  const scoped = settings.presets.filter((preset) => !harness || preset.harness === harness);
  return scoped.find((preset) => preset.id === ref) ?? scoped.find((preset) => preset.name.toLowerCase() === needle) ?? null;
}

export function findPresetsByName(settings: HarnessPresetSettings, ref: string): HarnessPreset[] {
  const needle = ref.trim().toLowerCase();
  return settings.presets.filter((preset) => preset.name.toLowerCase() === needle);
}

export function defaultPresetFor(settings: HarnessPresetSettings, harness: PresetHarness): HarnessPreset | null {
  const id = settings.defaultPresetIdByHarness[harness];
  return id ? settings.presets.find((preset) => preset.id === id && preset.harness === harness) ?? null : null;
}

function availablePresetNames(settings: HarnessPresetSettings, harness?: PresetHarness | null): string {
  const names = settings.presets
    .filter((preset) => !harness || preset.harness === harness)
    .map((preset) => `${preset.harness}/${preset.name}`);
  return names.length ? names.join(', ') : 'none';
}

export interface HarnessLaunchSelection {
  harness: HarnessId;
  model: string | null;
  reasoning: string | null;
  serviceTier: string | null;
  presetId: string | null;
  presetName: string | null;
}

export interface ResolveHarnessLaunchInput {
  settings: HarnessPresetSettings;
  harness?: HarnessId | null;
  preset?: string | null;
  model?: string | null;
  reasoning?: string | null;
  serviceTier?: string | null;
}

// Resolve the model/reasoning a launch should use:
// explicit model/reasoning > named or ID preset > per-harness default > none.
// An explicit service tier overrides the preset's; otherwise the preset that
// applies supplies it.
// A preset can also supply the harness when the caller did not choose one.
export function resolveHarnessLaunchSelection(input: ResolveHarnessLaunchInput): HarnessLaunchSelection {
  const { settings } = input;
  const explicitModel = input.model?.trim() || null;
  const explicitReasoning = input.reasoning?.trim() || null;
  const explicitServiceTier = input.serviceTier?.trim() || null;
  const harnessRef = input.harness ?? null;
  const presetRef = input.preset?.trim() || null;

  let preset: HarnessPreset | null = null;
  if (presetRef) {
    const harnessScope = harnessRef && harnessRef !== 'rawpty' ? harnessRef : null;
    const idMatch = settings.presets.find((candidate) => candidate.id === presetRef && (!harnessScope || candidate.harness === harnessScope));
    if (idMatch) {
      preset = idMatch;
    } else if (harnessRef) {
      // An explicit harness (including rawpty, which has no presets) scopes the
      // name lookup; it never falls back to another harness.
      preset = harnessScope ? findPresetByRef(settings, presetRef, harnessScope) : null;
    } else {
      const matches = findPresetsByName(settings, presetRef);
      if (matches.length > 1) {
        throw new Error(`preset '${presetRef}' exists for multiple harnesses (${matches.map((item) => item.harness).join(', ')}); pass harness to disambiguate`);
      }
      preset = matches[0] ?? null;
    }
    if (!preset) {
      throw new Error(`unknown preset '${presetRef}'. Available presets: ${availablePresetNames(settings, harnessScope)}`);
    }
  }

  const harness = harnessRef ?? preset?.harness ?? null;
  if (!harness) {
    throw new Error('harness or preset is required');
  }

  if (explicitModel) {
    return {
      harness,
      model: explicitModel,
      reasoning: explicitReasoning,
      serviceTier: explicitServiceTier ?? preset?.serviceTier ?? null,
      presetId: preset?.id ?? null,
      presetName: preset?.name ?? null
    };
  }

  if (preset) {
    return {
      harness,
      model: preset.model,
      reasoning: preset.reasoning,
      serviceTier: explicitServiceTier ?? preset.serviceTier,
      presetId: preset.id,
      presetName: preset.name
    };
  }

  if (harness !== 'rawpty') {
    const fallback = defaultPresetFor(settings, harness);
    if (fallback) {
      return {
        harness,
        model: fallback.model,
        reasoning: fallback.reasoning,
        serviceTier: explicitServiceTier ?? fallback.serviceTier,
        presetId: fallback.id,
        presetName: fallback.name
      };
    }
  }

  return { harness, model: null, reasoning: null, serviceTier: explicitServiceTier, presetId: null, presetName: null };
}
