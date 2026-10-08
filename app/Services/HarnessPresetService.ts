import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  findPresetByRef,
  presetHarnessInput,
  type HarnessPreset,
  type HarnessPresetSettings,
  type PresetHarness
} from '../Harness/HarnessPresets';
import type { SettingsService } from './SettingsService';

const presetName = z.string().trim().min(1).max(60);
const presetModel = z.string().trim().min(1).max(160).nullable();
const presetReasoning = z.string().trim().min(1).max(60).nullable();
const presetServiceTier = z.string().trim().min(1).max(60).nullable();

export const harnessPresetCreateInput = z.object({
  harness: presetHarnessInput,
  name: presetName,
  // Omit or pass null to keep the harness's own configured model.
  model: presetModel.optional().default(null),
  reasoning: presetReasoning.optional().default(null),
  serviceTier: presetServiceTier.optional().default(null),
  default: z.boolean().default(false)
});

export const harnessPresetUpdateInput = z.object({
  ref: z.string().trim().min(1).max(160),
  harness: presetHarnessInput.optional(),
  name: presetName.optional(),
  model: presetModel.optional(),
  reasoning: presetReasoning.optional(),
  serviceTier: presetServiceTier.optional(),
  default: z.boolean().optional()
}).refine((value) => value.name !== undefined || value.model !== undefined || value.reasoning !== undefined || value.serviceTier !== undefined || value.default !== undefined,
  { message: 'no preset changes supplied' });

export const harnessPresetRemoveInput = z.object({
  ref: z.string().trim().min(1).max(160),
  harness: presetHarnessInput.optional()
});

export interface HarnessPresetDescription {
  presets: Array<HarnessPreset & { default: boolean }>;
  defaultPresetIdByHarness: HarnessPresetSettings['defaultPresetIdByHarness'];
}

// CRUD over user-configured presets. IDs are server-generated; callers address
// presets by ID or case-insensitive name. Every mutation re-validates the whole
// document through SettingsService, so defaults and name collisions stay sound.
export class HarnessPresetService {
  constructor(private readonly settings: SettingsService) {}

  list(): HarnessPresetSettings {
    return this.settings.harnessPresets();
  }

  // Agent-facing view: each preset carries its default flag so callers do not
  // have to join against defaultPresetIdByHarness.
  describe(): HarnessPresetDescription {
    const settings = this.list();
    return {
      presets: settings.presets.map((preset) => ({
        ...preset,
        default: settings.defaultPresetIdByHarness[preset.harness] === preset.id
      })),
      defaultPresetIdByHarness: settings.defaultPresetIdByHarness
    };
  }

  create(raw: unknown): HarnessPresetSettings {
    const input = harnessPresetCreateInput.parse(raw);
    const current = this.list();
    this.assertNameAvailable(current, input.harness, input.name, null);
    if (input.model === null && input.reasoning !== null) {
      throw new Error('reasoning requires a model');
    }
    const preset: HarnessPreset = {
      id: `preset_${randomUUID()}`,
      harness: input.harness,
      name: input.name,
      model: input.model,
      reasoning: input.model === null ? null : input.reasoning,
      serviceTier: input.serviceTier
    };
    const defaults = { ...current.defaultPresetIdByHarness };
    if (input.default || defaults[input.harness] === null) {
      defaults[input.harness] = preset.id;
    }
    return this.settings.updateHarnessPresets({ presets: [...current.presets, preset], defaultPresetIdByHarness: defaults });
  }

  update(raw: unknown): HarnessPresetSettings {
    const input = harnessPresetUpdateInput.parse(raw);
    const current = this.list();
    const preset = this.requirePreset(current, input.ref, input.harness);
    const name = input.name ?? preset.name;
    this.assertNameAvailable(current, preset.harness, name, preset.id);
    const model = input.model === undefined ? preset.model : input.model;
    if (model === null && input.reasoning) {
      throw new Error('reasoning requires a model');
    }
    const updated: HarnessPreset = {
      ...preset,
      name,
      model,
      reasoning: model === null ? null : input.reasoning === undefined ? preset.reasoning : input.reasoning,
      serviceTier: input.serviceTier === undefined ? preset.serviceTier : input.serviceTier
    };
    const defaults = { ...current.defaultPresetIdByHarness };
    if (input.default === true) {
      defaults[preset.harness] = preset.id;
    } else if (input.default === false && defaults[preset.harness] === preset.id) {
      defaults[preset.harness] = null;
    }
    return this.settings.updateHarnessPresets({
      presets: current.presets.map((candidate) => candidate.id === preset.id ? updated : candidate),
      defaultPresetIdByHarness: defaults
    });
  }

  remove(raw: unknown): HarnessPresetSettings {
    const input = harnessPresetRemoveInput.parse(raw);
    const current = this.list();
    const preset = this.requirePreset(current, input.ref, input.harness);
    const remaining = current.presets.filter((candidate) => candidate.id !== preset.id);
    const defaults = { ...current.defaultPresetIdByHarness };
    if (defaults[preset.harness] === preset.id) {
      defaults[preset.harness] = remaining.find((candidate) => candidate.harness === preset.harness)?.id ?? null;
    }
    return this.settings.updateHarnessPresets({ presets: remaining, defaultPresetIdByHarness: defaults });
  }

  private requirePreset(settings: HarnessPresetSettings, ref: string, harness?: PresetHarness): HarnessPreset {
    const preset = findPresetByRef(settings, ref, harness ?? null);
    if (preset) return preset;
    const available = settings.presets
      .filter((candidate) => !harness || candidate.harness === harness)
      .map((candidate) => `${candidate.harness}/${candidate.name}`);
    throw new Error(`unknown preset '${ref}'. Available presets: ${available.length ? available.join(', ') : 'none'}`);
  }

  private assertNameAvailable(settings: HarnessPresetSettings, harness: PresetHarness, name: string, exceptId: string | null): void {
    const clash = settings.presets.find((candidate) =>
      candidate.harness === harness && candidate.id !== exceptId && candidate.name.toLowerCase() === name.toLowerCase());
    if (clash) {
      throw new Error(`a ${harness} preset named '${name}' already exists`);
    }
  }
}
