import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';
import ts from 'typescript';
import { DatabaseSync } from 'node:sqlite';
import { computed, markRaw, nextTick, ref, watch } from 'vue';

// The shared module, the action and the transcript helpers are bundled
// together for Node.
const outfile = path.resolve('dist/tests/html-figure.mjs');
await build({
  stdin: {
    contents: `
      export * from './app/Services/HtmlFigure';
      export { RenderHtmlFigureAction } from './app/Actions/RenderHtmlFigureAction';
      export { FigureTemplateService } from './app/Services/FigureTemplateService';
      export { default as figureTemplatesMigration } from './database/migrations/2026_11_10_000066_add_figure_templates';
      export { FigureVideoStore, MAX_FIGURE_VIDEO_BYTES, sniffVideo } from './app/Services/FigureVideoStore';
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
  assert.match(ui.prepareFigureHtml('<p>x</p>'), /preserveAspectRatio', 'xMidYMid meet'/, 'stretched drawings with text keep their shape');
  for (const slug of ui.BUNDLED_FIGURE_FONTS) {
    assert.ok(fs.existsSync(path.join('resources/js/assets/fonts', ui.figureFontFile(slug, 'latin', 400))), `${slug} is vendored`);
  }
});

test('the frame runs scripts in an opaque origin and cannot submit or navigate forms', () => {
  const csp = ui.figureFrameCsp("'self'");
  assert.match(csp, /^sandbox allow-scripts allow-forms;/);
  assert.doesNotMatch(csp, /allow-same-origin|allow-top-navigation|allow-popups|allow-modals/, 'Electron would let a page open popups without a click');
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /frame-ancestors 'self'$/);
  assert.doesNotMatch(ui.figureFrameCsp(null), /frame-ancestors/);
  assert.match(ui.FIGURE_FRAME_HTML, /event\.source !== parent/, 'only the host can send the page');
  assert.match(ui.FIGURE_FRAME_HTML, /<meta name="color-scheme" content="dark">/, 'the empty frame matches the dark app instead of flashing white');
});

test('local images are found and swapped for their stored copies', () => {
  const page = `<img src="shot.png"><img alt="x" src='/abs/a.webp'><img src="https://example.com/r.png"><img src="data:image/png;base64,AA">
<style>.a{background:url(bg.png)}.b{background:url("https://cdn.example/x.png")}.c{background:url('#frag')}</style>`;
  assert.deepEqual(ui.figureImagePaths(page), ['shot.png', '/abs/a.webp', 'bg.png']);
  assert.deepEqual(ui.figureImagePaths('<img src="C:\\Users\\me\\shot.png"><img src="d:/shots/b.png">'), ['C:\\Users\\me\\shot.png', 'd:/shots/b.png'], 'Windows drive paths are files, not URL schemes');
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

test('images must live in the caller\'s directories', async () => {
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
  const result = await action.execute(page('shot.png'), caller);
  assert.match(result.ref, /^\[patterm_figure:fig_[0-9a-f]{6}\]$/);
  assert.deepEqual(result.images, { 'shot.png': 'c'.repeat(64) });
  assert.match(result.shown, /^Not shown yet\. Put \[patterm_figure:fig_[0-9a-f]{6}\] on its own line in your reply/);
  for (const outside of ['../secret.png', ...(linked ? ['link.png'] : []), path.join(root, 'secret.png'), 'missing.png']) {
    await assert.rejects(action.execute(page(outside), caller), /must be an existing file inside your working directory/);
  }
  await assert.rejects(action.execute(page('shot.png'), { cwd: null, project_path: null }), /inside your working directory/);
  assert.deepEqual(stored, [path.join(fs.realpathSync(work), 'shot.png')]);
  assert.equal((await action.execute({ id: 'shot', ...page('shot.png') }, caller)).ref, '[patterm_figure:shot]');
  assert.equal((await action.execute({ title: 'Remote', html: '<p>ok</p>' }, caller)).images, undefined);
  await assert.rejects(action.execute({ title: 'x' }, caller), /nothing was rendered[\s\S]*html: /);
  await assert.rejects(action.execute({ title: 'x', html: 'x', extra: 1 }, caller), /nothing was rendered/);
  await assert.rejects(action.execute({ id: 'bad id', title: 'x', html: 'x' }, caller), /id: use letters/);
  fs.rmSync(root, { recursive: true, force: true });
});


// The first bytes of real MP4 (ISO base media) and WebM files.
const MP4_HEADER = Buffer.from('000000206674797069736f6d0000020069736f6d69736f32617663316d703431', 'hex');
const WEBM_HEADER = Buffer.from('1a45dfa39f4286810142f7810142f2810442f381084282847765626d42878102', 'hex');

test('local videos are found, and swapped for placeholders the frame fills with its own blob: URLs', () => {
  const page = `<video controls src="clip.mp4" poster="still.png"></video><video controls><source src='/abs/b.webm' type="video/webm"><source src="https://cdn.example/c.mp4"></video><img src="shot.png">`;
  assert.deepEqual(ui.figureVideoPaths(page), ['clip.mp4', '/abs/b.webm']);
  assert.deepEqual(ui.figureImagePaths(page), ['shot.png', 'still.png'], 'a poster is an image');
  const swapped = ui.replaceFigureVideos(page, new Map([['clip.mp4', 'patterm-video:one']]));
  assert.match(swapped, /<video controls src="patterm-video:one" poster="still\.png">/);
  assert.match(swapped, /<source src='\/abs\/b\.webm'/, 'a video that was not stored stays as it was');
  assert.match(ui.FIGURE_FRAME_HTML, /instanceof Blob\) html = html\.split\(placeholder\)\.join\(URL\.createObjectURL/);
  assert.deepEqual(ui.figureVideos({ ...claude, output: JSON.stringify({ ok: true, images: { 'still.png': 'b'.repeat(64) }, videos: { 'clip.mp4': 'a'.repeat(64), bad: 'x' } }) }), { 'clip.mp4': 'a'.repeat(64) });
  assert.deepEqual(ui.figureImages({ ...claude, output: JSON.stringify({ ok: true, videos: { 'clip.mp4': 'a'.repeat(64) } }) }), {});
});

test('only MP4 and WebM containers are videos', () => {
  assert.equal(ui.sniffVideo(MP4_HEADER), 'video/mp4');
  assert.equal(ui.sniffVideo(WEBM_HEADER), 'video/webm');
  const still = Buffer.from(MP4_HEADER);
  still.write('heic', 8, 'ascii');
  assert.equal(ui.sniffVideo(still), null, 'HEIF stills share the MP4 container');
  const matroska = Buffer.from(WEBM_HEADER.toString('hex').replace('7765626d', '6d6b7631'), 'hex');
  assert.equal(ui.sniffVideo(matroska), null, 'other Matroska files are not WebM');
  for (const other of [Buffer.from('<html><video>'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(0)]) assert.equal(ui.sniffVideo(other), null);
});

test('videos are copied by content into their own store and read back as bytes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'figure-video-'));
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  const body = Buffer.concat([MP4_HEADER, Buffer.alloc(3 * 1024 * 1024, 7)]);
  fs.writeFileSync(path.join(work, 'clip.mp4'), body);
  fs.writeFileSync(path.join(work, 'copy.mp4'), body);
  fs.writeFileSync(path.join(work, 'clip.webm'), Buffer.concat([WEBM_HEADER, Buffer.from('frames')]));
  fs.writeFileSync(path.join(work, 'fake.mp4'), '<script>alert(1)</script>');
  const store = new ui.FigureVideoStore(path.join(root, 'videos'));
  const action = new ui.RenderHtmlFigureAction(undefined, store);
  const caller = { cwd: work, project_path: null };
  const result = await action.execute({ title: 'Clip', html: '<video controls src="clip.mp4"></video><video><source src="copy.mp4"><source src="clip.webm"></video>' }, caller);
  assert.equal(result.videos['clip.mp4'], result.videos['copy.mp4'], 'the same bytes are stored once');
  assert.notEqual(result.videos['clip.mp4'], result.videos['clip.webm']);
  assert.deepEqual(fs.readdirSync(path.join(root, 'videos')).sort(), [`${result.videos['clip.mp4']}.mp4`, `${result.videos['clip.webm']}.webm`].sort(), 'no partial copies are left');
  const read = await store.read(result.videos['clip.mp4']);
  assert.equal(read.mime, 'video/mp4');
  assert.ok(read.bytes.equals(body));
  assert.equal((await store.locate(result.videos['clip.webm'])).mime, 'video/webm');
  assert.equal(await store.read('../../etc/passwd'), null);
  await assert.rejects(action.execute({ title: 'Fake', html: '<video src="fake.mp4"></video>' }, caller), /"fake\.mp4" is not an MP4 or WebM video under 100 MB/);
  await assert.rejects(action.execute({ title: 'Out', html: '<video src="../outside.mp4"></video>' }, caller), /must be an existing file inside your working directory/);
  await assert.rejects(new ui.RenderHtmlFigureAction(undefined).execute({ title: 'None', html: '<video src="clip.mp4"></video>' }, caller), /local videos are unavailable here/);
  // A stored file replaced by something else is not served as a video.
  fs.writeFileSync(path.join(root, 'videos', `${result.videos['clip.mp4']}.mp4`), '<html>');
  assert.equal(await store.read(result.videos['clip.mp4']), null);
  // Containment is decided on the file actually opened, not a path checked earlier.
  fs.writeFileSync(path.join(root, 'private.mp4'), body);
  assert.equal(await store.fromFile(path.join(work, 'copy.mp4'), () => false), null);
  let linked = true;
  try { fs.symlinkSync(path.join(root, 'private.mp4'), path.join(work, 'swapped.mp4')); } catch (error) { if (error.code !== 'EPERM' || process.platform !== 'win32') throw error; linked = false; }
  if (linked) assert.equal(await store.fromFile(path.join(work, 'swapped.mp4'), (real) => real.startsWith(fs.realpathSync.native(work) + path.sep)), null, 'a link out of the project is refused when opened');
  // An expired copy is not served, even before a prune.
  const webm = path.join(root, 'videos', `${result.videos['clip.webm']}.webm`);
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(webm, old, old);
  assert.equal(await store.read(result.videos['clip.webm']), null);
  await store.prune();
  assert.equal(fs.existsSync(webm), false);
  fs.writeFileSync(path.join(work, 'big.webm'), Buffer.concat([WEBM_HEADER, Buffer.alloc(ui.MAX_FIGURE_VIDEO_BYTES)]));
  await assert.rejects(action.execute({ title: 'Big', html: '<video src="big.webm"></video>' }, caller), /not an MP4 or WebM video under 100 MB/);
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
function mountFrame({ channel = null, answered = new Map(), shared = null } = {}) {
  const file = fs.readFileSync('resources/js/Components/HtmlFigureFrame.vue', 'utf8');
  const blocks = [...file.matchAll(/<script(?: setup)? lang="ts">([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const executable = (source) => {
    const parsed = ts.createSourceFile('frame.ts', source, ts.ScriptTarget.Latest, true);
    return parsed.statements.filter((statement) => !ts.isImportDeclaration(statement)).map((statement) => statement.getFullText(parsed)).join('\n');
  };
  const transpile = (code) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const posted = [];
  const opened = [];
  const contentWindow = { postMessage: (message) => posted.push(message) };
  const clock = shared?.clock ?? { now: 0 };
  const performance = { now: () => clock.now };
  // The bar's place on screen, which tests move, and animation frames they step.
  const rect = { left: 0, top: 500, width: 600, height: 32 };
  const frames = [];
  const requestAnimationFrame = (callback) => frames.push(callback);
  // Whether the user just clicked or typed, and where focus is.
  const user = { active: true, focused: true };
  const frameElement = markRaw({ contentWindow });
  const navigator = { get userActivation() { return { isActive: user.active }; } };
  const document = { get activeElement() { return user.focused ? frameElement : null; } };
  // The module block runs once per window, so frames that share one also
  // share its state, as in the app; each frame runs its own setup.
  const group = shared ?? {};
  group.module ??= new Function('FIGURE_ID', 'performance', `${transpile(executable(blocks[1]))}
return function setup(computed, inject, onBeforeUnmount, onMounted, ref, watch, window, navigator, document, requestAnimationFrame, FIGURE_FRAME_SANDBOX, FIGURE_HEIGHT, figureAnswerText, figureAnswerKey, figureAnsweredKey, figureFrameUrl, defineProps, __frame, __bar) {
${transpile(executable(blocks[0]))}
frame.value = __frame;
bar.value = __bar;
return { onMessage, arm, confirm, request };
};`)(ui.FIGURE_ID, performance);
  const window = { addEventListener: () => {}, removeEventListener: () => {}, open: (...args) => opened.push(args) };
  const answerKey = Symbol('answer');
  const answeredKey = Symbol('answered');
  const api = group.module(computed, (key) => key === answerKey ? channel : key === answeredKey ? computed(() => answered) : null, () => {}, () => {}, ref, watch, window, navigator, document, requestAnimationFrame,
    ui.FIGURE_FRAME_SANDBOX, ui.FIGURE_HEIGHT, ui.figureAnswerText, answerKey, answeredKey, () => '/figure-frame', () => ({ html: '<p>x</p>', title: 'x', initialHeight: 100 }), frameElement, markRaw({ getBoundingClientRect: () => ({ ...rect }) }));
  // Runs the animation frames due now, as the browser would between events.
  const tick = () => { for (const callback of frames.splice(0)) callback(); };
  const fromPage = (data) => api.onMessage({ source: contentWindow, data: { source: 'patterm-figure', ...data } });
  // A real press: pointer down on the button, later the click.
  const press = async ({ trusted = true, wait = 600, between } = {}) => {
    tick();
    clock.now += wait;
    tick();
    api.arm({ isTrusted: trusted });
    between?.();
    await api.confirm({ isTrusted: trusted });
  };
  return { ...api, posted, opened, clock, rect, user, tick, fromPage, press };
}

function liveChannel() {
  const sent = [];
  return { sent, channel: { canSend: computed(() => true), queued: computed(() => new Map()), send: async (text) => { sent.push(text); } } };
}

const pick = (id, label, value, requestId = 1) => ({ type: 'answer', requestId, id, picks: [{ label, value }] });

const results = (frame) => frame.posted.filter((message) => message.type === 'answer-result').map((message) => [message.requestId, message.ok, message.error]);

test('a pick sends at once, but only as the user clicks or types in its page', async () => {
  const { sent, channel } = liveChannel();
  const frame = mountFrame({ channel });
  // A page answering on its own, from a timer or on load.
  frame.user.active = false;
  frame.fromPage(pick('q', 'Yes', 'yes', 1));
  // The user just clicked, but somewhere else in the app.
  frame.user.active = true;
  frame.user.focused = false;
  frame.fromPage(pick('q', 'Yes', 'yes', 2));
  await nextTick();
  assert.deepEqual(sent, [], 'no click in the page, no answer');
  assert.match(results(frame)[1][2], /only as the user clicks or types/);
  frame.user.focused = true;
  frame.fromPage(pick('q', 'Yes', 'yes', 3));
  frame.fromPage(pick('q', 'No', 'no', 4));
  await nextTick();
  assert.deepEqual(sent, ['Answer to q: Yes (yes)'], 'the pick goes straight to the agent');
  assert.equal(frame.request.value, null, 'nothing waits for a confirmation');
  assert.deepEqual(results(frame).slice(2), [[4, false, 'Patterm is still sending the last answer.'], [3, true, undefined]], 'a second pick while sending is refused');
});

test('a press opens only the link it began on, after it has stood still', async () => {
  const frame = mountFrame();
  frame.fromPage({ type: 'open-link', url: 'https://example.com/original' });
  // The page swaps its link while the button is held down.
  await frame.press({ between: () => frame.fromPage({ type: 'open-link', url: 'https://example.com/replaced' }) });
  assert.deepEqual(frame.opened, [], 'the swapped link needs its own press');
  assert.equal(frame.request.value.url, 'https://example.com/replaced', 'the user sees what changed');
  frame.fromPage({ type: 'open-link', url: 'https://example.com/late' });
  await frame.press({ wait: 100 });
  assert.deepEqual(frame.opened, [], 'a link that only just appeared is not pressed yet');
  await frame.press();
  assert.deepEqual(frame.opened.map(([url]) => url), ['https://example.com/late'], 'the user opened what they had time to read');
});

test('a bar that moved, for any reason, waits again before a press counts', async () => {
  const frame = mountFrame();
  frame.fromPage({ type: 'open-link', url: 'https://example.com/report' });
  frame.tick();
  frame.clock.now += 600;
  frame.tick();
  // The bar has stood still; now something moves it: this page shrinking,
  // or a page above it resizing.
  frame.rect.top = 176;
  await frame.press({ wait: 50 });
  assert.deepEqual(frame.opened, [], 'a bar that just moved is not pressed yet');
  // A move between pointer down and the click drops the press, even before
  // the next animation frame notices it.
  await frame.press({ between: () => { frame.rect.top = 300; } });
  assert.deepEqual(frame.opened, [], 'a press that began before the move does not count');
  await frame.press();
  assert.equal(frame.opened.length, 1, 'once it stands still the user can open it');
});

test('links open only after the user confirms the address in Patterm', async () => {
  const frame = mountFrame();
  frame.fromPage({ type: 'open-link', url: 'javascript:alert(1)' });
  frame.fromPage({ type: 'open-link', url: 'file:///etc/passwd' });
  assert.equal(frame.request.value, null, 'only web addresses are offered');
  frame.fromPage({ type: 'open-link', url: 'https://example.com/report' });
  assert.equal(frame.request.value.url, 'https://example.com/report');
  assert.deepEqual(frame.opened, [], 'asking opens nothing');
  await frame.press();
  assert.deepEqual(frame.opened, [['https://example.com/report', '_blank', 'noopener,noreferrer']]);
  assert.equal(frame.request.value, null);
});

test('pages outside a live conversation, or for answered questions, cannot answer', () => {
  const readOnly = mountFrame();
  readOnly.fromPage(pick('q', 'A', 'a'));
  assert.match(readOnly.posted.at(-1).error, /live conversation/);
  const { channel } = liveChannel();
  const answered = mountFrame({ channel, answered: new Map([['q', 'Answer to q: A (a)']]) });
  answered.fromPage(pick('q', 'B', 'b'));
  assert.match(answered.posted.at(-1).error, /Already answered/);
  const invalid = mountFrame({ channel });
  invalid.fromPage({ type: 'answer', requestId: 1, id: 'bad id', picks: [] });
  assert.match(invalid.posted.at(-1).error, /needs an id/);
  const stranger = mountFrame({ channel });
  stranger.onMessage({ source: {}, data: { source: 'patterm-figure', type: 'answer', requestId: 1, id: 'q', picks: [{ label: 'A', value: 'a' }] } });
  assert.deepEqual(stranger.posted, [], 'only this page\'s own frame is heard');
});


// A card shaped like the status cards: sample data in a JSON block, read by
// the script below it, with the block named in a comment first.
const CARD = `<!doctype html><html><head><meta charset="utf-8"><!-- Copy unchanged except the JSON in <script id="data">. --></head><body><div id="w"></div>
<script type="application/json" id="data">{"verdict":"RED","findings":[]}</script>
<script>const d = JSON.parse(document.getElementById('data').textContent); document.getElementById('w').textContent = d.verdict;</script></body></html>`;
const CARD_SCHEMA = {
  type: 'object',
  required: ['verdict'],
  additionalProperties: false,
  properties: {
    verdict: { enum: ['GREEN', 'YELLOW', 'RED'] },
    findings: { type: 'array', items: { type: 'object', required: ['kind', 'text'], properties: { kind: { enum: ['must', 'should', 'followup'] }, text: { type: 'string' } } } }
  }
};

function templateStore(now = () => new Date('2026-11-10T12:00:00Z')) {
  const connection = new DatabaseSync(':memory:');
  ui.figureTemplatesMigration.up({ connection, sql: (statement) => connection.exec(statement) });
  return new ui.FigureTemplateService({ connection }, now);
}
const agent = { role: 'agent', name: 'Implement templates', session_id: 'session_1' };

test('template versions are immutable: republishing the same files changes nothing, a change adds a version', () => {
  const templates = templateStore();
  const first = templates.publish({ name: 'status-cards/verdict', description: 'Review verdict', html: CARD, schema: CARD_SCHEMA, example: { verdict: 'GREEN' } }, agent);
  assert.deepEqual([first.version, first.unchanged, first.published_by, first.published_at], [1, false, { role: 'agent', name: 'Implement templates' }, '2026-11-10T12:00:00.000Z']);
  assert.equal(templates.publish({ name: 'status-cards/verdict', description: 'Review verdict', html: CARD, schema: CARD_SCHEMA, example: { verdict: 'GREEN' } }, agent).unchanged, true);
  const second = templates.publish({ name: 'status-cards/verdict', description: 'Review verdict', html: CARD.replace('RED', 'YELLOW'), schema: CARD_SCHEMA, example: { verdict: 'GREEN' } }, { role: 'assistant', name: null, session_id: 's2' });
  assert.equal(second.version, 2);
  assert.equal(templates.page('status-cards/verdict', 1).html, CARD, 'version 1 keeps its page');
  assert.deepEqual(templates.list().map((item) => [item.name, item.version, item.versions]), [['status-cards/verdict', 2, 2]]);
  assert.deepEqual(templates.history().map((item) => [item.version, item.published_by.role]), [[2, 'assistant'], [1, 'agent']]);
  const got = templates.get({ name: 'status-cards/verdict', version: 1 });
  assert.deepEqual([got.version, got.schema, got.example, 'html' in got], [1, CARD_SCHEMA, { verdict: 'GREEN' }, false], 'template_get never returns the page');
  assert.throws(() => templates.get({ name: 'status-cards/missing' }), /no template is saved as "status-cards\/missing"/);
});

test('publishing checks the schema, the example and the page before anything is saved', () => {
  const templates = templateStore();
  const base = { name: 'cards/x', html: CARD, schema: CARD_SCHEMA, example: { verdict: 'GREEN' } };
  assert.throws(() => templates.publish({ ...base, example: { verdict: 'BLUE' } }, agent), /nothing was published[\s\S]*example: verdict must be one of "GREEN", "YELLOW", "RED"/);
  assert.throws(() => templates.publish({ ...base, schema: { type: 'nonsense' } }, agent), /schema: /);
  assert.throws(() => templates.publish({ ...base, html: '<img src="shot.png">' }, agent), /templates cannot show local files \("shot\.png"\)/);
  assert.throws(() => templates.publish({ ...base, name: 'Bad Name' }, agent), /lowercase letters/);
  assert.throws(() => templates.publish({ name: 'cards/x', html: CARD, schema: CARD_SCHEMA }, agent), /example: send an example/);
  assert.throws(() => templates.publish({ ...base, schema: { $async: true, type: 'object', required: ['text'], properties: { text: { type: 'string' } } }, example: { text: 99 } }, agent), /schema: \$async schemas are not supported/);
  assert.deepEqual(templates.list(), []);
  const modern = templates.publish({ ...base, name: 'cards/modern', schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', prefixItems: [{ type: 'string' }], properties: { verdict: { const: 'GREEN' } } } }, agent);
  assert.equal(modern.version, 1, '2020-12 schemas compile');
  assert.throws(() => templates.publish({ ...base, name: 'cards/modern', schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', properties: { verdict: { const: 'RED' } } } }, agent), /example: verdict must be "RED"/);
});

test('html_render fills a template from checked data and records the version it drew', async () => {
  const templates = templateStore();
  templates.publish({ name: 'status-cards/verdict', html: CARD, schema: CARD_SCHEMA, example: { verdict: 'GREEN' } }, agent);
  const action = new ui.RenderHtmlFigureAction(undefined, undefined, templates);
  const caller = { cwd: null, project_path: null };
  const data = { verdict: 'GREEN', findings: [{ kind: 'must', text: 'a' }, { kind: 'should', text: 'b' }, { kind: 'nit', text: 'c' }] };
  await assert.rejects(action.execute({ id: 'verdict-1', title: 'Verdict', template: 'status-cards/verdict', data }, caller), (error) => {
    assert.match(error.message, /^html_render: nothing was rendered/);
    assert.match(error.message, /- findings\[2\]\.kind must be one of "must", "should", "followup"/);
    return true;
  });
  await assert.rejects(action.execute({ title: 'V', template: 'status-cards/verdict', data: { findings: [], extra: 1 } }, caller), /- verdict is required\n- data has an unknown field "extra"/);
  await assert.rejects(action.execute({ title: 'V', template: 'status-cards/nope', data: {} }, caller), /no template is saved as "status-cards\/nope"/);
  await assert.rejects(action.execute({ title: 'V', template: 'status-cards/verdict', version: 9, data: {} }, caller), /has no version 9/);
  await assert.rejects(action.execute({ title: 'V', template: 'status-cards/verdict' }, caller), /data: send the data/);
  await assert.rejects(action.execute({ title: 'V', html: CARD, template: 'status-cards/verdict', data: {} }, caller), /html or template, not both/);
  await assert.rejects(action.execute({ title: 'V', html: CARD, data: {} }, caller), /data and version go with template/);
  await assert.rejects(new ui.RenderHtmlFigureAction(undefined).execute({ title: 'V', template: 'status-cards/verdict', data: { verdict: 'RED' } }, caller), /templates are unavailable here/);
  const ok = await action.execute({ id: 'verdict-1', title: 'Verdict', template: 'status-cards/verdict', data: { verdict: 'RED' } }, caller);
  assert.deepEqual([ok.ref, ok.template], ['[patterm_figure:verdict-1]', { name: 'status-cards/verdict', version: 1 }]);
  templates.publish({ name: 'status-cards/verdict', html: CARD.replace('textContent = d.verdict', 'textContent = "v2 " + d.verdict'), schema: CARD_SCHEMA, example: { verdict: 'GREEN' } }, agent);
  assert.deepEqual((await action.execute({ title: 'V', template: 'status-cards/verdict', data: { verdict: 'RED' } }, caller)).template.version, 2, 'the latest by default');
  assert.deepEqual((await action.execute({ title: 'V', template: 'status-cards/verdict', version: 1, data: { verdict: 'RED' } }, caller)).template.version, 1);

  // The transcript row draws the version its reply recorded, in every
  // harness's reply shape.
  const input = { id: 'verdict-1', title: 'Verdict', template: 'status-cards/verdict', data: { verdict: 'RED' } };
  const row = { ...claude, input, output: JSON.stringify(ok) };
  assert.deepEqual(ui.figurePage(ui.figureToolInput(row)), { id: 'verdict-1', title: 'Verdict', template: 'status-cards/verdict', data: { verdict: 'RED' } });
  assert.deepEqual(ui.figureTemplate(row), { name: 'status-cards/verdict', version: 1 });
  assert.equal(ui.figureId(row), 'verdict-1');
  const codex = { ...claude, name: 'patterm', input: { server: 'patterm', tool: 'html_render', arguments: JSON.stringify(input) }, output: undefined, result: { content: [{ type: 'text', text: JSON.stringify(ok, null, 2) }], structuredContent: null } };
  assert.deepEqual(ui.figureTemplate(codex), { name: 'status-cards/verdict', version: 1 });
  assert.equal(ui.figureTemplate({ ...row, output: JSON.stringify({ ok: true, template: { name: 'Bad', version: 1 } }) }), null);
});

test('a template\'s data replaces its sample block, and nothing in it can close the script', () => {
  const data = { verdict: 'RED', text: '</script><script>alert(1)</script> \u2028' };
  const filled = ui.fillFigureTemplate(CARD, data);
  assert.equal(filled.split('id="data"').length - 1, 2, 'the comment keeps its mention and the one block is replaced');
  assert.ok(filled.includes('<!-- Copy unchanged except the JSON in <script id="data">. -->'));
  assert.ok(!filled.includes('"findings":[]'), 'the sample data is gone');
  assert.ok(!filled.includes('</script><script>alert'), 'a closing tag in the data is escaped');
  const block = /<script type="application\/json" id="data">([\s\S]*?)<\/script>/.exec(filled);
  assert.deepEqual(JSON.parse(block[1]), data);
  // A full block in a comment, one opened in a comment, and lookalike
  // attributes are all left alone; only the real block is replaced.
  const tricky = CARD
    .replace('<script id="data">', '<script type="application/json" id="data">{"in":"comment"}</script>')
    .replace('<div id="w"></div>', '<!-- <script type="application/json" id="data"> --><div id="w"></div><script type="application/json" data-id="data">{"keep":1}</script><script>var s = \'<script type="application/json" id="data">\';</script>');
  const replaced = ui.fillFigureTemplate(tricky, { a: 1 });
  assert.equal(replaced.length, tricky.length - '{"verdict":"RED","findings":[]}'.length + '{"a":1}'.length, 'only the sample data changed');
  assert.ok(replaced.includes('{"in":"comment"}') && replaced.includes('{"keep":1}') && replaced.includes('<div id="w"></div>'));
  assert.match(ui.fillFigureTemplate('<p></p><SCRIPT ID=data TYPE="Application/JSON">{}</SCRIPT>', { a: 1 }), /^<p><\/p><script type="application\/json" id="data">\{"a":1\}<\/script>$/);
  assert.match(ui.fillFigureTemplate('<html><head></head><body></body></html>', { a: 1 }), /^<html><head><script type="application\/json" id="data">\{"a":1\}<\/script><\/head>/);
  const prepared = ui.prepareFigureHtml(filled, '', data);
  assert.ok(prepared.indexOf('id="patterm-theme"') < prepared.indexOf('id="data">'));
  assert.match(prepared, /data: \{"verdict":"RED","text":"\\u003c\/script>/, 'patterm.data carries the data');
  assert.match(ui.prepareFigureHtml('<p>x</p>'), /data: null\n/, 'raw pages have no data');
});
