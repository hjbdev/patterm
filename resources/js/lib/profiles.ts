import { lookFor, type ProfileLook } from './faces';
import { harnessLabel } from './harnessLabels';

// Profiles are harness presets with a face. The backend and agent tools keep
// calling them presets, so IDs and names stay valid in spawn_agent calls.
// The shapes mirror app/Harness/HarnessPresets, which the renderer can't
// import without its Node dependencies.
type PresetHarness = 'claude' | 'codex' | 'opencode';

export interface Profile {
  id: string;
  harness: PresetHarness;
  name: string;
  model: string | null;
  reasoning: string | null;
  serviceTier: string | null;
  look: ProfileLook | null;
}

export interface ProfileSettings {
  presets: Profile[];
  defaultPresetIdByHarness: Record<PresetHarness, string | null>;
}

const HARNESS_ORDER: readonly string[] = ['claude', 'codex', 'opencode'];

// Each CLI's seeded "Default" preset is the plain CLI, so it shows under the
// CLI's name instead of three rows all called Default.
export function profileName(profile: Pick<Profile, 'name' | 'harness'>): string {
  return profile.name.toLowerCase() === 'default' ? harnessLabel(profile.harness) : profile.name;
}

// Names a model ID from the model catalog, or null when it isn't listed.
export type ModelLabel = (harness: string, model: string) => string | null;

// The model's catalog name, or its ID without the provider prefix, then the
// reasoning effort.
export function profileDetail(profile: Pick<Profile, 'harness' | 'model' | 'reasoning'>, modelLabel?: ModelLabel): string {
  const model = profile.model ? modelLabel?.(profile.harness, profile.model) ?? profile.model.slice(profile.model.lastIndexOf('/') + 1) : 'Default model';
  return profile.reasoning ? `${model} · ${profile.reasoning}` : model;
}

export interface RosterRow {
  key: string;
  harness: string;
  // Null launches the harness's own default, as on another host.
  presetId: string | null;
  name: string;
  detail: string;
  look: ProfileLook;
}

// One flat list: each installed CLI's default profile first, then the rest in
// the order they were made. A CLI with no profiles still gets a row. On
// another host the profiles here don't apply, so each CLI there launches with
// that host's default.
export function rosterRows(settings: ProfileSettings, installed: readonly string[], remoteHost: string | null, modelLabel?: ModelLabel): RosterRow[] {
  const harnesses = HARNESS_ORDER.filter((harness) => installed.includes(harness));
  if (remoteHost) {
    return harnesses.map((harness) => ({
      key: `remote:${harness}`, harness, presetId: null, name: harnessLabel(harness), detail: `${remoteHost}’s default`,
      look: lookFor({ id: `preset_default_${harness}` })
    }));
  }
  const row = (profile: Profile): RosterRow => ({ key: profile.id, harness: profile.harness, presetId: profile.id, name: profileName(profile), detail: profileDetail(profile, modelLabel), look: lookFor(profile) });
  const defaults = harnesses.map((harness) => {
    const id = settings.defaultPresetIdByHarness[harness as PresetHarness];
    const profile = settings.presets.find((candidate) => candidate.id === id && candidate.harness === harness);
    if (profile) return row(profile);
    const fallback = settings.presets.find((candidate) => candidate.harness === harness);
    return fallback ? row(fallback) : { key: `cli:${harness}`, harness, presetId: null, name: harnessLabel(harness), detail: 'Default model', look: lookFor({ id: `preset_default_${harness}` }) };
  });
  const shown = new Set(defaults.map((entry) => entry.key));
  const rest = settings.presets.filter((profile) => harnesses.includes(profile.harness) && !shown.has(profile.id)).map(row);
  return [...defaults, ...rest];
}

// A first message being written keeps its profile while that profile is
// listed. After the host changes, it moves to the same CLI there, or to none
// when that host doesn't have the CLI.
export function composedRow(rows: readonly RosterRow[], row: RosterRow): RosterRow | null {
  return rows.find((candidate) => candidate.key === row.key) ?? rows.find((candidate) => candidate.harness === row.harness) ?? null;
}
