import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { parse, compileScript } from 'vue/compiler-sfc';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const browsers = path.join(os.homedir(), '.cache/ms-playwright');
const chromium = process.env.CHROMIUM_BIN ?? (fs.existsSync(browsers) ? fs.readdirSync(browsers).filter(name => name.startsWith('chromium-')).reverse().map(name => path.join(browsers, name, 'chrome-linux64/chrome')).find(file => fs.existsSync(file)) : undefined);

test('streaming Markdown leaves an existing figure frame connected and loaded', { skip: !chromium && 'Set CHROMIUM_BIN to run the browser regression' }, async () => {
  const directory = path.resolve('dist/tests/markdown-figure-streaming');
  fs.mkdirSync(directory, { recursive: true });
  await build({
    stdin: { contents: `
      import { createApp, h, ref, nextTick } from 'vue';
      import Markdown from './resources/js/Components/Markdown.vue';
      const source = ref('Before\\n\\n[patterm_figure:demo]\\n\\nAfter');
      let loads = 0;
      createApp({ render: () => h(Markdown, { source: source.value, revealAppends: true }, {
        mention: ({ part }) => part.figure ? h('iframe', {
          srcdoc: '<p>Interactive page</p>', onLoad: () => loads++
        }) : h('span', part.text)
      }) }).mount('#app');
      const pause = () => new Promise(resolve => setTimeout(resolve, 80));
      window.run = async () => {
        while (!loads) await pause();
        const frame = document.querySelector('iframe');
        frame.contentWindow.persistentState = 'selected';
        for (const text of [' more', ' streaming', '\\n\\nMore paragraphs']) {
          source.value += text;
          await nextTick();
          await pause();
        }
        return { loads, sameFrame: frame === document.querySelector('iframe'), state: frame.contentWindow.persistentState };
      };
    `, resolveDir: path.resolve('.'), loader: 'ts' },
    outfile: path.join(directory, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', logLevel: 'error',
    plugins: [{ name: 'vue', setup(builder) {
      builder.onResolve({ filter: /\?worker$/ }, () => ({ path: 'worker', namespace: 'no-worker' }));
      builder.onLoad({ filter: /.*/, namespace: 'no-worker' }, () => ({ contents: 'export default class {}' }));
      builder.onLoad({ filter: /\.vue$/ }, ({ path: filename }) => {
        const { descriptor } = parse(fs.readFileSync(filename, 'utf8'));
        return { contents: compileScript(descriptor, { id: 'figure-streaming-test', inlineTemplate: true }).content,
          loader: 'ts', resolveDir: path.dirname(filename) };
      });
    } }]
  });
  fs.writeFileSync(path.join(directory, 'index.html'), '<div id="app"></div><script src="fixture.js"></script><script>window.run().then(result => { document.body.dataset.result = JSON.stringify(result); });</script>');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-figure-chrome-'));
  let result;
  try {
    result = spawnSync(chromium, ['--user-data-dir=' + profile, '--headless', '--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--dump-dom', '--virtual-time-budget=5000', pathToFileURL(path.join(directory, 'index.html')).href], { encoding: 'utf8', timeout: 30000 });
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const output = JSON.parse((result.stdout.match(/data-result="([^"]*)"/)?.[1] ?? 'null').replaceAll('&quot;', '"'));
  assert.deepEqual(output, { loads: 1, sameFrame: true, state: 'selected' }, 'streaming must preserve the frame document and its interactive state');
});
