import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Shiki grammars and themes licensed GPL-3.0, which Patterm must not ship.
const GPL_SHIKI = ['ada', 'gnuplot', 'nginx', 'racket', 'aurora-x'];

// Resolve `shiki` to the allowlisted bundle, as vite.config.ts does.
async function load() {
  const output = path.resolve('dist/tests/shiki-allowlist.mjs');
  await build({
    stdin: { contents: "export * from './resources/js/lib/codeHighlight'; export { bundledLanguages, bundledThemes } from 'shiki';", resolveDir: process.cwd(), loader: 'ts' },
    outfile: output, bundle: true, platform: 'node', format: 'esm', external: ['shiki/*'],
    plugins: [{ name: 'shiki-allowlist', setup(builder) {
      builder.onResolve({ filter: /^shiki$/ }, () => ({ path: path.resolve('resources/js/lib/shiki.ts') }));
    } }]
  });
  return import(pathToFileURL(output).href);
}

test('only allowlisted languages and the github-dark theme highlight', async () => {
  const { highlightCodeBlocks, warmCodeHighlighter, bundledLanguages, bundledThemes } = await load();
  assert.deepEqual(Object.keys(bundledThemes), ['github-dark']);
  await warmCodeHighlighter();
  const blocks = ['ts', 'sh', 'python', 'yaml', 'nginx', 'ada', 'unknown'].map((lang) => ({ code: 'value', lang }));
  const html = await highlightCodeBlocks(blocks);
  assert.deepEqual(await highlightCodeBlocks(blocks), html, 'cached results retain the real highlighter output and order');
  for (const [index, { lang }] of blocks.entries()) {
    if (['nginx', 'ada', 'unknown'].includes(lang)) assert.equal(html[index], null, `${lang} stays plain`);
    else assert.match(html[index], /class="shiki/, `${lang} is highlighted`);
  }
  for (const [lang, loadGrammar] of Object.entries(bundledLanguages)) {
    const grammars = (await loadGrammar()).default.map((grammar) => grammar.name);
    assert.ok(!grammars.some((name) => GPL_SHIKI.includes(name)), `${lang} brings in no GPL-3.0 grammar: ${grammars.join(', ')}`);
  }
});

test('highlight cache reuses successes, retries failures and bounds retained blocks', async () => {
  const output = path.resolve('dist/tests/highlight-cache.mjs');
  await build({
    stdin: { contents: "export * from './resources/js/lib/codeHighlight'; export { calls, control } from 'shiki';", resolveDir: process.cwd(), loader: 'ts' },
    outfile: output, bundle: true, platform: 'node', format: 'esm',
    plugins: [{ name: 'controlled-highlighter', setup(builder) {
      builder.onResolve({ filter: /^shiki$/ }, () => ({ path: 'shiki', namespace: 'controlled-highlighter' }));
      builder.onLoad({ filter: /.*/, namespace: 'controlled-highlighter' }, () => ({ contents: `
        export const bundledLanguages = { ts: {}, js: {} };
        export const calls = [];
        export const control = { failures: 1 };
        export async function codeToHtml(code, options) {
          calls.push([options.lang, code]);
          await new Promise(resolve => setImmediate(resolve));
          if (code === 'retry' && control.failures-- > 0) throw new Error('temporary grammar failure');
          if (code.startsWith('medium:')) return code + 'x'.repeat(500_000);
          if (code === 'oversize') return 'x'.repeat(2_200_000);
          return JSON.stringify([options.lang, code, options.theme]);
        }
      ` }));
    } }]
  });
  const { highlightCodeBlocks, calls } = await import(pathToFileURL(output).href);
  const blocks = [{ lang: 'ts', code: 'reused' }, { lang: 'js', code: 'reused' }, { lang: 'unknown', code: 'reused' }];
  const expected = [JSON.stringify(['ts', 'reused', 'github-dark']), JSON.stringify(['js', 'reused', 'github-dark']), null];
  assert.deepEqual(await highlightCodeBlocks(blocks), expected);
  assert.equal(calls.length, 2, 'unsupported languages do not reach the highlighter');
  assert.deepEqual(await highlightCodeBlocks([...blocks].reverse()), [...expected].reverse());
  assert.equal(calls.length, 2, 'exact language/code hits do not re-tokenise');
  assert.deepEqual(await highlightCodeBlocks([{ lang: 'ts', code: 'edited' }]), [JSON.stringify(['ts', 'edited', 'github-dark'])]);
  assert.equal(calls.length, 3, 'a code edit is a miss');

  const retry = [{ lang: 'ts', code: 'retry' }];
  assert.deepEqual(await highlightCodeBlocks(retry), [null]);
  assert.deepEqual(await highlightCodeBlocks(retry), [JSON.stringify(['ts', 'retry', 'github-dark'])]);
  const afterRetry = calls.length;
  await highlightCodeBlocks(retry);
  assert.equal(calls.length, afterRetry, 'a failure is retried, then its success is reusable');

  for (let i = 0; i < 64; i++) await highlightCodeBlocks([{ lang: 'ts', code: `slot:${i}` }]);
  let before = calls.length;
  await highlightCodeBlocks([{ lang: 'ts', code: 'slot:0' }]);
  assert.equal(calls.length, before, 'reading an entry promotes it');
  await highlightCodeBlocks([{ lang: 'ts', code: 'slot:64' }]);
  before = calls.length;
  await highlightCodeBlocks([{ lang: 'ts', code: 'slot:0' }]);
  assert.equal(calls.length, before, 'the recently read entry survives capacity eviction');
  await highlightCodeBlocks([{ lang: 'ts', code: 'slot:1' }]);
  assert.equal(calls.length, before + 1, 'the oldest entry is evicted at 64 entries');

  for (let i = 0; i < 5; i++) await highlightCodeBlocks([{ lang: 'ts', code: `medium:${i}` }]);
  before = calls.length;
  await highlightCodeBlocks([{ lang: 'ts', code: 'medium:1' }]);
  assert.equal(calls.length, before, 'recent large entries remain cached');
  await highlightCodeBlocks([{ lang: 'ts', code: 'medium:0' }]);
  assert.equal(calls.length, before + 1, 'the string budget evicts before the entry limit');
  before = calls.length;
  await highlightCodeBlocks([{ lang: 'ts', code: 'oversize' }]);
  await highlightCodeBlocks([{ lang: 'ts', code: 'oversize' }]);
  assert.equal(calls.length, before + 2, 'an oversize result is never retained');
  before = calls.length;
  await highlightCodeBlocks([{ lang: 'ts', code: 'medium:1' }]);
  assert.equal(calls.length, before, 'an oversize result does not flush useful entries');

  const concurrent = [{ lang: 'ts', code: 'parallel' }];
  before = calls.length;
  const [left, right] = await Promise.all([highlightCodeBlocks(concurrent), highlightCodeBlocks(concurrent)]);
  assert.deepEqual(left, right);
  assert.equal(calls.length, before + 2, 'in-flight misses are independent');
  before = calls.length;
  await highlightCodeBlocks(concurrent);
  assert.equal(calls.length, before, 'parallel replacement keeps cache accounting valid');
});

test('diffs of files in unbundled languages render as plain text', async () => {
  const output = path.resolve('dist/tests/diff-languages.mjs');
  await build({
    stdin: { contents: "import './resources/js/lib/diffLanguages'; export { getFiletypeFromFileName } from '@pierre/diffs';", resolveDir: process.cwd(), loader: 'ts' },
    outfile: output, bundle: true, platform: 'node', format: 'esm', external: ['@pierre/diffs', 'shiki/*']
  });
  const { getFiletypeFromFileName } = await import(pathToFileURL(output).href);
  assert.equal(getFiletypeFromFileName('src/app.ts'), 'typescript');
  assert.equal(getFiletypeFromFileName('Dockerfile'), 'dockerfile');
  for (const file of ['nginx.conf', 'site.conf', 'main.adb', 'plot.gp', 'main.rkt']) assert.equal(getFiletypeFromFileName(file), 'text', file);
});
