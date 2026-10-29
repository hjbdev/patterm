import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { parse, compileScript } from 'vue/compiler-sfc';
import { createRenderer, isProxy, proxyRefs } from 'vue';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

test('preset settings send a plain, cloneable payload through Electron IPC', async () => {
  const filename = path.resolve('resources/js/Components/HarnessPresetSettings.vue');
  const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename });
  const script = compileScript(descriptor, { id: 'preset-settings-test' });
  const output = path.resolve('dist/tests/harness-preset-settings-fixture.cjs');
  await build({
    stdin: { contents: script.content, resolveDir: path.dirname(filename), loader: 'ts' },
    outfile: output, bundle: true, platform: 'node', format: 'cjs', external: ['vue'],
    plugins: [{ name: 'component-stubs', setup(builder) {
      builder.onResolve({ filter: /^\.\/ui\/|^\.\/settings\/|^\.\/AgentIcon\.vue$|^\.\.\/Composables\/useWorkbench$|^\.\.\/lib\/harnesses$/ }, (args) => ({ path: args.path, namespace: 'stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: args.path.includes('useWorkbench')
        ? 'export const useWorkbench = () => ({ harnesses: { value: [] } });'
        : args.path.includes('harnesses') ? 'export const harnessLabel = (value) => value;'
          : args.path.includes('AgentIcon') || args.path.includes('settings/') ? 'export default {};'
            : 'export const Badge = {}; export const Button = {}; export const Checkbox = {}; export const Input = {}; export const Dialog = {}; export const DialogContent = {}; export const DialogDescription = {}; export const DialogFooter = {}; export const DialogHeader = {}; export const DialogTitle = {};' }));
    } }]
  });
  const settings = {
    presets: [{ id: 'default_claude', harness: 'claude', name: 'Default', model: null, reasoning: null }],
    defaultPresetIdByHarness: { claude: 'default_claude', codex: null, opencode: null }
  };
  let saved;
  globalThis.window = { patterm: {
    harnessPresets: async () => settings,
    harnessModels: async () => ({ providers: { claude: null, codex: null, opencode: null } }),
    harnessPresetsUpdate: async (value) => {
      assert.equal(isProxy(value), false, 'Electron cannot clone Vue proxies');
      saved = structuredClone(value);
      return saved;
    }
  } };
  const component = createRequire(import.meta.url)(output).default;
  component.render = () => null;
  // Read the setup bindings directly. app._instance only exists in Vue's
  // development build, and NODE_ENV=production selects the production one.
  let state;
  const setup = component.setup;
  component.setup = (props, context) => (state = proxyRefs(setup(props, context)));
  const renderer = createRenderer({ createComment: () => ({}), insert() {}, remove() {}, parentNode: () => null, nextSibling: () => null });
  const app = renderer.createApp(component);
  app.mount({});
  try {
    await new Promise((resolve) => setImmediate(resolve));
    state.presets.push({ id: 'desktop_smoke', harness: 'claude', name: 'Desktop smoke', model: 'sonnet', reasoning: 'high' });
    await state.save();
    assert.equal(state.error, '');
    assert.equal(saved?.presets[1]?.reasoning, 'high');
    assert.equal(saved?.presets[0]?.look, null, 'A profile without a saved face keeps none');

    // Editing a profile keeps a face saved earlier, as a plain object.
    state.presets[1].look = { color: 'pink', shape: 'egg', finish: 'soft', marking: 'none', eyes: 'dots', mouth: 'smile', cheeks: false, hat: 'crown', accent: 'pink', idle: 'still' };
    state.editPreset('claude', state.presets[1]);
    state.editor.reasoning = 'low';
    state.applyEditor();
    await state.save();
    assert.equal(saved?.presets[1]?.reasoning, 'low');
    assert.equal(saved?.presets[1]?.look?.hat, 'crown');
  } finally {
    app.unmount();
    delete globalThis.window;
    fs.unlinkSync(output);
  }
});
