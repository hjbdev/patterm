import assert from 'node:assert/strict';
import { appearanceSettingsInput } from '../app/Services/SettingsService';
import { applyUiFont, normalizeAppearanceSettings, UI_FONT_OPTIONS, TERMINAL_FONT_OPTIONS, resolveTerminalFontFamily } from '../resources/js/appearance/AppearanceSettings';

for (const [key, options] of [['uiFont', UI_FONT_OPTIONS], ['terminalFont', TERMINAL_FONT_OPTIONS]] as const) {
  for (const option of options) {
    const saved = appearanceSettingsInput.parse({ [key]: { preset: option.value, customFamily: 'Comic Code' } });
    const restored = normalizeAppearanceSettings(JSON.parse(JSON.stringify(saved)));
    assert.equal(restored[key].preset, option.value, `${key}: ${option.value} survives save and reload`);
    assert.equal(restored[key].customFamily, 'Comic Code');
  }
  assert.throws(() => appearanceSettingsInput.parse({ [key]: { preset: 'unknown' } }));
}
assert.equal(appearanceSettingsInput.parse({}).terminalFont.preset, 'jetbrains-nerd', 'existing default is preserved');
assert.match(resolveTerminalFontFamily(normalizeAppearanceSettings(null)), /"JetBrains Mono"/, 'installed Nerd Font falls back to bundled JetBrains Mono');

assert.equal(appearanceSettingsInput.parse({}).terminalContainer, true);
assert.equal(normalizeAppearanceSettings(null).terminalContainer, true);
assert.equal(appearanceSettingsInput.parse({}).diffViewer, 'drawer', 'the file tree is the default diff layout');
assert.equal(normalizeAppearanceSettings(JSON.parse(JSON.stringify(appearanceSettingsInput.parse({ diffViewer: 'deck' })))).diffViewer, 'deck');
assert.equal(normalizeAppearanceSettings({ diffViewer: 'dock' as never }).diffViewer, 'drawer', 'unknown layouts fall back to the file tree');
assert.throws(() => appearanceSettingsInput.parse({ diffViewer: 'dock' }), 'the service rejects unknown layouts');
assert.equal(appearanceSettingsInput.parse({}).navigation, 'tabs', 'tabs are the default navigation');
assert.equal(normalizeAppearanceSettings(JSON.parse(JSON.stringify(appearanceSettingsInput.parse({ navigation: 'sidebar' })))).navigation, 'sidebar');
assert.equal(normalizeAppearanceSettings({ navigation: 'drawer' as never }).navigation, 'tabs', 'unknown navigation falls back to tabs');
assert.throws(() => appearanceSettingsInput.parse({ navigation: 'drawer' }), 'the service rejects unknown navigation');
const properties = new Map<string, string>();
Object.defineProperty(globalThis, 'document', { configurable: true, value: {
  documentElement: { style: { setProperty: (key: string, value: string) => properties.set(key, value) } },
  body: { style: {} }
} });
try {
  for (const enabled of [false, true]) {
    const saved = appearanceSettingsInput.parse({ terminalContainer: enabled });
    const restored = normalizeAppearanceSettings(JSON.parse(JSON.stringify(saved)));
    assert.equal(restored.terminalContainer, enabled);
    applyUiFont(restored);
    assert.equal(properties.get('--patterm-terminal-max-width'), enabled ? '960px' : 'none');
  }
} finally {
  Reflect.deleteProperty(globalThis, 'document');
}
console.log('appearance settings smoke passed');
