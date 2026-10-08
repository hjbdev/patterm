import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import ts from 'typescript';
import * as vue from 'vue';

const require = createRequire(import.meta.url);

// The scroller runs against a minimal DOM: element classes for its instanceof
// checks, computed styles, and frame and timer queues that each step flushes.
class FakeElement {}
class FakeHTMLElement extends FakeElement {}
class FakeButton extends FakeHTMLElement {}
const element = (fields) => Object.setPrototypeOf(fields, FakeHTMLElement.prototype);
const frames = [];
const timers = new Map();
let nextTimer = 1;
const fakeWindow = {
  getComputedStyle: (target) => ({ overflowY: target.overflowY ?? 'visible' }),
  requestAnimationFrame: (callback) => frames.push(callback),
  cancelAnimationFrame: () => {},
  setTimeout: (callback) => { const id = nextTimer++; timers.set(id, callback); return id; },
  clearTimeout: (id) => { timers.delete(id); },
  addEventListener() {},
  removeEventListener() {},
  matchMedia: () => ({ matches: false })
};
const flushFrames = () => { while (frames.length) frames.shift()(0); };
const flushTimers = () => { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } };
const transpile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

const engineSource = fs.readFileSync(new URL('../resources/js/Components/ui/message-scroller/useMessageScroller.ts', import.meta.url), 'utf8');
const engineModule = { exports: {} };
const vueBindings = { ...vue, provide() {}, inject: () => null, onMounted() {}, onScopeDispose() {} };
new Function('exports', 'require', 'module', 'window', 'HTMLElement', transpile(engineSource))(
  engineModule.exports, (id) => id === 'vue' ? vueBindings : require(id), engineModule, fakeWindow, FakeHTMLElement
);
const { provideMessageScroller, UPWARD_SCROLL_KEYS } = engineModule.exports;

const viewportPage = fs.readFileSync(new URL('../resources/js/Components/ui/message-scroller/MessageScrollerViewport.vue', import.meta.url), 'utf8');
const viewportSource = viewportPage.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
const parsedViewport = ts.createSourceFile('viewport.ts', viewportSource, ts.ScriptTarget.Latest, true);
const viewportScript = transpile(parsedViewport.statements.filter((statement) => !ts.isImportDeclaration(statement))
  .map((statement) => statement.getFullText(parsedViewport)).join('\n'));

function createViewport({ scrollTop = 400 } = {}) {
  const intents = [];
  const root = element({ dataset: {}, scrollTop, focus() {} });
  const bindings = {
    defineProps: () => ({}),
    defineExpose() {},
    useTemplateRef: () => ({ value: root }),
    onMounted() {},
    onBeforeUnmount() {},
    cn: () => '',
    UPWARD_SCROLL_KEYS,
    useMessageScrollerContext: () => ({
      userScrollIntent: () => intents.push('intent'),
      scrollToStart: () => intents.push('start'),
      scrollToEnd: () => intents.push('end')
    }),
    window: fakeWindow,
    document: { activeElement: null },
    Element: FakeElement,
    HTMLElement: FakeHTMLElement,
    HTMLButtonElement: FakeButton,
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    HTMLSelectElement: class {}
  };
  const handlers = new Function(...Object.keys(bindings), `${viewportScript}\nreturn { onWheel, onKeyDown, onTouchStart };`)(...Object.values(bindings));
  return { handlers, intents, root };
}

// A touch target that records its listeners, as an element of a streaming
// reply does after Markdown has replaced it.
function touchTarget(parentElement) {
  const listeners = {};
  return Object.assign(element({ parentElement }), {
    listeners,
    addEventListener: (type, listener) => { listeners[type] = listener; },
    removeEventListener: (type) => { delete listeners[type]; }
  });
}

// A viewport over one content block of a given height, as the virtualised
// transcript renders it. Scrolling fires one scroll event; new output grows
// the content and runs the resize handling.
function createScroller({ clientHeight = 500, contentHeight = 2000 } = {}) {
  const page = { contentHeight, clientHeight };
  const viewport = element({
    dataset: {},
    scrollTop: 0,
    get clientHeight() { return page.clientHeight; },
    get scrollHeight() { return Math.max(page.contentHeight, page.clientHeight); },
    scrollTo({ top }) { this.scrollTop = Math.min(Math.max(0, top), this.scrollHeight - page.clientHeight); }
  });
  const engine = provideMessageScroller({ autoScroll: true, defaultScrollPosition: 'end' });
  engine.context.setViewportElement(viewport);
  engine.registerMessage('row', element({}), null);
  const context = engine.context;
  return {
    viewport,
    context,
    page,
    end: () => viewport.scrollHeight - page.clientHeight,
    following: () => context.isFollowing(),
    intent: (options) => context.userScrollIntent(options),
    scrollTo(top) {
      viewport.scrollTop = top;
      context.handleScroll();
    },
    scrollEnd() { context.handleScrollEnd(); },
    grow(px) {
      page.contentHeight += px;
      context.handleResize();
      const before = viewport.scrollTop;
      flushFrames();
      // The browser reports the glide's writes with one scroll event.
      if (viewport.scrollTop !== before) context.handleScroll();
    },
    hide(hidden) {
      page.clientHeight = hidden ? 0 : clientHeight;
      context.handleResize();
    }
  };
}

test('only input that can move the transcript up stops following', () => {
  const { handlers, intents, root } = createViewport();
  const row = element({ parentElement: root });
  handlers.onWheel({ deltaY: 100, deltaX: 0, target: row });
  handlers.onWheel({ deltaY: 0, deltaX: 60, target: row });
  handlers.onWheel({ deltaY: -3, deltaX: 60, target: row });
  handlers.onWheel({ deltaY: -100, deltaX: 0, ctrlKey: true, target: row });
  for (const key of ['PageDown', 'ArrowDown', ' ']) handlers.onKeyDown({ key, shiftKey: false });
  handlers.onKeyDown({ key: ' ', shiftKey: true, target: new FakeButton() });
  assert.equal(intents.length, 0, 'scrolling down, sideways, zooming, or pressing a button keeps following');

  handlers.onWheel({ deltaY: -100, deltaX: 0, target: row });
  assert.equal(intents.length, 1, 'a wheel up stops following');
  for (const key of ['ArrowUp', 'PageUp']) handlers.onKeyDown({ key, shiftKey: false });
  handlers.onKeyDown({ key: ' ', shiftKey: true });
  assert.equal(intents.length, 4, 'keys that scroll up stop following');

  const target = touchTarget(null);
  handlers.onTouchStart({ touches: [{ clientY: 300 }], target });
  target.listeners.touchmove({ touches: [{ clientY: 250 }], target });
  assert.equal(intents.length, 4, 'dragging the content up keeps following');
  target.listeners.touchmove({ touches: [{ clientY: 320 }], target });
  assert.equal(intents.length, 5, 'dragging a replaced reply down still stops following');
  target.listeners.touchend();
  assert.equal(target.listeners.touchmove, undefined, 'the touch listeners go when the touch ends');
});

test('input at the top of the transcript does not stop following', () => {
  const { handlers, intents, root } = createViewport({ scrollTop: 0 });
  handlers.onWheel({ deltaY: -100, deltaX: 0, target: element({ parentElement: root }) });
  handlers.onKeyDown({ key: 'PageUp', shiftKey: false });
  assert.equal(intents.length, 0);
});

test('Home and End go straight to either end', () => {
  const { handlers, intents } = createViewport();
  const prevented = [];
  handlers.onKeyDown({ key: 'Home', preventDefault: () => prevented.push('Home') });
  handlers.onKeyDown({ key: 'End', preventDefault: () => prevented.push('End') });
  assert.deepEqual(intents, ['start', 'end']);
  assert.deepEqual(prevented, ['Home', 'End']);
});

test('a scroll that a tool output takes keeps following', () => {
  const { handlers, intents, root } = createViewport();
  const output = element({ parentElement: root, scrollTop: 40, scrollHeight: 600, clientHeight: 320, overflowY: 'auto' });
  const line = element({ parentElement: output });
  handlers.onWheel({ deltaY: -100, deltaX: 0, target: line });
  assert.equal(intents.length, 0, 'an output that can still scroll up takes the wheel');
  output.scrollTop = 0;
  handlers.onWheel({ deltaY: -100, deltaX: 0, target: line });
  assert.equal(intents.length, 1, 'at the top of the output the wheel scrolls the transcript');
});

test('new output is followed from anywhere within 80px of the end once the scroll ends', () => {
  const scroller = createScroller();
  scroller.scrollTo(scroller.end());
  scroller.grow(100);
  assert.equal(scroller.viewport.scrollTop, scroller.end(), 'output at the end is followed');

  scroller.intent();
  scroller.scrollTo(scroller.viewport.scrollTop - 50);
  scroller.scrollEnd();
  scroller.grow(100);
  assert.equal(scroller.viewport.scrollTop, scroller.end(), 'a scroll up inside the zone still follows');

  scroller.intent();
  scroller.scrollTo(scroller.viewport.scrollTop - 120);
  scroller.scrollEnd();
  const reading = scroller.viewport.scrollTop;
  scroller.grow(100);
  assert.equal(scroller.viewport.scrollTop, reading, 'past the zone the reader keeps their place');

  scroller.scrollTo(scroller.end() - 30);
  scroller.grow(100);
  assert.equal(scroller.viewport.scrollTop, scroller.end(), 'stopping 30px short of the end resumes following');
});

test('an animated scroll up that starts inside the zone is not pulled back', () => {
  const scroller = createScroller();
  scroller.scrollTo(scroller.end());
  scroller.intent();
  // Page Up: the first frames are still within 80px of the end while new
  // output keeps arriving.
  scroller.scrollTo(scroller.viewport.scrollTop - 30);
  scroller.grow(20);
  scroller.scrollTo(scroller.viewport.scrollTop - 40);
  scroller.grow(20);
  scroller.scrollTo(scroller.viewport.scrollTop - 300);
  scroller.scrollEnd();
  const reading = scroller.viewport.scrollTop;
  scroller.grow(100);
  assert.equal(scroller.viewport.scrollTop, reading, 'the page up lands and stays');
  assert.equal(scroller.following(), false);
});

test('a short scroll up from the end returns to it although output moved the end away', () => {
  const scroller = createScroller();
  scroller.scrollTo(scroller.end());
  scroller.intent();
  // A 53px wheel notch animates while 60px of new output arrives.
  scroller.scrollTo(scroller.viewport.scrollTop - 25);
  scroller.grow(30);
  scroller.scrollTo(scroller.viewport.scrollTop - 28);
  scroller.grow(30);
  scroller.scrollEnd();
  assert.equal(scroller.following(), true);
  scroller.grow(50);
  assert.equal(scroller.viewport.scrollTop, scroller.end());
});

test('a short scroll up catches up with output that took the end out of reach', () => {
  const scroller = createScroller();
  scroller.scrollTo(scroller.end());
  scroller.intent();
  scroller.scrollTo(scroller.viewport.scrollTop - 50);
  scroller.grow(600);
  scroller.scrollEnd();
  flushFrames();
  assert.equal(scroller.following(), true);
  assert.equal(scroller.viewport.scrollTop, scroller.end(), 'no more output needs to arrive');
  assert.equal(scroller.context.scrollable.value.end, false);
});

test('a short look up with no new output stays where it lands', () => {
  const scroller = createScroller();
  scroller.scrollTo(scroller.end());
  scroller.intent();
  scroller.scrollTo(scroller.viewport.scrollTop - 50);
  scroller.scrollEnd();
  flushFrames();
  assert.equal(scroller.following(), true, 'the next output is followed');
  assert.equal(scroller.viewport.scrollTop, scroller.end() - 50, 'but the view does not bounce back on its own');
});

test('a slow trackpad scroll that ends each step adds up', () => {
  const scroller = createScroller();
  scroller.scrollTo(scroller.end());
  // Chrome on Linux ends the scroll after almost every small trackpad step.
  for (let step = 0; step < 20; step++) {
    scroller.intent();
    scroller.scrollTo(scroller.viewport.scrollTop - 15);
    scroller.scrollEnd();
    flushFrames();
  }
  assert.equal(scroller.following(), false);
  assert.equal(scroller.viewport.scrollTop, scroller.end() - 300, 'the view stays where the reader left it');
});

test('a trackpad gesture whose wheel events arrive after their scroll adds up', () => {
  const scroller = createScroller();
  scroller.scrollTo(scroller.end());
  // The first wheel event comes before its scroll; the rest of the gesture is
  // scrolled by the compositor before the page sees each wheel event.
  scroller.intent();
  scroller.scrollTo(scroller.viewport.scrollTop - 15);
  for (let step = 0; step < 19; step++) {
    scroller.viewport.scrollTop -= 15;
    scroller.intent();
    scroller.context.handleScroll();
  }
  scroller.scrollEnd();
  flushTimers();
  flushFrames();
  assert.equal(scroller.following(), false);
  assert.equal(scroller.viewport.scrollTop, scroller.end() - 300, 'the view stays where the reader left it');
});

// A row above the view measures `px` taller (or shorter) and the virtualiser
// corrects the view to match, but its scroll event has not arrived yet.
function pendingCorrection(scroller, px) {
  const from = scroller.viewport.scrollTop;
  scroller.page.contentHeight += px;
  scroller.viewport.scrollTop += px;
  scroller.context.noteProgrammaticScroll(from);
}

// The compositor scrolls the reader up before the page sees the wheel event.
function trackpadStep(scroller, px) {
  scroller.viewport.scrollTop -= px;
  scroller.intent();
  scroller.context.handleScroll();
}

test('a correction still to be reported during a long trackpad scroll is not travel', () => {
  const scroller = createScroller();
  scroller.scrollTo(scroller.end());
  scroller.intent();
  scroller.scrollTo(scroller.viewport.scrollTop - 120);
  pendingCorrection(scroller, 100);
  trackpadStep(scroller, 15);
  scroller.scrollEnd();
  flushTimers();
  flushFrames();
  assert.equal(scroller.following(), false);
  assert.equal(scroller.end() - scroller.viewport.scrollTop, 135);
});

test('a correction still to be reported during a short trackpad scroll does not block catching up', () => {
  const scroller = createScroller();
  scroller.scrollTo(scroller.end());
  scroller.intent();
  scroller.scrollTo(scroller.viewport.scrollTop - 20);
  pendingCorrection(scroller, -100);
  trackpadStep(scroller, 15);
  scroller.page.contentHeight += 100;
  scroller.context.handleResize({ glide: true });
  scroller.scrollEnd();
  flushTimers();
  flushFrames();
  assert.equal(scroller.following(), true);
  assert.equal(scroller.viewport.scrollTop, scroller.end());
});

test('output whose resize is still to come is not the reader\'s travel', () => {
  const scroller = createScroller();
  scroller.scrollTo(scroller.end());
  // Output lands before its deferred resize handling runs.
  scroller.page.contentHeight += 60;
  scroller.intent();
  scroller.scrollTo(scroller.viewport.scrollTop - 50);
  scroller.context.handleResize({ glide: true });
  scroller.scrollEnd();
  flushFrames();
  assert.equal(scroller.following(), true);
  assert.equal(scroller.viewport.scrollTop, scroller.end());
});

test('scrolling back to the end forgets where the reader rested', () => {
  const scroller = createScroller();
  scroller.scrollTo(scroller.end());
  scroller.intent();
  scroller.scrollTo(scroller.viewport.scrollTop - 60);
  scroller.scrollEnd();
  scroller.scrollTo(scroller.end());
  scroller.scrollEnd();
  scroller.intent();
  scroller.scrollTo(scroller.viewport.scrollTop - 50);
  scroller.context.handleResize({ glide: true });
  scroller.page.contentHeight += 60;
  scroller.context.handleResize({ glide: true });
  scroller.scrollEnd();
  flushFrames();
  assert.equal(scroller.following(), true);
  assert.equal(scroller.viewport.scrollTop, scroller.end());
});

test('a scroll event that arrives after its scroll end still settles', () => {
  const scroller = createScroller();
  scroller.scrollTo(scroller.end());
  scroller.intent();
  scroller.scrollTo(scroller.viewport.scrollTop - 39);
  scroller.scrollEnd();
  assert.equal(scroller.following(), true);
  // Chrome's last key-scroll frame can land after its scrollend.
  scroller.scrollTo(scroller.viewport.scrollTop - 1);
  flushTimers();
  assert.equal(scroller.following(), true);
});

test('a scrollbar drag is judged by where it leaves the view', () => {
  const scroller = createScroller();
  scroller.scrollTo(scroller.end());
  scroller.intent({ scrollbar: true });
  scroller.context.setPointerHeld(true);
  // Output grows faster than a slow drag moves the view, and the first step
  // ends inside the zone while the thumb is still held.
  scroller.scrollTo(scroller.viewport.scrollTop - 39);
  scroller.scrollEnd();
  assert.equal(scroller.following(), false, 'a held thumb is not at rest');
  scroller.scrollTo(scroller.viewport.scrollTop - 21);
  scroller.grow(600);
  scroller.scrollEnd();
  scroller.context.setPointerHeld(false);
  assert.equal(scroller.following(), false, 'released far from the end');

  scroller.intent({ scrollbar: true });
  scroller.context.setPointerHeld(true);
  scroller.scrollTo(scroller.end() - 20);
  scroller.scrollEnd();
  scroller.context.setPointerHeld(false);
  flushFrames();
  assert.equal(scroller.following(), true, 'released at the end');
  assert.equal(scroller.viewport.scrollTop, scroller.end());
});

test('moving up without wheel, key or touch input stops following', () => {
  const scroller = createScroller();
  scroller.scrollTo(scroller.end());
  // An overlay scrollbar drag, a text selection dragged above the top, or a
  // focused row scrolled into view.
  scroller.scrollTo(scroller.viewport.scrollTop - 138);
  const reading = scroller.viewport.scrollTop;
  scroller.grow(100);
  assert.equal(scroller.viewport.scrollTop, reading);
});

test('corrections and clamps that move the view up keep following', () => {
  const scroller = createScroller();
  scroller.scrollTo(scroller.end());
  // A row above measured shorter while new output arrived: the virtualiser
  // moves the view up by the difference.
  scroller.grow(60);
  scroller.viewport.scrollTop -= 40;
  scroller.context.noteProgrammaticScroll();
  scroller.context.handleScroll();
  assert.equal(scroller.following(), true, 'a correction is not the reader');
  // The content shrank at the end and the browser clamped the view.
  scroller.grow(-40);
  scroller.scrollTo(Math.min(scroller.viewport.scrollTop, scroller.end()));
  assert.equal(scroller.following(), true, 'a clamp is not the reader');
  scroller.grow(100);
  assert.equal(scroller.viewport.scrollTop, scroller.end());
});

test('the view clamped by a growing viewport keeps following', () => {
  const scroller = createScroller();
  scroller.scrollTo(scroller.end());
  // Sending empties a tall composer: the viewport grows, the browser pulls the
  // view up to the new end, and the sent message lands before the scroll event.
  scroller.page.clientHeight += 100;
  scroller.viewport.scrollTop = scroller.end();
  scroller.context.handleResize();
  scroller.page.contentHeight += 170;
  scroller.context.handleScroll();
  assert.equal(scroller.following(), true);
  scroller.grow(50);
  assert.equal(scroller.viewport.scrollTop, scroller.end());
});

test('a pause from input that never moved the view lapses', () => {
  const scroller = createScroller();
  scroller.scrollTo(scroller.end());
  scroller.intent();
  scroller.grow(100);
  assert.notEqual(scroller.viewport.scrollTop, scroller.end(), 'paused while the input may still scroll');
  flushTimers();
  assert.equal(scroller.following(), true, 'input that could not scroll gives the end back');
  scroller.grow(100);
  assert.equal(scroller.viewport.scrollTop, scroller.end());
});

test('opening a row holds until the reader scrolls, and closing it gives the end back', () => {
  const scroller = createScroller();
  scroller.scrollTo(scroller.end());
  scroller.intent({ sticky: true });
  // The glide's queued scroll event still reports the old position.
  scroller.scrollTo(scroller.viewport.scrollTop);
  flushTimers();
  const held = scroller.viewport.scrollTop;
  scroller.grow(200);
  assert.equal(scroller.viewport.scrollTop, held, 'following stays paused');
  scroller.context.releaseHold();
  scroller.grow(-200);
  assert.equal(scroller.following(), true, 'closing the row brings the end back');
  scroller.grow(100);
  assert.equal(scroller.viewport.scrollTop, scroller.end());
});

test('a hidden transcript keeps the reader\'s place', () => {
  const scroller = createScroller();
  scroller.scrollTo(scroller.end());
  scroller.intent();
  scroller.scrollTo(scroller.viewport.scrollTop - 600);
  scroller.scrollEnd();
  const reading = scroller.viewport.scrollTop;
  scroller.hide(true);
  scroller.context.handleScroll();
  scroller.context.handleScrollEnd();
  scroller.hide(false);
  assert.equal(scroller.following(), false);
  assert.equal(scroller.viewport.scrollTop, reading);
});

test('a pointer pressed on the content holds the glide until it is released', () => {
  const scroller = createScroller();
  scroller.scrollTo(scroller.end());
  scroller.context.setPointerHeld(true);
  const held = scroller.viewport.scrollTop;
  scroller.grow(100);
  assert.equal(scroller.viewport.scrollTop, held, 'selected text stays under the pointer');
  scroller.context.setPointerHeld(false);
  flushFrames();
  assert.equal(scroller.viewport.scrollTop, scroller.end(), 'the glide catches up on release');
});
