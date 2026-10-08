import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { computed, nextTick, ref, shallowRef, watch as vueWatch, isRef } from 'vue';
import { groupTranscriptMessages } from '../dist/tests/resources/js/lib/integratedConversation.js';
import { archiveTranscript, isReasoningMessage, toolCallKey } from '../dist/tests/resources/js/lib/historyTranscript.js';

const page = fs.readFileSync(new URL('../resources/js/Components/ConversationHistoryView.vue', import.meta.url), 'utf8');
assert.match(page, /<ConversationTranscript[\s\S]*:messages="transcriptMessages"/, 'history uses the shared transcript');
assert.doesNotMatch(page, /HistoryToolContent|<ScrollArea ref="messageScrollRef"/, 'history has no second message renderer');
const source = page.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1];
assert.ok(source);
const parsed = ts.createSourceFile('history.ts', source, ts.ScriptTarget.Latest, true);
const executable = parsed.statements.filter((statement) => !ts.isImportDeclaration(statement))
  .map((statement) => statement.getFullText(parsed)).join('\n');
const { outputText } = ts.transpileModule(executable, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
});
const setup = new Function(
  'computed', 'nextTick', 'ref', 'shallowRef', 'watch', 'onBeforeUnmount', 'defineProps', 'defineEmits',
  'useVirtualizer', 'window', 'archiveTranscript', 'isReasoningMessage', 'toolCallKey', 'toast',
  `${outputText}\nreturn { conversations, messages, selectedId, messageTranscriptRef, selectConversation, loadOlderMessages, positioningInitialMessages, transcriptMessages, focusedMessageId, scrollToMessage, showReasoning, canResume, resumeTitle, resumeSelected };`
);

function mount(watchPagination = false, props = {}) {
  const pending = [];
  const emitted = [];
  const toasts = [];
  const history = setup(
    computed, nextTick, ref, shallowRef,
    (source, callback) => { if (watchPagination && (isRef(source) || Array.isArray(source))) vueWatch(source, callback); },
    () => {}, () => props, () => (...event) => emitted.push(event),
    () => ref({ getVirtualItems: () => [], getTotalSize: () => 1000, scrollToIndex: () => {}, scrollToOffset: () => {} }),
    { patterm: { call: (name, args) => new Promise((resolve) => pending.push({ name, args, resolve })) } },
    archiveTranscript, isReasoningMessage, toolCallKey, { error: (title, options) => toasts.push([title, options?.description]) }
  );
  const scrolling = { bottom: 0, message: null };
  history.messageTranscriptRef.value = {
    scrollToBottom: () => { scrolling.bottom++; },
    scrollToMessage: (id) => { scrolling.message = id; }
  };
  history.conversations.value = ['a', 'b'].map((id) => ({ id, messageCount: 200 }));
  return { history, pending, scrolling, emitted, toasts };
}

function record(id, extra = {}) {
  return { id, seq: 1, role: 'assistant', kind: 'message', text: id, metadata: {},
    toolName: null, toolInputSummary: null, toolOutputSummary: null, toolStatus: null, redactionCount: 0, ...extra };
}

function tool(id, name = 'bash', extra = {}) {
  return record(id, { role: 'tool', kind: 'tool_call', text: '', toolName: name,
    toolInputSummary: '{"command":"git status"}', ...extra });
}

test('history and live chat use the same tool grouping; failed tools stay visible', () => {
  const { history } = mount();
  history.messages.value = [tool('shell'), tool('read-a', 'read', { toolInputSummary: '{"path":"a.ts"}', toolStatus: 'completed' }),
    tool('read-b', 'grep', { toolInputSummary: '{"pattern":"foo"}', toolStatus: 'completed' }),
    tool('failed', 'read', { toolStatus: 'failed' }), tool('patch', 'apply_patch')];
  const rows = groupTranscriptMessages(history.transcriptMessages.value);
  assert.deepEqual(rows.map((row) => [row.kind, row.id]), [
    ['tools', 'tools:shell'], ['message', 'failed'], ['tools', 'tools:patch']
  ]);
  assert.deepEqual(rows[0].messages.map((message) => message.id), ['shell', 'read-a', 'read-b']);
  assert.equal(history.transcriptMessages.value[3].tool.status, 'failed');
});

test('call results combine once and a result deep link opens its call', async () => {
  const { history, scrolling } = mount();
  history.messages.value = [tool('call', 'bash', { metadata: { callId: 'native' } }),
    tool('result', null, { kind: 'tool_result', toolInputSummary: null, toolOutputSummary: 'clean', metadata: { callId: 'native' } }),
    tool('orphan', null, { kind: 'tool_result', toolInputSummary: null, toolOutputSummary: 'previous page' })];
  assert.deepEqual(history.transcriptMessages.value.map((message) => message.id), ['call', 'orphan']);
  assert.equal(history.transcriptMessages.value[0].tool.output, 'clean');
  await history.scrollToMessage('result');
  assert.equal(history.focusedMessageId.value, 'call');
  assert.equal(scrolling.message, 'call');
});

test('archive metadata and native patch files survive the shared adapter', () => {
  const { history } = mount();
  history.messages.value = [
    record('approval', { role: 'user', text: '{"risk_level":"low","user_authorization":"once","outcome":"approved"}', redactionCount: 1,
      metadata: { fileReferences: ['/project/src/a.ts'] } }),
    tool('patch', 'apply_patch', { toolInputSummary: JSON.stringify({ patchText: '*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** Add File: b.ts\n+hello\n*** End Patch' }) }),
    tool('git-patch', 'apply_patch', { toolInputSummary: 'diff --git a/c.ts b/c.ts\n--- a/c.ts\n+++ b/c.ts\n@@ -1 +1 @@\n-old\n+new' }),
    record('redacted', { text: '', redactionCount: 2 })
  ];
  const [approval, patch] = history.transcriptMessages.value;
  assert.equal(approval.approval.outcome, 'approved');
  assert.equal(approval.redactionCount, 1);
  assert.deepEqual(approval.fileReferences, ['/project/src/a.ts']);
  assert.deepEqual(patch.tool.files.map((file) => [file.name, file.additions, file.deletions]), [['a.ts', 1, 1], ['b.ts', 1, 0]]);
  assert.match(patch.tool.files[0].patch, /@@\n-old\n\+new/);
  assert.match(history.transcriptMessages.value[2].tool.patch, /diff --git a\/c.ts b\/c.ts/);
  assert.equal(history.transcriptMessages.value[3].redactionCount, 2);
});

test('reasoning, hidden or shown, stays inside a tool group', () => {
  const { history } = mount();
  history.messages.value = [tool('a', 'read'), record('reasoning', { metadata: { type: 'reasoning' } }), tool('b', 'grep')];
  assert.deepEqual(groupTranscriptMessages(history.transcriptMessages.value).map((row) => row.kind), ['tools']);
  history.showReasoning.value = true;
  const rows = groupTranscriptMessages(history.transcriptMessages.value);
  assert.deepEqual(rows.map((row) => row.kind), ['tools']);
  assert.deepEqual(rows[0].messages.map((message) => message.kind), ['tool', 'reasoning', 'tool'], 'the shown thought folds into the group in order');
});

test('selection, paging, and stale replies remain scoped to the selected conversation', async () => {
  const { history, pending, scrolling } = mount();
  const first = history.selectConversation('a');
  assert.equal(pending[0].args.offset, 100);
  const second = history.selectConversation('b');
  pending[1].resolve({ offset: 100, messages: [record('b')] });
  await second;
  pending[0].resolve({ offset: 100, messages: [record('a')] });
  await first;
  assert.equal(history.selectedId.value, 'b');
  assert.deepEqual(history.messages.value.map((message) => message.id), ['b']);
  assert.equal(scrolling.bottom, 1);

  const older = history.loadOlderMessages();
  assert.equal(pending[2].args.offset, 0);
  pending[2].resolve({ offset: 0, messages: [record('old-b', { seq: 0 })] });
  await older;
  assert.deepEqual(history.messages.value.map((message) => message.id), ['old-b', 'b']);
});

test('a hidden-reasoning-only page loads an older visible page', async () => {
  const { history, pending } = mount(true);
  const selection = history.selectConversation('a');
  pending.shift().resolve({ offset: 100, messages: [record('hidden', { metadata: { type: 'reasoning' } })] });
  await selection;
  await nextTick();
  assert.equal(pending.length, 1);
  pending.shift().resolve({ offset: 0, messages: [record('prompt', { role: 'user', text: 'Original prompt' })] });
  await nextTick();
  assert.equal(history.transcriptMessages.value[0].text, 'Original prompt');
});

test('Resume starts the selected conversation and opens its agent', async () => {
  const { history, pending, emitted, toasts } = mount(false, { projectId: 'project_a' });
  history.conversations.value = [
    { id: 'a', provider: 'claude', providerConversationId: 'native-a', projectId: 'project_a', messageCount: 2 },
    { id: 'b', provider: 'codex', providerConversationId: null, projectId: 'project_a', messageCount: 2 },
    { id: 'c', provider: 'codex', providerConversationId: 'native-c', projectId: 'project_other', messageCount: 2 }
  ];
  history.selectedId.value = 'b';
  assert.equal(history.canResume.value, false);
  assert.match(history.resumeTitle.value, /no native ID/);
  history.selectedId.value = 'c';
  assert.equal(history.canResume.value, false, 'a conversation from another project is not resumed here');
  history.selectedId.value = 'a';
  assert.equal(history.canResume.value, true);
  const resumed = history.resumeSelected();
  const call = pending.at(-1);
  assert.equal(call.name, 'patterm.history.resume');
  assert.deepEqual(call.args, { conversation_id: 'a', project_id: 'project_a' }, 'the agent opens in the saved or default interface');
  call.resolve({ session_id: 'session_new' });
  await resumed;
  assert.deepEqual(emitted, [['launched', 'session_new']]);
  assert.deepEqual(toasts, []);
});
