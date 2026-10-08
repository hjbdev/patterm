import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { parse, compileScript } from 'vue/compiler-sfc';
import { createRenderer, h, ref, nextTick } from 'vue';

test('small Markdown appears immediately and stays visible while highlighting loads', async () => {
  const output = path.resolve('dist/tests/markdown-component.cjs');
  await build({
    entryPoints: ['resources/js/Components/Markdown.vue'], outfile: output,
    bundle: true, platform: 'node', format: 'cjs', external: ['vue'],
    plugins: [{ name: 'vue', setup(builder) {
      // Node has no Worker, so highlighting falls back to the main thread.
      builder.onResolve({ filter: /\?worker$/ }, () => ({ path: 'worker', namespace: 'no-worker' }));
      builder.onLoad({ filter: /.*/, namespace: 'no-worker' }, () => ({ contents: 'export default class {}' }));
      builder.onResolve({ filter: /^shiki$/ }, () => ({ path: 'shiki', namespace: 'delayed-highlight' }));
      builder.onLoad({ filter: /.*/, namespace: 'delayed-highlight' }, () => ({ contents: `
        export const bundledLanguages = { js: {} };
        export function codeToHtml() { return new Promise(resolve => { globalThis.finishMarkdownHighlight = resolve; }); }
      ` }));
      builder.onLoad({ filter: /\.vue$/ }, ({ path: filename }) => {
        const { descriptor } = parse(fs.readFileSync(filename, 'utf8'));
        return { contents: compileScript(descriptor, { id: 'markdown-test', inlineTemplate: true }).content,
          loader: 'ts', resolveDir: path.dirname(filename) };
      });
    } }]
  });
  const component = createRequire(import.meta.url)(output).default;
  const pending = [];
  globalThis.window = { requestIdleCallback(callback) { pending.push(callback); return pending.length; }, cancelIdleCallback() {} };
  const renderer = createRenderer({
    createElement: (tag) => ({ tag, props: {}, children: [] }),
    createText: (text) => ({ text }), createComment: () => ({}),
    insert(node, parent, anchor) {
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      parent.children.splice(index < 0 ? parent.children.length : index, 0, node);
      node.parent = parent;
    },
    remove(node) { node.parent.children.splice(node.parent.children.indexOf(node), 1); },
    parentNode: (node) => node.parent, nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    setText(node, text) { node.text = text; }, setElementText(node, text) { node.text = text; },
    patchProp(node, key, _previous, value) { node.props[key] = value; }
  });
  const source = ref('# Header 1\n\n```js\nconsole.log("code block");\n```');
  const root = { children: [] };
  const app = renderer.createApp({ render: () => h(component, { source: source.value }) });
  app.mount(root);
  const markdown = () => root.children.find((node) => node.tag === 'div');
  try {
    assert.match(markdown().props?.innerHTML ?? '', /<h1>Header 1<\/h1>/, 'content must appear before idle callbacks or syntax highlighting');
    assert.equal(globalThis.finishMarkdownHighlight, undefined, 'highlighting starts after the plain content is shown');
    await new Promise((resolve) => setTimeout(resolve, 140));
    assert.equal(typeof globalThis.finishMarkdownHighlight, 'function');
    source.value = '# Different conversation';
    await nextTick();
    assert.match(markdown().props.innerHTML, /Different conversation/);
    for (const callback of pending) callback();
    globalThis.finishMarkdownHighlight('<pre>Old highlighted conversation</pre>');
    await new Promise((resolve) => setImmediate(resolve));
    await nextTick();
    assert.match(markdown().props.innerHTML, /Different conversation/, 'old highlights must not replace the current conversation');
  } finally { app.unmount(); delete globalThis.window; delete globalThis.finishMarkdownHighlight; }
});
