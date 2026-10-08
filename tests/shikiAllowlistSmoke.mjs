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
  for (const [index, { lang }] of blocks.entries()) {
    if (['nginx', 'ada', 'unknown'].includes(lang)) assert.equal(html[index], null, `${lang} stays plain`);
    else assert.match(html[index], /class="shiki/, `${lang} is highlighted`);
  }
  for (const [lang, loadGrammar] of Object.entries(bundledLanguages)) {
    const grammars = (await loadGrammar()).default.map((grammar) => grammar.name);
    assert.ok(!grammars.some((name) => GPL_SHIKI.includes(name)), `${lang} brings in no GPL-3.0 grammar: ${grammars.join(', ')}`);
  }
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
