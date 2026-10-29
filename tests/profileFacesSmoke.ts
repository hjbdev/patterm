import assert from 'node:assert/strict';

import { harnessPresetSettingsInput, seededHarnessPresetSettings } from '../app/Harness/HarnessPresets';
import { HarnessPresetService } from '../app/Services/HarnessPresetService';
import type { SettingsService } from '../app/Services/SettingsService';
import {
  FACE_COLORS,
  FACE_EYES,
  FACE_HATS,
  FACE_MARKINGS,
  FACE_MOUTHS,
  FACE_SHAPES,
  faceMarkup,
  lookFor,
  randomLook,
  type ProfileLook
} from '../resources/js/lib/faces';
import { harnessLaunches } from '../resources/js/lib/harnessLaunches';
import { composedRow, profileDetail, profileName, rosterRows, type Profile, type ProfileSettings } from '../resources/js/lib/profiles';

const base: ProfileLook = { color: 'pink', shape: 'egg', finish: 'soft', marking: 'belly', eyes: 'happy', mouth: 'cat', cheeks: true, hat: 'sprout', accent: 'lime', idle: 'bob' };

// Every part draws on every shape, at sidebar and preview sizes, without a
// hole in the markup.
for (const shape of FACE_SHAPES) {
  for (const hat of FACE_HATS) {
    for (const size of [16, 24, 96]) {
      const { body } = faceMarkup({ ...base, shape, hat }, size, `t-${shape}-${hat}`);
      assert.doesNotMatch(body, /undefined|NaN/, `${shape} with ${hat} at ${size}px`);
      assert.match(body, /^<defs>/);
    }
  }
}
for (const eyes of FACE_EYES) for (const mouth of FACE_MOUTHS) for (const marking of FACE_MARKINGS) {
  assert.doesNotMatch(faceMarkup({ ...base, eyes, mouth, marking }, 24, 't').body, /undefined|NaN/, `${eyes}, ${mouth}, ${marking}`);
}
for (const color of FACE_COLORS) assert.doesNotMatch(faceMarkup({ ...base, color, accent: color, finish: 'glow' }, 24, 't').filter ?? '', /undefined|NaN/);

// Gradient and clip IDs come from the caller, so two faces never share them.
assert.match(faceMarkup(base, 24, 'face-a').body, /id="face-a-g".*url\(#face-a-g\)/s);
// Tall hats shrink the face to stay in its box; hatless faces aren't moved.
assert.match(faceMarkup({ ...base, shape: 'circle', hat: 'bunny' }, 24, 't').body, /<g transform="translate\(12 23\.6\) scale\(0\.827\)/);
assert.match(faceMarkup({ ...base, hat: 'none' }, 24, 't').body, /<g>/);
// Small faces drop the mouth and cheeks.
assert.doesNotMatch(faceMarkup(base, 16, 't').body, /ellipse cx="7\.4"/);
assert.notEqual(faceMarkup(base, 16, 't').body.length, faceMarkup(base, 24, 't').body.length);
assert.equal(faceMarkup({ ...base, finish: 'flat' }, 24, 't').filter, null);

// A profile without a face gets the same one every time; the plain CLIs have
// designed ones, and a saved face wins.
assert.deepEqual(randomLook(7), randomLook(7));
assert.deepEqual(lookFor({ id: 'preset_abc' }), lookFor({ id: 'preset_abc', look: null }));
assert.notDeepEqual(lookFor({ id: 'preset_abc' }), lookFor({ id: 'preset_abd' }));
assert.equal(lookFor({ id: 'preset_default_claude' }).color, 'orange');
assert.equal(lookFor({ id: 'preset_default_claude', look: base }).color, 'pink');
for (let seed = 0; seed < 200; seed++) {
  const look = randomLook(seed);
  assert.doesNotMatch(faceMarkup(look, 20, 't').body, /undefined|NaN/);
  assert.equal(harnessPresetSettingsInput.parse({ presets: [{ id: 'p', harness: 'claude', name: 'P', look }] }).presets[0]?.look?.shape, look.shape);
}

// Names and details: each CLI's Default shows as the CLI, models lose their
// provider prefix.
assert.equal(profileName({ name: 'Default', harness: 'claude' }), 'Claude Code');
assert.equal(profileName({ name: 'Fable', harness: 'claude' }), 'Fable');
assert.equal(profileDetail({ harness: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', reasoning: 'max' }), 'deepseek-v4.1-flash · max');
assert.equal(profileDetail({ harness: 'claude', model: null, reasoning: null }), 'Default model');
// The catalog's name wins when it lists the model.
const label = (harness: string, model: string) => harness === 'claude' && model === 'fable' ? 'Fable 5.1' : null;
assert.equal(profileDetail({ harness: 'claude', model: 'fable', reasoning: 'high' }, label), 'Fable 5.1 · high');
assert.equal(profileDetail({ harness: 'codex', model: 'fable', reasoning: null }, label), 'fable');

// One flat list: defaults first in CLI order, then the rest as made, only for
// installed CLIs. A CLI with no profiles still gets a row.
const profile = (id: string, harness: Profile['harness'], name: string, model: string | null = null): Profile => ({ id, harness, name, model, reasoning: null, serviceTier: null, look: null });
const settings: ProfileSettings = {
  presets: [profile('fable', 'claude', 'Fable', 'fable'), profile('d_codex', 'codex', 'Default', 'gpt-6.1-sol'), profile('d_claude', 'claude', 'Default'), profile('smarty', 'codex', 'Smartypants'), profile('work', 'opencode', 'Workhorse')],
  defaultPresetIdByHarness: { claude: 'd_claude', codex: 'd_codex', opencode: null }
};
assert.deepEqual(rosterRows(settings, ['claude', 'codex', 'opencode'], null).map((row) => row.name), ['Claude Code', 'Codex', 'Workhorse', 'Fable', 'Smartypants']);
assert.deepEqual(rosterRows(settings, ['codex'], null).map((row) => row.presetId), ['d_codex', 'smarty']);
assert.deepEqual(rosterRows({ presets: [], defaultPresetIdByHarness: { claude: null, codex: null, opencode: null } }, ['opencode'], null).map((row) => [row.name, row.presetId]), [['OpenCode', null]]);
// Another host launches each CLI with its own default, so local profiles don't apply.
assert.deepEqual(rosterRows(settings, ['claude', 'codex'], 'workstation').map((row) => [row.name, row.presetId, row.detail]), [['Claude Code', null, 'workstation’s default'], ['Codex', null, 'workstation’s default']]);

// A first message keeps its profile while listed, moves to the same CLI on
// another host, and has none where that CLI is missing.
const local = rosterRows(settings, ['claude', 'codex'], null);
const fable = local.find((row) => row.presetId === 'fable')!;
assert.equal(composedRow(local, fable)?.presetId, 'fable');
assert.equal(composedRow(rosterRows(settings, ['claude', 'codex'], 'workstation'), fable)?.key, 'remote:claude');
assert.equal(composedRow(rosterRows(settings, ['codex'], 'workstation'), fable), null);
assert.equal(composedRow(local, composedRow(rosterRows(settings, ['claude'], 'workstation'), fable)!)?.presetId, 'd_claude');

// Stored faces: seeded presets have none, an unreadable one falls back
// instead of failing the list, and agents don't see faces.
assert.equal(seededHarnessPresetSettings().presets[0]?.look, null);
const legacy = harnessPresetSettingsInput.parse({ presets: [{ id: 'old', harness: 'codex', name: 'Old' }] });
assert.equal(legacy.presets[0]?.look, null);
const unreadable = harnessPresetSettingsInput.parse({ presets: [{ id: 'new', harness: 'codex', name: 'New', look: { ...base, hat: 'top-hat' } }] });
assert.equal(unreadable.presets[0]?.look, null);
let stored = harnessPresetSettingsInput.parse({ presets: [{ id: 'fable', harness: 'claude', name: 'Fable', look: base }], defaultPresetIdByHarness: { claude: 'fable' } });
const service = new HarnessPresetService({ harnessPresets: () => stored, updateHarnessPresets: (value: unknown) => (stored = harnessPresetSettingsInput.parse(value)) } as unknown as SettingsService);
assert.equal('look' in service.describe().presets[0]!, false);
assert.equal(service.list().presets[0]?.look?.hat, 'sprout');
service.update({ ref: 'Fable', reasoning: 'high', model: 'fable' });
assert.equal(service.list().presets[0]?.look?.hat, 'sprout', 'Editing a preset keeps its face');
service.create({ harness: 'codex', name: 'Smartypants' });
assert.equal(service.list().presets[1]?.look, null);

// A first message written in the launch menu reaches the launch.
async function launchesCarryFirstMessage(): Promise<void> {
  const sent: Array<Record<string, unknown>> = [];
  await harnessLaunches.start({ projectId: 'p1', targetProjectId: 'p1', harness: 'claude', preset: 'fable', initialPrompt: 'Fix the scroll' }, async (args) => { sent.push(args); return { session_id: 's1' }; }).finished;
  await harnessLaunches.start({ projectId: 'p1', targetProjectId: 'p1', harness: 'claude' }, async (args) => { sent.push(args); return { session_id: 's2' }; }).finished;
  assert.equal(sent[0]?.initial_prompt, 'Fix the scroll');
  assert.equal('initial_prompt' in sent[1]!, false);
}

void launchesCarryFirstMessage().then(() => console.log('profileFacesSmoke: ok'), (error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
