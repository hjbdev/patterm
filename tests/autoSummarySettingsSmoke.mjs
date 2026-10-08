import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { parse, compileScript } from 'vue/compiler-sfc';
import { createRenderer, nextTick, isProxy, proxyRefs } from 'vue';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

test('summary settings save and test send plain, deeply cloneable payloads', async () => {
  const filename = path.resolve('resources/js/Components/AutoSummarySettings.vue');
  const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename });
  const script = compileScript(descriptor, { id: 'summary-settings-test' });
  const output = path.resolve('dist/tests/summary-settings-fixture.cjs');
  await build({
    stdin: { contents: script.content, resolveDir: path.dirname(filename), loader: 'ts' },
    outfile: output, bundle: true, platform: 'node', format: 'cjs', external: ['vue'],
    plugins: [{ name: 'ui-stubs', setup(builder) {
      builder.onResolve({ filter: /^\.\/ui\/|^\.\/settings\// }, (args) => ({ path: args.path, namespace: 'stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: args.path.startsWith('./settings/') ? 'export default {};' : 'export const Button = {}; export const Input = {}; export const Switch = {};' }));
    } }]
  });
  const settings = { enabled: false, provider: 'claude', models: { claude: 'haiku', codex: 'gpt-5.6-luna', opencode: 'gpt-5.6-luna' }, intervalSeconds: 30 };
  const model = (id, reasoning = [], defaultReasoning = null) => ({ id, label: id, reasoning, defaultReasoning });
  const catalog = { providers: {
    claude: { error: null, models: [model('haiku'), model('sonnet', ['low', 'high'])] },
    codex: { error: null, models: [model('gpt-5.6-luna', ['low', 'medium'], 'medium')] },
    opencode: { error: null, models: [model('openai/gpt-5.6-luna'), model('openai/gpt-5.6-luna'), model('anthropic/claude-haiku')] },
    amp: null
  } };
  const received = [];
  const capture = (value) => {
    assert.equal(isProxy(value), false, 'Electron cannot clone Vue proxies');
    const copy = structuredClone(value);
    received.push(copy);
    return copy;
  };
  globalThis.window = { patterm: {
    autoSummarySettings: async () => ({ settings, providers: [{ provider: 'claude', available: true, reason: null }], lastError: null }),
    autoSummarySettingsUpdate: async (value) => capture(value),
    autoSummaryTest: async (value) => { capture(value); return { ok: true }; },
    harnessModels: async () => catalog
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
  const exposed = app.mount({});
  try {
    await new Promise((resolve) => setImmediate(resolve));
    state.draft.intervalSeconds = 60;
    state.draft.models.claude = 'custom-haiku';
    await exposed.save();
    await state.test();
    await nextTick();
    assert.equal(state.error, '');
    assert.equal(state.testPassed, true);
    assert.equal(received.length, 2);
    assert.deepEqual(received[0], received[1]);
    assert.equal(received[0].models.claude, 'custom-haiku');
    assert.equal(received[0].intervalSeconds, 60);
    assert.deepEqual(received[0].reasoning, { claude: null, codex: 'low' }, 'saved settings gain reasoning defaults');

    // Enabling and choosing a listed model and reasoning level are saved.
    state.draft.enabled = true;
    state.draft.models.claude = 'sonnet';
    state.draft.reasoning.claude = 'high';
    await exposed.save();
    assert.equal(received.at(-1).enabled, true);
    assert.equal(received.at(-1).reasoning.claude, 'high');
    assert.deepEqual(state.reasoningOptions, ['low', 'high']);
    state.draft.models.claude = 'haiku';
    state.onModelChange();
    assert.equal(state.draft.reasoning.claude, null, 'unsupported reasoning is cleared when the model changes');

    // OpenCode lists each openai/ model once, by the ID its runner accepts.
    state.draft.provider = 'opencode';
    await nextTick();
    assert.deepEqual(state.modelOptions.map((option) => option.id), ['gpt-5.6-luna']);
    assert.equal(state.selectedModel?.id, 'gpt-5.6-luna');
  } finally {
    app.unmount(); delete globalThis.window; fs.unlinkSync(output);
  }
});

test('checkboxes bind reka-ui modelValue, not the removed checked prop', () => {
  const files = fs.readdirSync(path.resolve('resources/js'), { recursive: true }).filter((file) => file.endsWith('.vue'));
  for (const file of files) {
    const source = fs.readFileSync(path.resolve('resources/js', file), 'utf8');
    assert.doesNotMatch(source, /<Checkbox[^>]*(v-model:checked|:checked=|@update:checked)/, file);
  }
});
