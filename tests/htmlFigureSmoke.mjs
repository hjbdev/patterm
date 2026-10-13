import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';
import ts from 'typescript';
import { computed, markRaw, nextTick, ref, watch } from 'vue';

// The shared module, the action and the transcript helpers are bundled
// together for Node.
const outfile = path.resolve('dist/tests/html-figure.mjs');
await build({
  stdin: {
    contents: `
      export * from './app/Services/HtmlFigure';
      export { RenderHtmlFigureAction } from './app/Actions/RenderHtmlFigureAction';
      export { PreviewHtmlFigureAction } from './app/Actions/PreviewHtmlFigureAction';
      export { McpToolRegistry } from './app/MCP/ToolRegistry';
      export { FIGURE_EXAMPLES } from './resources/js/lib/figureExamples';
      export { FIGURE_ID, groupTranscriptMessages, normaliseMessages } from './app/Services/TranscriptProjection';
      export { projectCodexItem } from './app/Services/CodexTranscript';
      export { splitProcessMentions } from './resources/js/lib/agentMentions';
      export { renderPlainMarkdown } from './resources/js/lib/markdown';
    `,
    resolveDir: path.resolve('.'),
    loader: 'ts'
  },
  outfile, bundle: true, platform: 'node', format: 'esm', external: ['vue'], logLevel: 'error'
});
const ui = await import(pathToFileURL(outfile).href);

const claude = { name: 'mcp__patterm__html_render', family: 'mcp', status: 'completed', title: 'MCP', target: 'patterm: html_render', input: { id: 'pipeline', title: 'Pipeline', html: '<p>x</p>' } };

test('the theme and bootstrap come first, so the page overrides them', () => {
  const withHead = ui.prepareFigureHtml('<!doctype html><html lang="en"><head><style>body{color:red}</style></head><body>x</body></html>');
  assert.ok(withHead.indexOf('id="patterm-theme"') < withHead.indexOf('body{color:red}'));
  assert.match(withHead, /^<!doctype html><html lang="en"><head><style id="patterm-theme">/);
  assert.match(ui.prepareFigureHtml('<html><body>x</body></html>'), /^<html><head><style id="patterm-theme">.*<\/script><\/head><body>x/s);
  assert.match(ui.prepareFigureHtml('<!DOCTYPE html><p>x</p>'), /^<!DOCTYPE html><head><style id="patterm-theme">.*<\/head><p>x<\/p>$/s);
  assert.match(ui.prepareFigureHtml('<p>x</p>'), /^<!doctype html><head>.*<\/head><p>x<\/p>$/s);
  const prepared = ui.prepareFigureHtml('<p>x</p>');
  for (const name of Object.keys(ui.FIGURE_THEME)) assert.ok(prepared.includes(`${name}:`), `${name} is set`);
  assert.match(prepared, /window\.patterm = Object\.freeze/);
});

test('pages use the user\'s typefaces: bundled ones inline, installed ones by name', () => {
  const settings = (ui, terminal, custom = '') => ({ uiFont: { preset: ui, customFamily: custom }, terminalFont: { preset: terminal, customFamily: custom } });
  const fake = (file) => `data:font/woff2;base64,${file.replace(/\W/g, '')}`;
  const geist = ui.figureFontsFor(settings('geist', 'fira-code'));
  assert.deepEqual(geist.fonts.map((font) => [font.name, font.weights]), [['Geist', [400, 500, 600, 700]], ['Fira Code', [400, 700]]]);
  assert.equal(geist.files.length, 8 + 4, 'Latin and Latin Extended faces for each weight');
  const css = ui.figureFontStyle(settings('geist', 'fira-code'), fake);
  assert.match(css, /^:root\{--font-sans:Geist, ui-sans-serif[^}]*;--font-mono:"Fira Code", ui-monospace/);
  assert.match(css, /font-family:"Geist";font-style:normal;font-display:block;font-weight:600;src:url\(data:font\/woff2;base64,geistgeistlatin600normalwoff2\)/);
  assert.equal(css.split('@font-face').length - 1, 12);
  // The installed Nerd Font loads by name; JetBrains Mono behind it is bundled.
  assert.deepEqual(ui.figureFontsFor(settings('system', 'jetbrains-nerd')).fonts.map((font) => font.slug), ['jetbrains-mono']);
  const custom = ui.figureFontStyle(settings('custom', 'custom', 'My Font}</style><script>x()</script>'), fake);
  assert.doesNotMatch(custom, /<|\}<|@font-face/, 'a custom family cannot leave the rule, and needs no faces');
  assert.equal(ui.figureFontStyle(settings('inter', 'system-mono'), () => null).includes('@font-face'), false, 'missing files are left out');
  const prepared = ui.prepareFigureHtml('<head></head><p>x</p>', css);
  assert.ok(prepared.indexOf('id="patterm-theme"') < prepared.indexOf('id="patterm-fonts"'), 'the chosen families override the theme default');
  assert.doesNotMatch(ui.prepareFigureHtml('<p>x</p>'), /patterm-fonts/, 'no fonts, no empty style');
  for (const slug of ui.BUNDLED_FIGURE_FONTS) {
    assert.ok(fs.existsSync(path.join('resources/js/assets/fonts', ui.figureFontFile(slug, 'latin', 400))), `${slug} is vendored`);
  }
});

test('the frame runs scripts in an opaque origin and cannot submit or navigate forms', () => {
  const csp = ui.figureFrameCsp("'self'");
  assert.match(csp, /^sandbox allow-scripts allow-forms;/);
  assert.doesNotMatch(csp, /allow-same-origin|allow-top-navigation|allow-popups|allow-modals/, 'Electron would let a page open popups without a click');
  const component = fs.readFileSync('resources/js/Components/HtmlFigureFrame.vue', 'utf8');
  assert.match(component, /:sandbox="FIGURE_FRAME_SANDBOX"/, 'the iframe and its policy share one sandbox');
  assert.match(component, /:key="request\.revision"/, 'confirm controls are rebuilt for each request');
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /frame-ancestors 'self'$/);
  assert.doesNotMatch(ui.figureFrameCsp(null), /frame-ancestors/);
  assert.match(ui.FIGURE_FRAME_HTML, /event\.source !== parent/, 'only the host can send the page');
});

test('local images are found and swapped for their stored copies', () => {
  const page = `<img src="shot.png"><img alt="x" src='/abs/a.webp'><img src="https://example.com/r.png"><img src="data:image/png;base64,AA">
<style>.a{background:url(bg.png)}.b{background:url("https://cdn.example/x.png")}.c{background:url('#frag')}</style>`;
  assert.deepEqual(ui.figureImagePaths(page), ['shot.png', '/abs/a.webp', 'bg.png']);
  const swapped = ui.replaceFigureImages(page, new Map([['shot.png', 'data:image/png;base64,S'], ['bg.png', 'data:image/png;base64,B']]));
  assert.match(swapped, /<img src="data:image\/png;base64,S">/);
  assert.match(swapped, /url\("data:image\/png;base64,B"\)/);
  assert.match(swapped, /src='\/abs\/a\.webp'/, 'an image that was not stored stays as it was');
});

test('every harness spelling of html_render is a figure; the reply maps its images', () => {
  const codex = { ...claude, name: 'patterm', target: 'patterm: html_render', input: { server: 'patterm', tool: 'html_render', arguments: JSON.stringify(claude.input) } };
  const opencode = { ...claude, name: 'patterm_ab12_html_render', target: 'patterm_ab12: html_render' };
  const other = { ...claude, name: 'mcp__other__html_render', target: 'other: html_render' };
  assert.ok(ui.isFigureTool(claude) && ui.isFigureTool(codex) && ui.isFigureTool(opencode));
  assert.ok(!ui.isFigureTool(other) && !ui.isFigureTool({ ...claude, family: 'generic' }));
  assert.ok(!ui.isFigureTool({ ...claude, target: 'patterm: ui_save' }), 'retired ui_save calls are ordinary tool rows');
  assert.deepEqual(ui.figureToolInput(codex), claude.input);
  assert.deepEqual(ui.figurePage(ui.figureToolInput(codex)), claude.input);
  assert.equal(ui.figurePage({ title: 'x' }), null, 'a call without a page shows nothing');
  assert.deepEqual(ui.figureImages({ ...claude, output: JSON.stringify({ ok: true, images: { 'shot.png': 'a'.repeat(64), bad: 'x' } }) }), { 'shot.png': 'a'.repeat(64) });
  const row = (id, tool) => ({ id, role: 'assistant', kind: 'tool', text: '', tool });
  const rows = ui.groupTranscriptMessages([row('1', other), row('2', claude), row('3', { ...claude, status: 'failed', error: 'nothing was rendered' }), row('4', other)]);
  assert.deepEqual(rows.map((item) => item.kind), ['tools'], 'rendering a page is a step like any other tool call, rejected or not');
});

test('a reply places a page with its token', () => {
  const unnamed = { ...claude, input: { title: 'x', html: '<p>x</p>' }, output: JSON.stringify({ ok: true, ref: '[patterm_figure:fig_a1b2c3]' }) };
  assert.equal(ui.figureId(claude), 'pipeline');
  assert.equal(ui.figureId(unnamed), 'fig_a1b2c3', 'a generated id comes back in the reply');
  assert.deepEqual(ui.splitProcessMentions('see [patterm_figure:pipeline] here').map((part) => part.figure ?? null), [null, 'pipeline', null]);
  assert.match(ui.renderPlainMarkdown('Before\n\n[patterm_figure:pipeline]\n\nAfter', { mentions: true }), /<p>Before<\/p>\n<p><span data-mention="\[patterm_figure:pipeline\]"><\/span><\/p>\n<p>After<\/p>/);
});

test('answers go back as one readable message and stay answered', () => {
  const single = ui.figureAnswerText('ui_9', [{ label: 'Inline card (with tab)', value: 'inline' }]);
  assert.equal(single, 'Answer to ui_9: Inline card (with tab) (inline)');
  const queue = ui.figureAnswerText('ui_14', [{ item: 'n1', label: 'Ping', value: 'ping' }, { item: 'n2', label: 'Silent', value: 'silent' }]);
  assert.equal(queue, 'Answer to ui_14:\n- n1: Ping (ping)\n- n2: Silent (silent)');
  const answered = ui.figureAnswers([{ role: 'assistant', text: 'Answer to ui_9: no' }, { role: 'user', text: single }, { role: 'user', text: queue }]);
  assert.deepEqual([...answered.keys()], ['ui_9', 'ui_14']);
  const delivery = (state) => ui.figureAnswers([{ role: 'user', text: single, delivery: { state, messageId: 'm1' } }]).has('ui_9');
  assert.equal(delivery('failed'), false, 'a failed send leaves the question open');
  assert.equal(delivery('sending'), true, 'a send in flight answers it');
  assert.equal(delivery('uncertain'), true, 'an unconfirmed send is not sent twice');
});

test('Codex replies map images to their stored copies', () => {
  const sha = 'a'.repeat(64);
  const reply = { ok: true, ref: '[patterm_figure:shot]', images: { 'shot.png': sha } };
  const projected = ui.projectCodexItem({ type: 'mcpToolCall', id: 'call_1', server: 'patterm', tool: 'html_render', status: 'completed', arguments: { id: 'shot', title: 'Shot', html: '<img src="shot.png">' }, result: { content: [{ type: 'text', text: JSON.stringify(reply, null, 2) }], structuredContent: null } });
  const [message] = ui.normaliseMessages([projected]);
  assert.ok(ui.isFigureTool(message.tool));
  assert.deepEqual(ui.figureImages(message.tool), { 'shot.png': sha });
});

test('the Settings examples are valid pages', () => {
  for (const example of ui.FIGURE_EXAMPLES) {
    const result = ui.htmlRenderInput.safeParse(example.page);
    assert.ok(result.success, example.label);
    assert.deepEqual(ui.figureImagePaths(example.page.html), [], `${example.label} needs no local files`);
  }
});

test('the setting takes html_render out of the catalog and rejects calls', async () => {
  const registry = new ui.McpToolRegistry();
  let enabled = true;
  registry.register({ name: ui.HTML_RENDER_TOOL, namespace: 'cli.ui', description: 'Render a page.', inputSchema: { type: 'object' }, unavailable: () => enabled ? null : 'html_render is turned off' }, () => ({ ok: true }));
  assert.deepEqual(registry.publicTools({}).map(({ name }) => name), ['html_render']);
  assert.deepEqual(await registry.callPublic('html_render', {}), { ok: true });
  enabled = false;
  assert.deepEqual(registry.publicTools({}), []);
  await assert.rejects(registry.callPublic('html_render', {}), /turned off/);
});

test('images must live in the caller\'s directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'html-figure-'));
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, 'shot.png'), 'png');
  fs.writeFileSync(path.join(root, 'secret.png'), 'png');
  // Windows refuses symlinks without Developer Mode or elevation.
  let linked = true;
  try {
    fs.symlinkSync(path.join(root, 'secret.png'), path.join(work, 'link.png'));
  } catch (error) {
    if (error.code !== 'EPERM' || process.platform !== 'win32') throw error;
    linked = false;
  }
  const stored = [];
  const action = new ui.RenderHtmlFigureAction({ fromFile: (file) => { stored.push(file); return { type: 'image', sha256: 'c'.repeat(64), mime: 'image/png', size: 3 }; } });
  const caller = { cwd: work, project_path: null };
  const page = (src) => ({ title: 'Shot', html: `<img src="${src}">` });
  const result = action.execute(page('shot.png'), caller);
  assert.match(result.ref, /^\[patterm_figure:fig_[0-9a-f]{6}\]$/);
  assert.deepEqual(result.images, { 'shot.png': 'c'.repeat(64) });
  assert.match(result.shown, /^Not shown yet\. Put \[patterm_figure:fig_[0-9a-f]{6}\] on its own line in your reply/);
  for (const outside of ['../secret.png', ...(linked ? ['link.png'] : []), path.join(root, 'secret.png'), 'missing.png']) {
    assert.throws(() => action.execute(page(outside), caller), /must be an existing file inside your working directory/);
  }
  assert.throws(() => action.execute(page('shot.png'), { cwd: null, project_path: null }), /inside your working directory/);
  assert.deepEqual(stored, [path.join(fs.realpathSync(work), 'shot.png')]);
  assert.equal(action.execute({ id: 'shot', ...page('shot.png') }, caller).ref, '[patterm_figure:shot]');
  assert.equal(action.execute({ title: 'Remote', html: '<p>ok</p>' }, caller).images, undefined);
  assert.throws(() => action.execute({ title: 'x' }, caller), /nothing was rendered[\s\S]*html: /);
  assert.throws(() => action.execute({ title: 'x', html: 'x', extra: 1 }, caller), /nothing was rendered/);
  assert.throws(() => action.execute({ id: 'bad id', title: 'x', html: 'x' }, caller), /id: use letters/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a preview draws the prepared page with images inlined and returns the screenshot as image content', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'html-preview-'));
  fs.writeFileSync(path.join(root, 'shot.png'), 'png');
  let drawn = null;
  const previewer = { fontCss: () => '@font-face{font-family:Probe}', capture: async (html, width) => { drawn = { html, width }; return { width, contentHeight: 900, capturedHeight: 900, png: Buffer.from('PNG'), consoleMessages: [{ level: 'error', text: 'boom' }] }; } };
  const images = { fromFile: () => ({ type: 'image', sha256: 'd'.repeat(64), mime: 'image/png', size: 3 }), read: () => ({ mime: 'image/png', data: 'UE5H' }) };
  const action = new ui.PreviewHtmlFigureAction(previewer, images);
  const result = await action.execute({ html: '<img src="shot.png"><img src="gone.png">', width: 360 }, { cwd: root, project_path: null });
  assert.equal(drawn.width, 360);
  assert.match(drawn.html, /id="patterm-theme"/);
  assert.match(drawn.html, /<style id="patterm-fonts">@font-face\{font-family:Probe\}<\/style>/, 'previews use the same fonts as the reply');
  assert.match(drawn.html, /<img src="data:image\/png;base64,UE5H">/);
  assert.deepEqual(result.consoleMessages, [{ level: 'error', text: 'boom' }]);
  assert.match(result.missingImages[0], /gone\.png/);
  assert.deepEqual(result.mcp_images, [{ mimeType: 'image/png', data: Buffer.from('PNG').toString('base64') }]);
  assert.equal((await action.execute({ html: '<p>x</p>' }, { cwd: root, project_path: null })).width, ui.PREVIEW_WIDTH.initial);
  await assert.rejects(action.execute({ html: '<p>x</p>', width: 10 }, { cwd: root, project_path: null }), /html_preview: width/);
  fs.rmSync(root, { recursive: true, force: true });
});

// The frame component's own script, run against stub frames, channels and clock.
function mountFrame({ channel = null, answered = new Map() } = {}) {
  const file = fs.readFileSync('resources/js/Components/HtmlFigureFrame.vue', 'utf8');
  const blocks = [...file.matchAll(/<script(?: setup)? lang="ts">([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const executable = (source) => {
    const parsed = ts.createSourceFile('frame.ts', source, ts.ScriptTarget.Latest, true);
    return parsed.statements.filter((statement) => !ts.isImportDeclaration(statement)).map((statement) => statement.getFullText(parsed)).join('\n');
  };
  const { outputText } = ts.transpileModule(`${executable(blocks[1])}\n${executable(blocks[0])}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const posted = [];
  const opened = [];
  const contentWindow = { postMessage: (message) => posted.push(message) };
  const clock = { now: 0 };
  const window = { addEventListener: () => {}, removeEventListener: () => {}, open: (...args) => opened.push(args) };
  const answerKey = Symbol('answer');
  const answeredKey = Symbol('answered');
  const setup = new Function('computed', 'inject', 'onBeforeUnmount', 'onMounted', 'ref', 'watch', 'window', 'performance', 'FIGURE_FRAME_SANDBOX', 'FIGURE_HEIGHT', 'FIGURE_ID', 'figureAnswerText', 'figureAnswerKey', 'figureAnsweredKey', 'figureFrameUrl', 'defineProps', '__frame',
    `${outputText}\nframe.value = __frame;\nreturn { onMessage, arm, confirm, request };`);
  const api = setup(computed, (key) => key === answerKey ? channel : key === answeredKey ? computed(() => answered) : null, () => {}, () => {}, ref, watch, window, { now: () => clock.now },
    ui.FIGURE_FRAME_SANDBOX, ui.FIGURE_HEIGHT, ui.FIGURE_ID, ui.figureAnswerText, answerKey, answeredKey, () => '/figure-frame', () => ({ html: '<p>x</p>', title: 'x', initialHeight: 100 }), markRaw({ contentWindow }));
  const fromPage = (data) => api.onMessage({ source: contentWindow, data: { source: 'patterm-figure', ...data } });
  // A real press: pointer down on the button, later the click.
  const press = async ({ trusted = true, wait = 600, between } = {}) => {
    clock.now += wait;
    api.arm({ isTrusted: trusted });
    between?.();
    await api.confirm({ isTrusted: trusted });
  };
  return { ...api, posted, opened, clock, fromPage, press };
}

function liveChannel() {
  const sent = [];
  return { sent, channel: { canSend: computed(() => true), queued: computed(() => new Map()), send: async (text) => { sent.push(text); } } };
}

const pick = (id, label, value, requestId = 1) => ({ type: 'answer', requestId, id, picks: [{ label, value }] });

test('a page cannot answer without the user pressing Send in Patterm', async () => {
  const { sent, channel } = liveChannel();
  const frame = mountFrame({ channel });
  // A page that keeps proposing while the user clicks elsewhere in the app.
  for (let attempt = 0; attempt < 3; attempt++) frame.fromPage(pick('unauthorized', 'Yes', 'yes', attempt + 1));
  await nextTick();
  assert.deepEqual(sent, [], 'requests alone send nothing');
  assert.equal(frame.request.value.text, 'Answer to unauthorized: Yes (yes)');
  assert.deepEqual(frame.posted.filter((message) => message.type === 'answer-result').map((message) => [message.requestId, message.ok]), [[1, false], [2, false]], 'a newer request replaces the older one');
  await frame.confirm({ isTrusted: true });
  assert.deepEqual(sent, [], 'a click that never pressed the button sends nothing');
  await frame.press({ trusted: false });
  assert.deepEqual(sent, [], 'a synthetic press is not the user');
  await frame.press();
  assert.deepEqual(sent, ['Answer to unauthorized: Yes (yes)']);
  assert.equal(frame.request.value, null);
  assert.deepEqual(frame.posted.at(-1), { source: 'patterm-host', type: 'answer-result', requestId: 3, ok: true });
  await frame.press();
  assert.equal(sent.length, 1, 'a sent answer cannot be sent again');
});

test('a press sends only the request it began on, after it has stood still', async () => {
  const { sent, channel } = liveChannel();
  const frame = mountFrame({ channel });
  frame.fromPage(pick('q', 'Original', 'original'));
  // The page swaps its answer while the button is held down.
  await frame.press({ between: () => frame.fromPage(pick('q', 'Replaced', 'unauthorized', 2)) });
  assert.deepEqual(sent, [], 'the swapped request needs its own press');
  assert.equal(frame.request.value.text, 'Answer to q: Replaced (unauthorized)', 'the user sees what changed');
  // The page swaps it again just before the user presses.
  frame.fromPage(pick('q', 'Swapped late', 'late', 3));
  await frame.press({ wait: 100 });
  assert.deepEqual(sent, [], 'a request that only just appeared is not pressed yet');
  await frame.press();
  assert.deepEqual(sent, ['Answer to q: Swapped late (late)'], 'the user sent what they had time to read');
});

test('links open only after the user confirms the address in Patterm', async () => {
  const frame = mountFrame();
  frame.fromPage({ type: 'open-link', url: 'javascript:alert(1)' });
  frame.fromPage({ type: 'open-link', url: 'file:///etc/passwd' });
  assert.equal(frame.request.value, null, 'only web addresses are offered');
  frame.fromPage({ type: 'open-link', url: 'https://example.com/report' });
  assert.equal(frame.request.value.text, 'https://example.com/report');
  assert.deepEqual(frame.opened, [], 'asking opens nothing');
  await frame.press();
  assert.deepEqual(frame.opened, [['https://example.com/report', '_blank', 'noopener,noreferrer']]);
  assert.equal(frame.request.value, null);
});

test('pages outside a live conversation, or for answered questions, cannot ask for answers', () => {
  const readOnly = mountFrame();
  readOnly.fromPage(pick('q', 'A', 'a'));
  assert.equal(readOnly.request.value, null);
  assert.match(readOnly.posted.at(-1).error, /live conversation/);
  const { channel } = liveChannel();
  const answered = mountFrame({ channel, answered: new Map([['q', 'Answer to q: A (a)']]) });
  answered.fromPage(pick('q', 'B', 'b'));
  assert.equal(answered.request.value, null);
  assert.match(answered.posted.at(-1).error, /Already answered/);
  const invalid = mountFrame({ channel });
  invalid.fromPage({ type: 'answer', requestId: 1, id: 'bad id', picks: [] });
  assert.match(invalid.posted.at(-1).error, /needs an id/);
  const stranger = mountFrame({ channel });
  stranger.onMessage({ source: {}, data: { source: 'patterm-figure', type: 'answer', id: 'q', picks: [{ label: 'A', value: 'a' }] } });
  assert.equal(stranger.request.value, null, 'only this page\'s own frame is heard');
});
