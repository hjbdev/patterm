import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { build } from 'esbuild';
import { computed, ref } from 'vue';

const page = fs.readFileSync(new URL('../resources/js/Components/TerminalPane.vue', import.meta.url), 'utf8');
const source = page.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
const parsed = ts.createSourceFile('pane.ts', source, ts.ScriptTarget.Latest, true);
const executable = parsed.statements.filter(s => !ts.isImportDeclaration(s)).map(s => s.getFullText(parsed)).join('\n');
const { outputText } = ts.transpileModule(executable, { compilerOptions: { target: ts.ScriptTarget.ES2022 } });
const bundled = await build({
  stdin: { contents: `export * from './resources/js/terminal/TerminalRenderer';
    export * from './resources/js/terminal/TerminalFrameCadence';`, resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'cjs', write: false
});
const module = { exports: {} };
new Function('module', bundled.outputFiles[0].text)(module);

function mount({ controlling = true, mouse = false, subscribeReply = () => undefined } = {}) {
  const document = { visibilityState: 'visible', hasFocus: () => true, createElement: () => ({ getContext: () => null }) };
  globalThis.document = document;
  const canvas = { style: {}, title: '', getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 18 }) };
  const renderer = new module.exports.TerminalRenderer(canvas);
  const frames = new Map();
  const requests = [];
  const emitted = [];
  let frameId = 0;
  const bindings = {
    ...module.exports, computed, ref, watch() {}, onMounted() {}, onBeforeUnmount() {},
    defineProps: () => ({}), defineEmits: () => (...args) => emitted.push(args), DEFAULT_APPEARANCE_SETTINGS: {},
    window: { open: (...args) => requests.push(['open', ...args]), patterm: { runtime: 'browser',
      terminalSubscribe: async args => { requests.push(['subscribe', args]); return subscribeReply(args); },
      terminalConfigure: async () => {},
      terminalStatus: async () => ({}),
      terminalResize: async args => requests.push(['resize', args]),
      terminalInput: async args => requests.push(['input', args]),
      terminalMouse: async args => requests.push(['mouse', args]),
      terminalRefresh: async args => requests.push(['refresh', args]),
      terminalSelectionText: async () => ({ text: 'Selected terminal text' }),
      writeClipboardText: async text => requests.push(['clipboard', text]),
      terminalSelect: async args => requests.push(['selection', args]) } },
    document, localStorage: { getItem: () => null },
    requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: id => frames.delete(id)
  };
  const setup = new Function(...Object.keys(bindings), `${outputText}\nreturn {
    attach(value, element, control, mouse) { renderer = value; canvas.value = element; processId = 'p'; terminalFramesSubscribed = true; controlling.value = control; terminalMouseMode.click = mouse; },
    handleMouseDown, handleMouseMove, handleMouseUp, handleMouseLeave,
    handleWindowBlur, handleWindowFocus, handleVisibilityChange, enqueueTerminalFrame,
    copySelection, selectedText, clearSelectionCapture, captureSelection,
    applyTarget, handleTerminalControl, sendTerminalInput
  };`);
  const pane = setup(...Object.values(bindings));
  pane.attach(renderer, canvas, controlling, mouse);
  return { pane, renderer, canvas, document, requests, emitted, paint() {
    const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(0));
  } };
}

function frame(kind, text, epoch = 1, links = null) {
  const bytes = [];
  const u16 = value => bytes.push(value & 255, (value >>> 8) & 255);
  const u32 = value => { u16(value); u16(value >>> 16); };
  u16(links === null ? 2 : 3); bytes.push(kind === 'snapshot' ? 0 : 1); u32(1); u32(epoch); u32(0);
  u16(1); bytes.push(112); // Process ID: p.
  u16(Math.max(2, text.length)); u16(1); u16(0); u16(0); bytes.push(1, 0); u16(1);
  u16(0); u16(0); u16(Math.max(2, text.length));
  for (const character of text.padEnd(2)) {
    u32(character.codePointAt(0)); u16(0); bytes.push(0); u32(256); bytes.push(0); u32(257);
  }
  if (links !== null) {
    u16(links.length);
    for (const { start, count, uri } of links) {
      const encoded = new TextEncoder().encode(uri);
      u16(0); u16(start); u16(count); u16(encoded.length); bytes.push(...encoded);
    }
  }
  return Uint8Array.from(bytes);
}

for (const event of ['handleWindowFocus', 'handleWindowBlur']) {
  test(`${event} preserves the resumed snapshot and subsequent terminal output`, () => {
    const { pane, renderer, document, requests, paint } = mount();
    pane.enqueueTerminalFrame(frame('snapshot', 'A'));
    paint();
    document.visibilityState = 'hidden';
    pane.handleVisibilityChange();
    assert.deepEqual(requests.at(-1), ['subscribe', { process_id: 'p', subscribed: false }]);
    pane.enqueueTerminalFrame(frame('snapshot', 'B', 2)); // Hidden output is ignored.
    document.visibilityState = 'visible';
    pane.handleVisibilityChange();
    assert.ok(requests.some(([name, args]) => name === 'subscribe' && args.subscribed));
    pane.enqueueTerminalFrame(frame('snapshot', 'B', 2));
    document.hasFocus = () => event === 'handleWindowFocus';
    pane[event](); // Focus can change before the pending animation frame paints.
    paint();
    pane.enqueueTerminalFrame(frame('damage', 'C', 2));
    paint();
    assert.equal(renderer.debugState().lastFrameDecision.action, 'applied');
    assert.equal(renderer.debugState().model.epoch, 2, 'the resumed snapshot must reach the renderer');
  });
}

test('visible blur preserves queued damage without requesting a snapshot', () => {
  const { pane, renderer, document, requests, paint } = mount();
  pane.enqueueTerminalFrame(frame('snapshot', 'A'));
  paint();
  pane.enqueueTerminalFrame(frame('damage', 'B', 1));
  document.hasFocus = () => false;
  pane.handleWindowBlur();
  paint();
  assert.equal(renderer.cells[0][0].char, 'B');
  assert.deepEqual(requests, [], 'a visible blur keeps the existing subscription');
});

test('selection capture expires after five seconds without changing the clipboard', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { pane, requests } = mount();
  await pane.copySelection();
  assert.equal(pane.selectedText.value, 'Selected terminal text');
  t.mock.timers.tick(4999);
  assert.equal(pane.selectedText.value, 'Selected terminal text');
  t.mock.timers.tick(1);
  assert.equal(pane.selectedText.value, '');
  assert.deepEqual(requests.filter(([name]) => name === 'clipboard'), [['clipboard', 'Selected terminal text']]);
});

test('copying the same selection restarts the five-second capture timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { pane } = mount();
  await pane.copySelection();
  t.mock.timers.tick(4000);
  await pane.copySelection();
  t.mock.timers.tick(1000);
  assert.equal(pane.selectedText.value, 'Selected terminal text');
  t.mock.timers.tick(4000);
  assert.equal(pane.selectedText.value, '');
});

test('dismissing selection capture does not save; saving emits the selected text once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { pane, emitted } = mount();
  await pane.copySelection();
  pane.clearSelectionCapture();
  assert.equal(pane.selectedText.value, '');
  assert.deepEqual(emitted, []);
  await pane.copySelection();
  pane.captureSelection();
  assert.equal(pane.selectedText.value, '');
  assert.deepEqual(emitted, [['captureSelection', 'Selected terminal text']]);
  t.mock.timers.tick(5000);
  assert.equal(emitted.length, 1);
});

function mouseEvent(col, overrides = {}) {
  return { button: 0, buttons: 0, clientX: col * 9 + 2, clientY: 5,
    shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {}, ...overrides };
}

test('clicking an OSC 8 label in terminal output opens its hidden URL', () => {
  const { pane, requests, paint } = mount();
  pane.enqueueTerminalFrame(frame('snapshot', "It's on PR #85", 1,
    [{ start: 11, count: 3, uri: 'https://github.com/example/repo/pull/85' }]));
  paint();
  pane.handleMouseDown(mouseEvent(12, { buttons: 1 }));
  pane.handleMouseUp(mouseEvent(12));
  assert.deepEqual(requests.filter(([name]) => name === 'open'),
    [['open', 'https://github.com/example/repo/pull/85', '_blank', 'noopener,noreferrer']]);
});

const prUrl = 'https://github.com/example/repo/pull/85';

function linkedPane(options) {
  const harness = mount(options);
  harness.pane.enqueueTerminalFrame(frame('snapshot', "It's on PR #85", 1,
    [{ start: 11, count: 3, uri: prUrl }]));
  harness.paint();
  return harness;
}

test('link hover shows the destination and resets on leaving the canvas', () => {
  const { pane, canvas } = linkedPane();
  pane.handleMouseMove(mouseEvent(12));
  assert.equal(canvas.style.cursor, 'pointer');
  assert.equal(canvas.title, prUrl);
  pane.handleMouseLeave();
  assert.equal(canvas.style.cursor, '');
  assert.equal(canvas.title, '');
});

test('dragging a link selects text without opening it, even after returning to the start', async () => {
  const { pane, requests } = linkedPane();
  pane.handleMouseDown(mouseEvent(12, { buttons: 1 }));
  pane.handleMouseMove(mouseEvent(8, { buttons: 1 }));
  pane.handleMouseMove(mouseEvent(12, { buttons: 1 }));
  pane.handleMouseUp(mouseEvent(12));
  assert.ok(requests.some(([name]) => name === 'selection'));
  assert.ok(!requests.some(([name]) => name === 'open'));
  await new Promise(resolve => setImmediate(resolve));
  pane.clearSelectionCapture();
});

test('shared-terminal viewers can open links without sending PTY input', () => {
  const { pane, requests } = linkedPane({ controlling: false });
  pane.handleMouseDown(mouseEvent(12));
  pane.handleMouseUp(mouseEvent(12));
  assert.deepEqual(requests, [['open', prUrl, '_blank', 'noopener,noreferrer']]);
});

test('mouse capture receives normal clicks; Ctrl/Cmd-click opens links locally', () => {
  for (const modifier of ['ctrlKey', 'metaKey']) {
    const { pane, requests } = linkedPane({ mouse: true });
    pane.handleMouseDown(mouseEvent(12));
    pane.handleMouseUp(mouseEvent(12));
    assert.deepEqual(requests.map(([name]) => name), ['mouse', 'mouse']);
    requests.length = 0;
    pane.handleMouseDown(mouseEvent(12, { [modifier]: true }));
    pane.handleMouseUp(mouseEvent(12, { [modifier]: true }));
    assert.deepEqual(requests, [['open', prUrl, '_blank', 'noopener,noreferrer']]);
  }
});

test('Shift-click, right-click, and mouseup without mousedown do not open links', () => {
  for (const overrides of [{ shiftKey: true }, { button: 2 }]) {
    const { pane, requests } = linkedPane();
    pane.handleMouseDown(mouseEvent(12, overrides));
    pane.handleMouseUp(mouseEvent(12, overrides));
    assert.ok(!requests.some(([name]) => name === 'open'));
  }
  const { pane, requests } = linkedPane();
  pane.handleMouseUp(mouseEvent(12));
  assert.deepEqual(requests, []);
});

test('damage replaces link destinations and clears removed links', () => {
  const { pane, renderer, paint } = linkedPane();
  pane.enqueueTerminalFrame(frame('damage', "It's on PR #85", 1,
    [{ start: 11, count: 3, uri: 'https://example.com/replaced' }]));
  paint();
  assert.equal(renderer.linkAt(12, 0), 'https://example.com/replaced');
  pane.enqueueTerminalFrame(frame('damage', "It's on PR #85", 1, []));
  paint();
  assert.equal(renderer.linkAt(12, 0), null);
  renderer.clear();
  assert.equal(renderer.linkAt(12, 0), null);
});

test('changed destinations during a click do not open a different link', () => {
  const { pane, requests, paint } = linkedPane();
  pane.handleMouseDown(mouseEvent(12));
  pane.enqueueTerminalFrame(frame('damage', "It's on PR #85", 1,
    [{ start: 11, count: 3, uri: 'https://example.com/replaced' }]));
  paint();
  pane.handleMouseUp(mouseEvent(12));
  assert.ok(!requests.some(([name]) => name === 'open'));
});

test('terminal links accept only valid HTTP(S) destinations', () => {
  for (const uri of ['javascript:alert(1)', 'data:text/html,test', 'file:///tmp/test', 'vscode://file/tmp/test', '/relative', 'https://']) {
    const { pane, renderer, requests, paint } = mount();
    pane.enqueueTerminalFrame(frame('snapshot', '#85', 1, [{ start: 0, count: 3, uri }]));
    paint();
    assert.equal(renderer.linkAt(1, 0), null, uri);
    pane.handleMouseDown(mouseEvent(1));
    pane.handleMouseUp(mouseEvent(1));
    assert.ok(!requests.some(([name]) => name === 'open'), uri);
  }
});

test('malformed hyperlink spans and truncated destinations reject the frame', () => {
  for (const link of [
    { start: 2, count: 2, uri: prUrl },
    { start: 0, count: 0, uri: prUrl }
  ]) {
    assert.equal(module.exports.parseDamageFrame(frame('snapshot', '#85', 1, [link])), null);
  }
  const valid = frame('snapshot', '#85', 1, [{ start: 0, count: 3, uri: prUrl }]);
  assert.equal(module.exports.parseDamageFrame(valid.subarray(0, valid.length - 1)), null);
});

// Switching measures the canvas, which reads the device pixel ratio.
globalThis.window ??= { devicePixelRatio: 1 };
const settle = () => new Promise(resolve => setImmediate(resolve));
const sent = (requests, kind) => requests.filter(([type]) => type === kind).map(([, args]) => args);

test('input typed during a switch waits for control and is sent in order', async () => {
  const { pane, requests } = mount({ subscribeReply: () => ({ ok: true, controlling: true, resized: true }) });
  pane.applyTarget('q');
  pane.sendTerminalInput({ kind: 'text', text: 'l' });
  pane.sendTerminalInput({ kind: 'text', text: 's' });
  assert.deepEqual(sent(requests, 'input'), [], 'nothing reaches the terminal before control is known');
  pane.handleTerminalControl({ processId: 'q', controlling: true });
  assert.deepEqual(sent(requests, 'input').map(args => [args.process_id, args.text]), [['q', 'l'], ['q', 's']]);
  pane.sendTerminalInput({ kind: 'text', text: '\r' });
  assert.equal(sent(requests, 'input').at(-1).text, '\r', 'later input is sent directly');
});

test('input typed during a switch is dropped when another browser controls the terminal', async () => {
  const { pane, requests } = mount({ subscribeReply: () => ({ ok: true, controlling: false }) });
  pane.applyTarget('q');
  pane.sendTerminalInput({ kind: 'text', text: 'rm' });
  pane.handleTerminalControl({ processId: 'q', controlling: false });
  await settle();
  pane.handleTerminalControl({ processId: 'q', controlling: true });
  assert.deepEqual(sent(requests, 'input'), [], 'a viewer never replays input typed before taking control');
});

test('a browser sends its size with the subscription and skips the duplicate resize', async () => {
  const { pane, requests, paint } = mount({ subscribeReply: () => ({ ok: true, controlling: true, resized: true }) });
  pane.applyTarget('q');
  const subscribe = sent(requests, 'subscribe').find(args => args.process_id === 'q' && args.subscribed);
  assert.ok(subscribe.cols > 0 && subscribe.rows > 0 && subscribe.resize_seq > 0, 'the subscription carries the pane size and resize sequence');
  pane.handleTerminalControl({ processId: 'q', controlling: true });
  await settle();
  paint();
  assert.deepEqual(sent(requests, 'resize'), [], 'the server already sized the terminal, so no resize follows');
});

test('a controller resizes after the reply when the server did not apply its size', async () => {
  const { pane, requests, paint } = mount({ subscribeReply: () => ({ ok: true, controlling: true }) });
  pane.applyTarget('q');
  pane.handleTerminalControl({ processId: 'q', controlling: true });
  paint();
  assert.deepEqual(sent(requests, 'resize'), [], 'no resize is sent while the reply is pending');
  await settle();
  paint();
  const [resize] = sent(requests, 'resize');
  const subscribe = sent(requests, 'subscribe').find(args => args.process_id === 'q' && args.subscribed);
  assert.deepEqual([resize?.cols, resize?.rows], [subscribe.cols, subscribe.rows], 'the pane size is sent once the reply shows it was not applied');
});
