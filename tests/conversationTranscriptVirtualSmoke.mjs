import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { computed, reactive, ref } from 'vue';
import { Virtualizer, elementScroll, measureElement } from '@tanstack/vue-virtual';
import { elapsedLabel, groupTranscriptMessages, toggleTranscriptRow, transcriptRowIndexForMessage, transcriptRowOpen, transcriptThoughtDurations, transcriptToolGroupSummary, transcriptTurnDurations } from '../dist/tests/resources/js/lib/integratedConversation.js';

const page = fs.readFileSync(new URL('../resources/js/Components/ConversationTranscript.vue', import.meta.url), 'utf8');
const source = page.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1];
assert.ok(source);
const thought = fs.readFileSync(new URL('../resources/js/Components/ConversationThoughtRow.vue', import.meta.url), 'utf8');
assert.match(thought, /v-if="open"[^\n]*v-html="renderPlainMarkdown\(message\.text\)"/, 'thinking content mounts only when expanded');
assert.match(thought, /:aria-expanded="open"/, 'the thinking toggle exposes its state');
assert.match(page, /:aria-expanded="rowOpen\(row\.id\)"/, 'the tool group toggle exposes its state');
const parsed = ts.createSourceFile('transcript.ts', source, ts.ScriptTarget.Latest, true);
const executable = parsed.statements.filter((statement) => !ts.isImportDeclaration(statement))
  .map((statement) => statement.getFullText(parsed)).join('\n');
const { outputText } = ts.transpileModule(executable, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
});

function mountTranscript() {
  const props = reactive({
    messages: Array.from({ length: 3000 }, (_, index) => ({
      id: `native-${index}`, role: 'assistant', kind: 'text', text: `Message ${index}`
    })),
    processId: 'process_test'
  });
  let options;
  const virtual = ref({
    getVirtualItems: () => Array.from({ length: 12 }, (_, offset) => {
      const index = 1000 + offset;
      return { index, key: options.value.getItemKey(index), start: index * 120 };
    }),
    getTotalSize: () => options.value.count * 120,
    measureElement() {}
  });
  const setup = new Function(
    'computed', 'ref', 'watch', 'onMounted', 'nextTick', 'useVirtualizer',
    'elapsedLabel', 'groupTranscriptMessages', 'toggleTranscriptRow', 'transcriptRowIndexForMessage', 'transcriptRowOpen', 'transcriptThoughtDurations', 'transcriptToolGroupSummary', 'transcriptTurnDurations', 'defineProps', 'defineEmits', 'defineExpose', 'withDefaults', 'measureElement', 'elementScroll', 'provide', 'drawnUiAnsweredKey', 'drawnUiAnswers', 'isSavedFigure', 'drawnUiId', 'drawnUiFiguresKey',
    `${outputText}\nreturn { rows, renderedRows, totalSize, rowOpen, toggleRow, sizerRef, scrollerRef };`
  );
  const pane = setup(
    computed, ref, () => {}, () => {}, () => Promise.resolve(),
    (value) => { options = value; return virtual; },
    elapsedLabel, groupTranscriptMessages, toggleTranscriptRow, transcriptRowIndexForMessage, transcriptRowOpen, transcriptThoughtDurations, transcriptToolGroupSummary, transcriptTurnDurations, () => props, () => () => {}, () => {}, (value) => value,
    measureElement, elementScroll, () => {}, Symbol('drawnUiAnswered'), () => new Map(), () => false, () => null, Symbol('drawnUiFigures')
  );
  return { pane, props, options, virtual };
}

test('the live transcript mounts only virtual rows and keys them by native identity', async () => {
  const { pane, props, options, virtual } = mountTranscript();
  assert.equal(options.value.count, 3000);
  assert.equal(options.value.anchorTo, 'end');
  assert.equal(pane.renderedRows.value.length, 12);
  assert.equal(pane.renderedRows.value[0].row.id, 'native-1000');
  assert.equal(pane.totalSize.value, 360000);

  const key = options.value.getItemKey(1000);
  props.messages = [
    ...Array.from({ length: 50 }, (_, index) => ({ id: `older-${index}`, role: 'user', kind: 'text', text: 'Earlier' })),
    ...props.messages
  ];
  assert.equal(options.value.getItemKey(1050), key, 'prepended pages do not recycle row keys');

  const adjust = virtual.value.shouldAdjustScrollPositionOnItemSizeChange;
  const adjustments = [];
  const instance = {
    range: { startIndex: 1000, endIndex: 1011 },
    scrollOffset: 120_100,
    itemSizeCache: new Map([['native-950', 400]]),
    options: options.value,
    indexFromElement: (row) => row.index,
    applyScrollAdjustment: (delta) => adjustments.push(delta)
  };
  const reading = { index: 1000, key: 'native-950', start: 120_000, size: 400 };
  assert.equal(adjust({ index: 999, key: 'native-949', start: 119_880, size: 120 }, 40, instance), true, 'a row wholly above the viewport keeps the visible rows in place');
  assert.equal(adjust(reading, 40, instance), false, 'the row being read does not move the view as its reply streams in');
  assert.equal(adjust({ index: 1011, key: 'native-961', start: 121_320, size: 120 }, 40, instance), false, 'rows below the top never move the view');
  assert.equal(adjust({ ...reading, key: 'native-unmeasured' }, 280, instance), true, 'the first measurement of the row across the top replaces its whole estimate');

  // The column narrows: the row across the top rewraps 200px taller, and the
  // quarter of it that was above the edge grows with it.
  const row = { index: 1000, height: 600 };
  options.value.measureElement(row, { borderBoxSize: [{ inlineSize: 800 }] }, instance);
  assert.equal(adjust(reading, 200, instance), false, 'a row measured for the first time at a width is not a rewrap');
  options.value.measureElement(row, { borderBoxSize: [{ inlineSize: 600 }] }, instance);
  assert.equal(adjust(reading, 200, instance), false);
  await Promise.resolve();
  assert.deepEqual(adjustments, [50], 'a rewrapped row keeps the share of it above the edge');
  options.value.measureElement(row, undefined, instance);
  adjust(reading, 200, instance);
  await Promise.resolve();
  assert.deepEqual(adjustments, [50], 'growth at the same width is a streaming reply, not a rewrap');

  assert.equal(pane.rowOpen('thinking-test'), false, 'thinking starts collapsed');
  pane.toggleRow('thinking-test');
  assert.equal(pane.rowOpen('thinking-test'), true, 'the same row can be expanded');
  pane.toggleRow('thinking-test');
  assert.equal(pane.rowOpen('thinking-test'), false, 'thinking can be hidden again');
});

test('a row rewrapped near the end moves the view after the sizer has grown', async () => {
  const { pane, options, virtual } = mountTranscript();
  // A real virtualiser over a viewport that clamps to the sizer, as the
  // browser does: two rows, 400 and 500 tall, read 100px from the end.
  const sizer = { style: { height: '0px' } };
  pane.sizerRef.value = sizer;
  const scrollElement = {
    scrollTop: 0,
    clientHeight: 600,
    get scrollHeight() { return Math.max(Number.parseFloat(sizer.style.height) || 0, this.clientHeight); },
    scrollTo({ top }) { this.scrollTop = Math.min(Math.max(0, top), this.scrollHeight - this.clientHeight); },
    ownerDocument: { defaultView: { requestAnimationFrame: () => 0, cancelAnimationFrame() {}, performance } }
  };
  const instance = new Virtualizer({
    count: 2,
    getScrollElement: () => scrollElement,
    estimateSize: () => 120,
    getItemKey: (index) => ['first', 'second'][index],
    scrollToFn: options.value.scrollToFn,
    measureElement: options.value.measureElement,
    observeElementRect: () => () => {},
    observeElementOffset: () => () => {},
    initialRect: { width: 800, height: 600 }
  });
  instance.shouldAdjustScrollPositionOnItemSizeChange = virtual.value.shouldAdjustScrollPositionOnItemSizeChange;
  instance._willUpdate();
  const rows = [0, 1].map((index) => ({ getAttribute: () => String(index), isConnected: true }));
  const observe = (index, width, height) => instance.resizeItem(index, instance.options.measureElement(rows[index], { borderBoxSize: [{ inlineSize: width, blockSize: height }] }, instance));
  observe(0, 800, 400);
  observe(1, 800, 500);
  instance.options.scrollToFn(200, {}, instance);
  instance.scrollOffset = 200;
  instance.getVirtualItems();
  assert.equal(scrollElement.scrollTop, 200);

  // The column narrows and the first row rewraps to 800px: half of it was
  // above the edge, so the view moves down by half the growth.
  observe(0, 600, 800);
  await Promise.resolve();
  assert.equal(scrollElement.scrollTop, 400, 'the move is not clamped to the old end');
});

test('a correction that shrinks the sizer reports its whole move, clamp included', () => {
  const { pane, options } = mountTranscript();
  const notes = [];
  pane.scrollerRef.value = { noteProgrammaticScroll: (from) => notes.push(from) };
  // The browser clamps the view as soon as the sizer shrinks.
  const scrollElement = {
    scrollTop: 1480,
    clientHeight: 500,
    height: 2000,
    get scrollHeight() { return this.height; },
    scrollTo({ top }) { this.scrollTop = Math.min(Math.max(0, top), this.height - this.clientHeight); }
  };
  pane.sizerRef.value = {
    style: {
      set height(value) {
        scrollElement.height = Number.parseFloat(value);
        scrollElement.scrollTop = Math.min(scrollElement.scrollTop, scrollElement.height - scrollElement.clientHeight);
      }
    }
  };
  // A row above the view measures 100px shorter.
  options.value.scrollToFn(1380, {}, { scrollElement, getTotalSize: () => 1900, options: { horizontal: false } });
  assert.equal(scrollElement.scrollTop, 1380);
  assert.deepEqual(notes, [1480], 'the scroller measures the correction from before the clamp');
});

test('a tool group summary renders a space between each count and its title', async () => {
  const { createSSRApp, h } = await import('vue');
  const { renderToString } = await import('vue/server-renderer');
  const template = page.match(/<span[^\n]*:title="groupSummary\(row\)\.label"[^\n]*<\/span>/)?.[0];
  assert.ok(template, 'the summary span is in the transcript');
  const messages = [
    { id: 's1', role: 'assistant', kind: 'tool', text: '', tool: { name: 'Skill', family: 'skill', status: 'completed', title: 'Skill', target: 'implement' } },
    ...Array.from({ length: 7 }, (_, index) => ({ id: `b${index}`, role: 'assistant', kind: 'tool', text: '', tool: { name: 'Bash', family: 'shell', status: 'completed', title: 'Bash', target: 'ls' } }))
  ];
  const html = await renderToString(createSSRApp({
    template,
    components: { OdometerNumber: { props: ['value'], render() { return h('span', String(this.value)); } } },
    setup: () => ({ row: { messages }, groupSummary: (row) => transcriptToolGroupSummary(row.messages) })
  }));
  const text = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '');
  assert.equal(text, 'Skill (implement), 7 Bash');
  assert.match(html, /title="Skill \(implement\), 7 Bash"/);
});
