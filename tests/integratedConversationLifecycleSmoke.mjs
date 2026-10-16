import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { computed, effectScope, nextTick, reactive, ref, shallowRef, watch } from 'vue';

const require = createRequire(import.meta.url);
const helpers = require('../dist/tests/resources/js/lib/integratedConversation.js');
const composer = require('../dist/tests/resources/js/lib/integratedComposer.js');
const { archiveTranscript } = require('../dist/tests/resources/js/lib/historyTranscript.js');
const { awaitingUser } = require('../dist/tests/resources/js/lib/activity.js');

// The pane keeps provider/business logic in helpers and services. This harness
// runs its real <script setup> with controllable browser APIs, timers, and
// subscriptions so the lifecycle rules are covered rather than only helpers.
const page = fs.readFileSync(new URL('../resources/js/Components/IntegratedConversation.vue', import.meta.url), 'utf8');
const source = page.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
const parsed = ts.createSourceFile('integrated.ts', source, ts.ScriptTarget.Latest, true);
const executable = parsed.statements.filter(statement => !ts.isImportDeclaration(statement)).map(statement => statement.getFullText(parsed)).join('\n');
const { outputText } = ts.transpileModule(executable, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });

const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await nextTick(); };
const emptyConversation = () => ({ messages: { data: [] }, permissions: { data: [] }, questions: { data: [] } });
const replyConversation = text => ({ messages: { data: [{ id: 'assistant_1', type: 'assistant', text }] }, permissions: { data: [] }, questions: { data: [] } });
const questionConversation = () => ({
  messages: { data: [] },
  permissions: { data: [] },
  questions: { data: [
    { id: 'request-one', questions: [{ id: 'choice', question: 'First task?', options: [{ label: 'Yes' }], custom: true }] },
    { id: 'request-two', questions: [{ id: 'choice', question: 'Different task?', options: [{ label: 'No' }], custom: true }] }
  ] }
});

function createHarness({ processId = 'process_a', exited = false, restartable = false, keepCache = false, onNewSession, onRestartSession, subscribeReply = () => ({ ok: true }) } = {}) {
  // Tests reuse process IDs; each starts without another test's cached pane.
  if (!keepCache) helpers.forgetConversation();
  const lifecycle = { mounted: [], beforeUnmount: [] };
  const subscriptions = [];
  const requests = [];
  const mutations = [];
  const timers = new Map();
  const conversationSubscriptions = [];
  let conversationHandler = null;
  let timerId = 0;
  let controlHandler = null;
  const workspaceHandlers = [];
  const published = new Map();
  const provided = new Map();
  const props = reactive({ processId, exited, restartable, onNewSession, onRestartSession });
  const windowMock = {
    patterm: {
      runtime: 'browser',
      terminalSubscribe: args => new Promise((resolve) => {
        const entry = { args, settled: false };
        entry.resolve = (value) => { entry.settled = true; resolve(value); };
        subscriptions.push(entry);
      }),
      conversationSubscribe: (args) => {
        conversationSubscriptions.push(args);
        return Promise.resolve(subscribeReply(args));
      },
      onConversationEvent: (handler) => {
        conversationHandler = handler;
        return () => { if (conversationHandler === handler) conversationHandler = null; };
      },
      onTerminalControl: (handler) => {
        controlHandler = handler;
        return () => { if (controlHandler === handler) controlHandler = null; };
      },
      call: (tool, args) => new Promise((resolve, reject) => {
        const entry = { tool, args, settled: false };
        entry.resolve = (value) => { entry.settled = true; resolve(value); };
        entry.reject = (error) => { entry.settled = true; reject(error); };
        requests.push(entry);
      }),
      integratedCall: (tool, args) => new Promise((resolve, reject) => {
        const entry = { tool, args, settled: false };
        entry.resolve = (value) => { entry.settled = true; resolve(value); };
        entry.reject = (error) => { entry.settled = true; reject(error); };
        mutations.push(entry);
      }),
      terminalTakeControl: () => Promise.resolve({ ok: true })
    }
  };
  const bindings = {
    computed,
    nextTick,
    onBeforeUnmount: callback => lifecycle.beforeUnmount.push(callback),
    onMounted: callback => lifecycle.mounted.push(callback),
    ref,
    shallowRef,
    watch,
    defineProps: () => props,
    defineEmits: () => () => {},
    window: windowMock,
    setTimeout: (callback, delay) => {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: id => { timers.delete(id); },
    completeSend: composer.completeSend,
    submissionFor: composer.submissionFor,
    beginSubmission: composer.beginSubmission,
    markSubmissionUncertain: composer.markSubmissionUncertain,
    clearSubmission: composer.clearSubmission,
    isAmbiguousTransportError: composer.isAmbiguousTransportError,
    beginOutgoingMessage: composer.beginOutgoingMessage,
    outgoingFor: composer.outgoingFor,
    outgoingTranscript: composer.outgoingTranscript,
    reconcileOutgoingMessages: composer.reconcileOutgoingMessages,
    failOutgoingMessage: composer.failOutgoingMessage,
    archiveTranscript,
    awaitingUser,
    randomId: () => crypto.randomUUID(),
    payloadHash: composer.payloadHash,
    provide: (key, value) => provided.set(key, value),
    figureAnswerKey: Symbol('figureAnswer'),
    publishIntegratedControls: (id, controls) => { if (controls) published.set(id, controls); else published.delete(id); },
    onWorkspaceRequest: (handler) => {
      workspaceHandlers.push(handler);
      return () => workspaceHandlers.splice(workspaceHandlers.indexOf(handler), 1);
    },
    ...helpers
  };
  const setup = new Function(...Object.keys(bindings), `${outputText}
return {
  state: () => ({
    subscribedProcessId,
    generation,
    controlling: controlling.value,
    ended: ended.value,
    error: error.value,
    refreshError: refreshError.value,
    streamStatus: streamStatus.value,
    sending: submissionFor(props.processId)?.state === 'sending',
    pending: Boolean(submissionFor(props.processId)),
    uncertain: submissionFor(props.processId)?.state === 'uncertain',
    canReply: canReply.value
  }),
  refresh, loadOlder, historyCursor, loadingOlder, historyError, sendRequest, retryMessage, reconcileDelivery, replyQuestion, replyPermission, replyForm, takeControl,
  transcriptMessages, messages, questions, permissions, questionAnswers, singleQuestionAnswers, customQuestionAnswers,
  forms, formAnswers, formErrors, setFormAnswer, toggleMultiselect, activeFields, isResponding,
  controls, resumeOpen, resumeQuery, transcriptRef
};`);
  const scope = effectScope();
  const pane = scope.run(() => setup(...Object.keys(bindings).map(key => bindings[key])));
  lifecycle.mounted.forEach(callback => callback());
  return {
    pane, props, subscriptions, requests, mutations, timers, lifecycle, scope, windowMock,
    conversationSubscriptions, published,
    answerChannel: () => provided.get(bindings.figureAnswerKey),
    workspaceRequest: request => workspaceHandlers.some(handler => handler(request)),
    emitConversationEvent: event => conversationHandler?.(event),
    emitControl: state => controlHandler?.(state)
  };
}

function pending(harness, suffix) {
  return harness.requests.filter(entry => entry.tool.endsWith(suffix) && !entry.settled);
}

async function resolveSubscriptions(harness) {
  for (const entry of harness.subscriptions.filter(item => !item.settled)) {
    entry.resolve({ controlling: entry.args.subscribed });
  }
  await flush();
}

async function resolveControls(harness) {
  for (const entry of pending(harness, 'integrated_controls')) entry.resolve({ selectors: [], commands: [] });
  await flush();
}

async function resolveGets(harness, payload) {
  for (const entry of pending(harness, 'integrated_get')) entry.resolve(payload);
  await flush();
}

async function mountSettled(harness, payload = emptyConversation()) {
  await resolveSubscriptions(harness);
  await resolveControls(harness);
  await resolveGets(harness, payload);
}

test('older pages survive live refreshes and stale page replies cannot cross sessions', async () => {
  const harness = createHarness({ processId: 'A' });
  await mountSettled(harness, {
    ...emptyConversation(), provider: 'opencode', history_truncated: true,
    history_cursor: { next: 'page-2' },
    messages: { data: [{ id: 'recent', type: 'assistant', text: 'partial' }] }
  });
  assert.equal(harness.pane.historyCursor.value, 'page-2');
  void harness.pane.loadOlder();
  await flush();
  const history = pending(harness, 'integrated_history').at(-1);
  assert.deepEqual(history.args, { process_id: 'A', cursor: 'page-2' });
  history.resolve({ messages: { data: [{ id: 'old', type: 'user', text: 'earlier' }] }, cursor: null });
  await flush();
  assert.deepEqual(harness.pane.messages.value.map(message => message.id), ['old', 'recent']);
  assert.equal(harness.pane.historyCursor.value, null);
  void harness.pane.refresh();
  await flush();
  await resolveGets(harness, {
    ...emptyConversation(), provider: 'opencode', history_truncated: true,
    history_cursor: { next: 'page-2' },
    messages: { data: [{ id: 'recent', type: 'assistant', text: 'complete' }, { id: 'new', type: 'user', text: 'latest' }] }
  });
  assert.deepEqual(harness.pane.messages.value.map(message => [message.id, message.text]), [
    ['old', 'earlier'], ['recent', 'complete'], ['new', 'latest']
  ]);
  assert.equal(harness.pane.historyCursor.value, null, 'latest-window refresh does not resurrect an exhausted cursor');
  harness.props.processId = 'B';
  await nextTick();
  assert.deepEqual(harness.pane.messages.value, []);
  assert.equal(harness.pane.historyCursor.value, null);
  harness.scope.stop();
});

test('a resumed conversation loads its imported turns without a scroll', async () => {
  const harness = createHarness({ processId: 'resumed' });
  await mountSettled(harness, { ...emptyConversation(), provider: 'claude', history_truncated: true, history_cursor: { next: 'archive:page' } });
  await flush();
  const history = pending(harness, 'integrated_history').at(-1);
  assert.deepEqual(history?.args, { process_id: 'resumed', cursor: 'archive:page' }, 'the first archived page loads on its own');
  const archived = (id, extra) => ({ id, seq: 1, role: 'assistant', kind: 'message', text: '', metadata: {}, toolName: null, toolInputSummary: null, toolOutputSummary: null, toolStatus: null, redactionCount: 0, ...extra });
  history.resolve({ messages: [], cursor: null, archived_messages: [
    archived('question', { role: 'user', text: 'Earlier question' }),
    archived('call', { role: 'tool', kind: 'tool_call', toolName: 'bash', toolInputSummary: '{"command":"ls"}', metadata: { callId: 'c1' } }),
    archived('result', { role: 'tool', kind: 'tool_result', toolOutputSummary: 'README.md', metadata: { callId: 'c1' } })
  ] });
  await flush();
  assert.deepEqual(harness.pane.messages.value.map(message => [message.id, message.kind, message.archived]), [
    ['question', 'text', true], ['call', 'tool', true]
  ], 'archived rows use the History projection, with results folded into calls');
  assert.equal(harness.pane.messages.value[1].tool.output, 'README.md');
  harness.scope.stop();
});

test('an A-B-A process switch keeps the newest subscription and unsubscribes on unmount', async () => {
  const harness = createHarness({ processId: 'A' });
  harness.props.processId = 'B';
  await nextTick();
  harness.props.processId = 'A';
  await nextTick();
  assert.deepEqual(harness.subscriptions.map(entry => entry.args), [
    { process_id: 'A', subscribed: true },
    { process_id: 'A', subscribed: false },
    { process_id: 'B', subscribed: true },
    { process_id: 'B', subscribed: false },
    { process_id: 'A', subscribed: true }
  ]);
  // WebSocket acknowledgements arrive in request order.
  for (const entry of harness.subscriptions.slice()) {
    entry.resolve({ controlling: entry.args.subscribed });
    await Promise.resolve();
  }
  await flush();
  assert.equal(harness.pane.state().subscribedProcessId, 'A', 'the newest intent is retained');
  assert.equal(harness.pane.state().controlling, true, 'the newest acknowledgement wins');
  const before = harness.subscriptions.length;
  harness.lifecycle.beforeUnmount.forEach(callback => callback());
  await Promise.resolve();
  assert.deepEqual(harness.subscriptions.slice(before).map(entry => entry.args), [{ process_id: 'A', subscribed: false }]);
  harness.scope.stop();
});

test('unmount races a pending subscribe, releases it, and ignores its acknowledgement', async () => {
  const harness = createHarness({ processId: 'A' });
  assert.deepEqual(harness.subscriptions.map(entry => entry.args), [{ process_id: 'A', subscribed: true }]);
  harness.lifecycle.beforeUnmount.forEach(callback => callback());
  assert.deepEqual(harness.subscriptions.map(entry => entry.args), [
    { process_id: 'A', subscribed: true },
    { process_id: 'A', subscribed: false }
  ]);
  harness.subscriptions[0].resolve({ controlling: true });
  await flush();
  assert.equal(harness.pane.state().controlling, false, 'a stale subscribe acknowledgement is ignored');
  harness.scope.stop();
});

test('a late response from the previous process cannot enter the new transcript', async () => {
  const harness = createHarness({ processId: 'A' });
  await resolveSubscriptions(harness);
  await resolveControls(harness);
  const late = pending(harness, 'integrated_get').at(-1);
  harness.props.processId = 'B';
  await nextTick();
  await mountSettled(harness, replyConversation('b-reply'));
  assert.deepEqual(harness.pane.messages.value.map(message => message.text), ['b-reply']);
  late.resolve(replyConversation('late-a'));
  await flush();
  assert.deepEqual(harness.pane.messages.value.map(message => message.text), ['b-reply']);
  harness.scope.stop();
});

test('overlapping refreshes read once more after the read in flight', async () => {
  const harness = createHarness({ processId: 'A' });
  await mountSettled(harness);
  const reads = () => harness.requests.filter(entry => entry.tool === 'integrated_get').length;
  const before = reads();
  void harness.pane.refresh();
  void harness.pane.refresh();
  void harness.pane.refresh();
  await flush();
  assert.equal(pending(harness, 'integrated_get').length, 1, 'requests during a read share one follow-up read');
  await resolveGets(harness, replyConversation('older'));
  assert.equal(pending(harness, 'integrated_get').length, 1, 'the follow-up read starts after the first settles');
  await resolveGets(harness, replyConversation('newer'));
  assert.equal(reads() - before, 2);
  assert.deepEqual(harness.pane.messages.value.map(message => message.text), ['newer']);
  harness.scope.stop();
});

test('send and manual refresh keep a single polling chain', async () => {
  const harness = createHarness({ processId: 'A' });
  await mountSettled(harness);
  assert.equal(harness.timers.size, 1, 'one poll timer after mount');
  assert.equal([...harness.timers.values()][0].delay, 750);
  void harness.pane.refresh();
  await flush();
  assert.equal(harness.timers.size, 1, 'a manual refresh does not add a timer');
  await resolveGets(harness, replyConversation('manual'));
  assert.equal(harness.timers.size, 1);
  void harness.pane.sendRequest({
    text: 'hello',
    references: [],
    attachments: [],
    messageId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    hash: 'hash'
  });
  await flush();
  const send = harness.mutations.filter(entry => entry.tool === 'integrated_send' && !entry.settled)[0];
  assert.ok(send, 'send reaches the native control call');
  send.resolve({ id: 'message_test' });
  await flush();
  await resolveGets(harness, replyConversation('after send'));
  assert.equal(harness.timers.size, 1, 'send does not arm a second chain');
  const poll = [...harness.timers.values()][0];
  harness.timers.clear();
  poll.callback();
  await flush();
  await resolveGets(harness, replyConversation('polled'));
  assert.equal(harness.timers.size, 1, 'the poll re-arms exactly once');
  harness.scope.stop();
});

test('a send answered after a process switch cannot write into the new pane', async () => {
  const harness = createHarness({ processId: 'A' });
  await mountSettled(harness);
  void harness.pane.sendRequest({
    text: 'for A',
    references: [],
    attachments: [],
    messageId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    hash: 'hash'
  });
  await flush();
  assert.equal(harness.mutations.length, 1);
  harness.props.processId = 'B';
  await nextTick();
  await mountSettled(harness);
  harness.mutations[0].reject(new Error('late failure'));
  await flush();
  assert.equal(harness.pane.state().error, '', 'a stale send failure is dropped');
  assert.equal(harness.pane.state().sending, false);
  harness.scope.stop();
});

test('question replies are validated per request and cannot borrow another request answer', async () => {
  const harness = createHarness({ processId: 'A' });
  await mountSettled(harness, questionConversation());
  assert.deepEqual(harness.pane.questions.value.flatMap(request => request.questions.map(question => question.key)), [
    'request-one:choice',
    'request-two:choice'
  ]);
  harness.pane.singleQuestionAnswers.value['request-one:choice'] = 'Yes';
  void harness.pane.replyQuestion(harness.pane.questions.value[0]);
  await flush();
  assert.equal(harness.mutations.length, 1);
  assert.equal(harness.mutations[0].args.request_id, 'request-one');
  assert.deepEqual(harness.mutations[0].args.answers, [['Yes']]);
  void harness.pane.replyQuestion(harness.pane.questions.value[1]);
  await flush();
  assert.equal(harness.mutations.length, 1, 'the second request still needs its own answer');
  assert.match(harness.pane.state().error, /Different task\?/);
  // Once a request is answered and disappears, its namespaced answer state is pruned.
  void harness.pane.refresh();
  await flush();
  await resolveGets(harness, {
    messages: { data: [] },
    permissions: { data: [] },
    questions: { data: [
      { id: 'request-two', questions: [{ id: 'choice', question: 'Different task?', options: [{ label: 'No' }], custom: true }] }
    ] }
  });
  assert.deepEqual(Object.keys(harness.pane.questionAnswers.value), ['request-two:choice']);
  harness.scope.stop();
});

test('an ended session mounts read-only without polling or subscribing', async () => {
  const harness = createHarness({ processId: 'A', exited: true });
  await flush();
  assert.equal(harness.pane.state().ended, true);
  assert.equal(harness.pane.state().canReply, false);
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.subscriptions.length, 0);
  harness.scope.stop();
});

test('a session-unavailable read stops polling and shows the ended state', async () => {
  const harness = createHarness({ processId: 'A' });
  await mountSettled(harness);
  assert.equal(harness.timers.size, 1);
  void harness.pane.refresh();
  await flush();
  const get = pending(harness, 'integrated_get').at(-1);
  get.reject(new Error('OpenCode Integrated session is not active'));
  await flush();
  assert.equal(harness.pane.state().ended, true);
  assert.equal(harness.pane.state().refreshError, '');
  assert.equal(harness.timers.size, 0);
  harness.scope.stop();
});

test('a host-gone read clears once the agent ends, in either arrival order', async () => {
  const gone = 'The Integrated agent host is no longer running. Resume the conversation to continue.';
  // The read fails first, then the close reaches the pane.
  const before = createHarness({ processId: 'A' });
  await mountSettled(before);
  void before.pane.refresh();
  await flush();
  pending(before, 'integrated_get').at(-1).reject(new Error(gone));
  await flush();
  assert.equal(before.pane.state().refreshError, gone);
  before.props.exited = true;
  await flush();
  assert.equal(before.pane.state().refreshError, '');
  before.scope.stop();

  // The close reaches the pane while the read is still in flight.
  const after = createHarness({ processId: 'B' });
  await mountSettled(after);
  void after.pane.refresh();
  await flush();
  after.props.exited = true;
  await flush();
  pending(after, 'integrated_get').at(-1).reject(new Error(gone));
  await flush();
  assert.equal(after.pane.state().ended, true);
  assert.equal(after.pane.state().refreshError, '');
  after.scope.stop();
});

test('an uncertain send keeps a recoverable message until native admission is proven', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'uncertain_delivery' });
  await mountSettled(harness);
  composer.draftFor('uncertain_delivery').text = 'maybe delivered';
  const prepared = composer.payloadFor('uncertain_delivery');
  assert.equal(prepared.ok, true);
  void harness.pane.sendRequest({ ...prepared.payload, hash: prepared.hash });
  await flush();
  const send = harness.mutations.find(entry => entry.tool === 'integrated_send' && !entry.settled);
  send.resolve({ delivery: 'uncertain', message_id: prepared.payload.messageId, error: 'connection lost' });
  await flush();
  const firstLook = harness.requests.filter(entry => entry.tool === 'integrated_delivery' && !entry.settled)[0];
  assert.ok(firstLook, 'an uncertain result reconciles before offering a retry');
  assert.equal(harness.pane.state().uncertain, true);
  assert.equal(composer.draftFor('uncertain_delivery').text, '', 'the submitted text lives in the transcript');
  assert.equal(harness.pane.transcriptMessages.value.at(-1).text, 'maybe delivered');
  assert.equal(harness.pane.transcriptMessages.value.at(-1).delivery.state, 'uncertain');
  firstLook.resolve({ state: 'unknown' });
  await flush();
  assert.equal(harness.pane.state().uncertain, true, 'absence from one bounded read is not acceptance');

  void harness.pane.reconcileDelivery();
  await flush();
  const secondLook = harness.requests.filter(entry => entry.tool === 'integrated_delivery' && !entry.settled)[0];
  secondLook.resolve({ state: 'accepted' });
  await flush();
  assert.equal(harness.pane.state().uncertain, false);
  assert.equal(composer.draftFor('uncertain_delivery').text, '', 'proven delivery consumes the submitted draft');
  harness.scope.stop();
});

test('an accepted send completes the originating draft while another pane is mounted', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'out_A' });
  await mountSettled(harness);
  composer.draftFor('out_A').text = 'one accepted prompt';
  const prepared = composer.payloadFor('out_A');
  assert.equal(prepared.ok, true);
  void harness.pane.sendRequest({ ...prepared.payload, hash: prepared.hash });
  await flush();
  const send = harness.mutations.find(entry => entry.tool === 'integrated_send' && !entry.settled);
  harness.props.processId = 'out_B';
  await nextTick();
  await mountSettled(harness);
  composer.draftFor('out_B').text = 'B draft';
  send.resolve({ turnId: 'native-accepted' });
  await flush();
  assert.equal(composer.draftFor('out_A').text, '', 'the originating draft is consumed out of view');
  assert.equal(composer.submissionFor('out_A'), undefined);
  assert.equal(composer.draftFor('out_B').text, 'B draft', 'the mounted pane is untouched');
  assert.equal(harness.pane.state().error, '');
  harness.scope.stop();
});

test('a Patterm slash command runs locally and never reaches the native agent', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'resume_A' });
  await mountSettled(harness);
  harness.pane.controls.value = { selectors: [], commands: [{ name: 'resume', source: 'patterm' }, { name: 'compact' }] };
  composer.draftFor('resume_A').text = '/resume auth refactor';
  const prepared = composer.payloadFor('resume_A');
  await harness.pane.sendRequest({ ...prepared.payload, hash: prepared.hash });
  await flush();
  assert.equal(harness.pane.resumeOpen.value, true);
  assert.equal(harness.pane.resumeQuery.value, 'auth refactor');
  assert.equal(composer.draftFor('resume_A').text, '', 'the command draft is consumed');
  assert.equal(composer.submissionFor('resume_A'), undefined);
  assert.equal(harness.mutations.some(entry => entry.tool === 'integrated_command' || entry.tool === 'integrated_send'), false);
  harness.scope.stop();
});

test('a message starting with "!" is a prompt, never an unsandboxed shell command', async () => {
  composer.clearDrafts();
  const plain = createHarness({ processId: 'bang_B' });
  await mountSettled(plain);
  plain.pane.controls.value = { selectors: [], commands: [{ name: 'shell' }] };
  composer.draftFor('bang_B').text = '!important';
  const plainPrepared = composer.payloadFor('bang_B');
  void plain.pane.sendRequest({ ...plainPrepared.payload, hash: plainPrepared.hash });
  await flush();
  assert.ok(plain.mutations.some(entry => entry.tool === 'integrated_send'), 'the text is an ordinary prompt');
  assert.ok(!plain.mutations.some(entry => entry.tool === 'integrated_command'));
  plain.scope.stop();
});

test('uncertain delivery survives switching and blocks an ordinary resend', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'uncertain_A' });
  await mountSettled(harness);
  composer.draftFor('uncertain_A').text = 'unresolved prompt';
  const prepared = composer.payloadFor('uncertain_A');
  void harness.pane.sendRequest({ ...prepared.payload, hash: prepared.hash });
  await flush();
  harness.mutations.find(entry => entry.tool === 'integrated_send' && !entry.settled)
    .resolve({ delivery: 'uncertain', message_id: prepared.payload.messageId, error: 'connection lost' });
  await flush();
  harness.requests.find(entry => entry.tool === 'integrated_delivery' && !entry.settled).resolve({ state: 'unknown' });
  await flush();
  assert.equal(harness.pane.state().uncertain, true);

  harness.props.processId = 'uncertain_B';
  await nextTick();
  await mountSettled(harness);
  assert.equal(harness.pane.state().uncertain, false, 'B has no submission');
  harness.props.processId = 'uncertain_A';
  await nextTick();
  await mountSettled(harness);
  assert.equal(harness.pane.state().uncertain, true, 'the uncertainty returns with the process');
  harness.requests.filter(entry => entry.tool === 'integrated_delivery' && !entry.settled).at(-1)?.resolve({ state: 'unknown' });
  await flush();
  const count = harness.mutations.length;
  void harness.pane.sendRequest({ ...prepared.payload, hash: prepared.hash });
  await flush();
  assert.equal(harness.mutations.length, count, 'an ordinary send cannot duplicate an unresolved submission');
  void harness.pane.sendRequest(composer.submissionFor('uncertain_A').payload, { force: true });
  await flush();
  assert.equal(harness.mutations.length, count + 1, 'the explicit Send again path is deliberate');
  harness.scope.stop();
});

test('a lost transport reply stays uncertain instead of becoming a retryable error', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'lost_A' });
  await mountSettled(harness);
  composer.draftFor('lost_A').text = 'maybe accepted';
  const prepared = composer.payloadFor('lost_A');
  void harness.pane.sendRequest({ ...prepared.payload, hash: prepared.hash });
  await flush();
  harness.mutations.find(entry => entry.tool === 'integrated_send' && !entry.settled)
    .reject(new Error('Connection lost. The command was not retried.'));
  await flush();
  assert.equal(harness.pane.state().uncertain, true);
  assert.equal(harness.pane.state().error, '', 'a lost reply is not a plain send error');
  assert.equal(composer.draftFor('lost_A').text, '');
  assert.equal(harness.pane.transcriptMessages.value.at(-1).text, 'maybe accepted');
  assert.equal(harness.pane.transcriptMessages.value.at(-1).delivery.state, 'uncertain');
  harness.requests.find(entry => entry.tool === 'integrated_delivery' && !entry.settled)?.resolve({ state: 'unknown' });
  await flush();
  harness.scope.stop();
});

test('a definitive rejection clears the submission and stays recoverable', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'reject_A' });
  await mountSettled(harness);
  composer.draftFor('reject_A').text = 'bad prompt';
  const prepared = composer.payloadFor('reject_A');
  void harness.pane.sendRequest({ ...prepared.payload, hash: prepared.hash });
  await flush();
  harness.mutations.find(entry => entry.tool === 'integrated_send' && !entry.settled)
    .reject(new Error('Message is empty'));
  await flush();
  assert.equal(harness.pane.state().pending, false, 'a definitive rejection can be retried');
  assert.equal(harness.pane.state().error, '', 'the failure belongs to its message');
  assert.equal(composer.draftFor('reject_A').text, '');
  const failed = harness.pane.transcriptMessages.value.at(-1);
  assert.equal(failed.text, 'bad prompt');
  assert.equal(failed.delivery.state, 'failed');
  assert.equal(failed.delivery.error, 'Message is empty');
  composer.draftFor('reject_A').text = 'A newer draft';
  harness.pane.retryMessage(prepared.payload.messageId);
  await flush();
  assert.equal(harness.pane.transcriptMessages.value.filter(message => message.role === 'user').length, 1, 'retry reuses the failed bubble');
  assert.equal(harness.pane.transcriptMessages.value.at(-1).delivery.state, 'sending');
  assert.equal(harness.mutations.at(-1).args.message_id, prepared.payload.messageId, 'retry retains the submission identity');
  assert.equal(composer.draftFor('reject_A').text, 'A newer draft', 'retry leaves new text alone');
  harness.scope.stop();
});

test('a choice answer held in the queue stays answered and cannot be sent twice', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'choice_A' });
  await mountPush(harness, 1, 'Which one?');
  const channel = harness.answerChannel();
  const answer = 'Answer to pick: First (a)';
  void channel.send(answer);
  await flush();
  const send = harness.mutations.find(entry => entry.tool === 'integrated_send');
  assert.equal(channel.canSend.value, false, 'a second answer waits for the first');
  send.resolve({ delivery: 'held' });
  await flush();
  await resolveGets(harness, { ...pushConversation(1, 'Which one?'), queue: [{ id: send.args.message_id, text: answer, delivery: 'held', reason: 'compact' }] });
  assert.equal(harness.pane.transcriptMessages.value.some(message => message.role === 'user'), false, 'the queue shows the held answer, not the transcript');
  assert.equal(channel.queued.value.get('pick'), answer, 'the held answer still locks its card');
  harness.scope.stop();
});

const pushConversation = (revision, text) => ({
  provider: 'codex',
  streaming: true,
  revision,
  status: 'working',
  history_truncated: false,
  messages: { data: [{ id: 'assistant_1', role: 'assistant', kind: 'text', text }] },
  permissions: { data: [] },
  questions: { data: [] }
});

async function mountPush(harness, revision, text) {
  await resolveSubscriptions(harness);
  await resolveControls(harness);
  // The stream subscribes first and then takes one authoritative snapshot.
  assert.equal(pending(harness, 'integrated_get').length, 1, 'a push-capable mount reads one snapshot');
  await resolveGets(harness, pushConversation(revision, text));
  await flush();
  assert.equal(pending(harness, 'integrated_get').length, 0, 'no second snapshot follows the subscription');
}

test('a snapshot that lands after live deltas keeps them exactly once', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'push_A' });
  await mountPush(harness, 0, 'Initial response.');
  assert.deepEqual(harness.conversationSubscriptions.at(-1), { process_id: 'push_A', subscribed: true, snapshot: true });

  harness.emitConversationEvent({ processId: 'push_A', revision: 1, kind: 'append', id: 'assistant_1', delta: ' FIRST' });
  await flush();
  // A refresh is in flight while a newer delta arrives.
  void harness.pane.refresh();
  await flush();
  harness.emitConversationEvent({ processId: 'push_A', revision: 3, kind: 'append', id: 'assistant_1', delta: ' RECOVERED-STREAM-MARKER' });
  await flush();
  // The snapshot boundary predates the newer delta; the delta must survive.
  await resolveGets(harness, pushConversation(1, 'Initial response. FIRST'));
  await flush();
  assert.equal(
    harness.pane.messages.value.find(message => message.id === 'assistant_1')?.text,
    'Initial response. FIRST RECOVERED-STREAM-MARKER',
    'a snapshot taken before a buffered delta does not lose it'
  );

  // A snapshot that already contains the delta must not duplicate it.
  void harness.pane.refresh();
  await flush();
  harness.emitConversationEvent({ processId: 'push_A', revision: 4, kind: 'append', id: 'assistant_1', delta: ' AGAIN' });
  await flush();
  await resolveGets(harness, pushConversation(4, 'Initial response. FIRST RECOVERED-STREAM-MARKER AGAIN'));
  await flush();
  assert.equal(
    harness.pane.messages.value.find(message => message.id === 'assistant_1')?.text,
    'Initial response. FIRST RECOVERED-STREAM-MARKER AGAIN',
    'a snapshot that includes a buffered delta does not replay it'
  );
  harness.scope.stop();
});

test('a revision gap re-reads the authoritative snapshot', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'gap_A' });
  await mountPush(harness, 1, 'Initial response.');
  const before = pending(harness, 'integrated_get').length;
  harness.emitConversationEvent({ processId: 'gap_A', revision: 5, kind: 'append', id: 'assistant_1', delta: ' partial' });
  await flush();
  assert.equal(pending(harness, 'integrated_get').length, before + 1, 'a skipped revision triggers a snapshot read');
  await resolveGets(harness, pushConversation(5, 'Initial response. authoritative'));
  await flush();
  assert.equal(harness.pane.messages.value.find(message => message.id === 'assistant_1')?.text, 'Initial response. authoritative');
  harness.scope.stop();
});

test('events for another process never reach the visible transcript', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'switch_A' });
  await mountPush(harness, 1, 'A response');
  harness.props.processId = 'switch_B';
  await nextTick();
  await mountPush(harness, 1, 'B response');
  harness.emitConversationEvent({ processId: 'switch_A', revision: 9, kind: 'append', id: 'assistant_1', delta: ' leaked' });
  await flush();
  assert.equal(harness.pane.messages.value.find(message => message.id === 'assistant_1')?.text, 'B response');
  harness.lifecycle.beforeUnmount.forEach(callback => callback());
  assert.deepEqual(harness.conversationSubscriptions.at(-1), { process_id: 'switch_B', subscribed: false }, 'unmount releases the process stream');
  harness.scope.stop();
});

test('typed forms validate, submit native values, and honour conditional fields', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'forms_A' });
  const payload = {
    messages: { data: [] },
    permissions: { data: [] },
    questions: { data: [] },
    forms: { data: [{
      id: 'frm_1',
      title: 'Deploy',
      fields: [
        { key: 'name', type: 'string', title: 'Name', required: true },
        { key: 'count', type: 'integer', title: 'Count', minimum: 1, maximum: 10, default: 2 },
        { key: 'enabled', type: 'boolean', title: 'Enabled', default: true },
        { key: 'labels', type: 'multiselect', title: 'Labels', options: [{ value: 'a', label: 'A' }], minItems: 1, custom: true },
        { key: 'extra', type: 'string', title: 'Extra', required: true, when: [{ key: 'enabled', op: 'eq', value: false }] }
      ]
    }] }
  };
  await resolveSubscriptions(harness);
  await resolveControls(harness);
  await resolveGets(harness, payload);
  const form = harness.pane.forms.value[0];
  assert.equal(form.id, 'frm_1');
  assert.equal(harness.pane.formAnswers.value.frm_1.count, 2, 'native defaults seed the dock');
  assert.deepEqual(
    harness.pane.activeFields(form).map(field => field.key),
    ['name', 'count', 'enabled', 'labels'],
    'conditional fields stay hidden while their clause does not match'
  );

  // A missing required answer is rejected locally, with no native call.
  harness.pane.setFormAnswer('frm_1', 'name', '');
  void harness.pane.replyForm(form);
  await flush();
  assert.match(harness.pane.formErrors.value.frm_1, /Answer "Name"/);
  assert.equal(harness.mutations.length, 0, 'no native reply for an invalid form');

  // A conditional field becomes required once its clause matches.
  harness.pane.setFormAnswer('frm_1', 'enabled', false);
  assert.ok(harness.pane.activeFields(form).some(field => field.key === 'extra'), 'the conditional field appears');
  harness.pane.setFormAnswer('frm_1', 'enabled', true);

  // A valid submit keeps each field's native JSON type.
  harness.pane.setFormAnswer('frm_1', 'name', 'Patterm');
  harness.pane.setFormAnswer('frm_1', 'count', '3');
  harness.pane.toggleMultiselect('frm_1', 'labels', 'a', true);
  harness.pane.setFormAnswer('frm_1', 'labels:custom', 'custom');
  void harness.pane.replyForm(form);
  await flush();
  const reply = harness.mutations.find(entry => entry.tool === 'integrated_form_reply');
  assert.deepEqual(reply.args, {
    process_id: 'forms_A',
    form_id: 'frm_1',
    answer: { name: 'Patterm', count: 3, enabled: true, labels: ['a', 'custom'] }
  }, 'form replies keep native value types and skip hidden fields');
  reply.resolve({ ok: true });
  await flush();
  await resolveGets(harness, emptyConversation());
  harness.scope.stop();
});

test('a numeric condition matches the typed integer editor value', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'forms_num' });
  const payload = {
    messages: { data: [] },
    permissions: { data: [] },
    questions: { data: [] },
    forms: { data: [{ id: 'frm_num', title: 'Conditional', fields: [
      { key: 'count', type: 'integer', title: 'Count', required: true, minimum: 1, maximum: 10 },
      { key: 'detail', type: 'string', title: 'Explanation for two', required: true, when: [{ key: 'count', op: 'eq', value: 2 }] }
    ] }] }
  };
  await resolveSubscriptions(harness);
  await resolveControls(harness);
  await resolveGets(harness, payload);
  const form = harness.pane.forms.value[0];
  assert.deepEqual(harness.pane.activeFields(form).map(field => field.key), ['count']);
  // A number input stores the raw string while the user types.
  harness.pane.setFormAnswer('frm_num', 'count', '2');
  assert.deepEqual(harness.pane.activeFields(form).map(field => field.key), ['count', 'detail'], 'the dependent field appears for a typed 2');
  void harness.pane.replyForm(form);
  await flush();
  assert.match(harness.pane.formErrors.value.frm_num, /Explanation for two/, 'the visible dependent field is required');
  assert.equal(harness.mutations.length, 0, 'no native reply while the dependent answer is missing');
  harness.pane.setFormAnswer('frm_num', 'detail', 'Two');
  void harness.pane.replyForm(form);
  await flush();
  const reply = harness.mutations.find(entry => entry.tool === 'integrated_form_reply');
  assert.deepEqual(reply.args.answer, { count: 2, detail: 'Two' }, 'the typed integer submits as a number');
  reply.resolve({ ok: true });
  await flush();
  await resolveGets(harness, emptyConversation());
  harness.scope.stop();
});

test('a pending request reply cannot be submitted twice', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'respond_A' });
  const payload = {
    messages: { data: [] },
    permissions: { data: [{ id: 'per_1', action: 'Bash', resources: ['echo hi'], always_label: 'Allow for this session' }] },
    questions: { data: [] },
    forms: { data: [] }
  };
  await resolveSubscriptions(harness);
  await resolveControls(harness);
  await resolveGets(harness, payload);
  assert.equal(harness.pane.permissions.value[0]?.alwaysLabel, 'Allow for this session', 'the persistent action carries its real scope');
  void harness.pane.replyPermission('per_1', 'always');
  void harness.pane.replyPermission('per_1', 'once');
  await flush();
  assert.equal(harness.mutations.filter(entry => entry.tool === 'integrated_permission_reply').length, 1, 'the second click is ignored while awaiting');
  assert.equal(harness.pane.isResponding('per_1'), true);
  harness.mutations[0].resolve({ ok: true });
  await flush();
  await resolveGets(harness, emptyConversation());
  assert.equal(harness.pane.isResponding('per_1'), false, 'the guard clears after the reply settles');
  harness.scope.stop();
});

test('sending and answering a request return the transcript to its end', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'follow_A' });
  await mountSettled(harness, {
    ...emptyConversation(),
    permissions: { data: [{ id: 'per_follow', action: 'Bash', resources: ['echo hi'] }] },
    forms: { data: [] }
  });
  const follows = [];
  harness.pane.transcriptRef.value = { followEnd: () => follows.push('end') };
  harness.pane.controls.value = { selectors: [], commands: [{ name: 'resume', source: 'patterm' }] };
  void harness.pane.sendRequest({ text: '/resume', references: [], attachments: [], messageId: 'cccccccc-cccc-cccc-cccc-cccccccccccc', hash: 'hash' });
  await flush();
  assert.deepEqual(follows, [], 'a Patterm command that opens a dialog leaves the transcript where it is');
  void harness.pane.sendRequest({ text: 'hello', references: [], attachments: [], messageId: 'dddddddd-dddd-dddd-dddd-dddddddddddd', hash: 'hash' });
  await flush();
  assert.deepEqual(follows, ['end'], 'sending returns to the end');
  void harness.pane.replyPermission('per_follow', 'once');
  await flush();
  assert.deepEqual(follows, ['end', 'end'], 'answering a permission prompt returns to the end');
  harness.scope.stop();
});

test('a live append keeps an open tool output consistent', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'tool_live' });
  const payload = {
    provider: 'codex',
    streaming: true,
    revision: 1,
    status: 'working',
    messages: { data: [{ id: 'bash_live', role: 'assistant', kind: 'tool', title: 'bash', text: 'first output', tool: { name: 'bash', input: { command: 'pnpm dev' }, state: { status: 'running' } } }] },
    permissions: { data: [] },
    questions: { data: [] },
    forms: { data: [] }
  };
  await resolveSubscriptions(harness);
  await resolveControls(harness);
  await resolveGets(harness, payload);
  await flush();
  const before = harness.pane.messages.value.find(message => message.id === 'bash_live');
  assert.equal(before.tool.output, 'first output');
  harness.emitConversationEvent({ processId: 'tool_live', revision: 2, kind: 'append', id: 'bash_live', delta: ' PARENT-LIVE-MARKER' });
  await flush();
  const after = harness.pane.messages.value.find(message => message.id === 'bash_live');
  assert.equal(after.text, 'first output PARENT-LIVE-MARKER');
  assert.equal(after.tool.output, 'first output PARENT-LIVE-MARKER', 'the open tool output follows live deltas before completion');
  harness.scope.stop();
});

test('reconnecting and unknown status never claim the agent is idle', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'reconnect_A' });
  await mountPush(harness, 1, 'Live');
  harness.emitConversationEvent({ processId: 'reconnect_A', revision: 2, kind: 'reconnecting' });
  await flush();
  assert.equal(harness.pane.state().streamStatus, 'reconnecting');

  // A successful snapshot after reconnect is authoritative even if no later
  // status notification arrives.
  void harness.pane.refresh();
  await flush();
  await resolveGets(harness, { ...pushConversation(2, 'Live'), status: 'idle' });
  await flush();
  assert.equal(harness.pane.state().streamStatus, 'idle');
  harness.emitConversationEvent({ processId: 'reconnect_A', revision: 2, kind: 'reconnecting' });
  await flush();

  // An unknown snapshot status must not clear the explicit reconnect state.
  void harness.pane.refresh();
  await flush();
  await resolveGets(harness, { ...pushConversation(2, 'Live'), status: 'unknown' });
  await flush();
  assert.equal(harness.pane.state().streamStatus, 'reconnecting');

  // A confirmed working snapshot replaces it.
  void harness.pane.refresh();
  await flush();
  await resolveGets(harness, pushConversation(2, 'Live'));
  await flush();
  assert.equal(harness.pane.state().streamStatus, 'working');
  harness.scope.stop();
});

test('permission, questions and thinking count as working, and a missing status keeps what is shown', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'status_A' });
  await mountPush(harness, 1, 'Live');
  harness.emitConversationEvent({ processId: 'status_A', revision: 2, kind: 'status', status: 'idle' });
  await flush();
  await resolveGets(harness, { ...pushConversation(2, 'Live'), status: 'idle' });
  assert.equal(harness.pane.state().streamStatus, 'idle');
  harness.emitConversationEvent({ processId: 'status_A', revision: 3, kind: 'status', status: 'permission' });
  await flush();
  assert.equal(harness.pane.state().streamStatus, 'working', 'an agent waiting for permission is mid-turn');
  await resolveGets(harness, { ...pushConversation(3, 'Live'), status: 'permission' });
  assert.equal(harness.pane.state().streamStatus, 'working');
  void harness.pane.refresh();
  await flush();
  await resolveGets(harness, { ...pushConversation(3, 'Live'), status: undefined });
  assert.equal(harness.pane.state().streamStatus, 'working', 'a snapshot without a status keeps the indicator');
  void harness.pane.refresh();
  await flush();
  await resolveGets(harness, { ...pushConversation(3, 'Live'), status: 'idle' });
  void harness.pane.refresh();
  await flush();
  await resolveGets(harness, { ...pushConversation(3, 'Live'), status: 'thinking' });
  assert.equal(harness.pane.state().streamStatus, 'working', 'thinking is working');
  void harness.pane.refresh();
  await flush();
  await resolveGets(harness, { ...pushConversation(3, 'Live'), status: 'question' });
  assert.equal(harness.pane.state().streamStatus, 'working', 'an agent waiting on an answer is mid-turn');
  harness.scope.stop();
});

test('a lost connection shows reconnecting, not a failed turn', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'lost_A' });
  await mountPush(harness, 1, 'Live');
  harness.emitConversationEvent({ processId: 'lost_A', revision: 2, kind: 'error', id: 'connection_error', delta: 'Lost the connection to the native agent.' });
  await flush();
  assert.equal(harness.pane.state().streamStatus, 'reconnecting');
  harness.scope.stop();
});

test('a polling pane takes its status from snapshots', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'poll_status_A' });
  await mountSettled(harness, { ...replyConversation('first'), status: 'working' });
  assert.equal(harness.pane.state().streamStatus, 'working');
  const poll = [...harness.timers.values()][0];
  harness.timers.clear();
  poll.callback();
  await flush();
  await resolveGets(harness, { ...replyConversation('first'), status: 'idle' });
  assert.equal(harness.pane.state().streamStatus, 'idle');
  harness.scope.stop();
});

test('controls and control ownership do not gate the first transcript read', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'parallel_A' });
  await flush();
  assert.equal(pending(harness, 'integrated_controls').length, 1);
  assert.equal(pending(harness, 'integrated_get').length, 1, 'the transcript read starts before controls or subscription settle');
  assert.deepEqual(harness.conversationSubscriptions, [{ process_id: 'parallel_A', subscribed: true, snapshot: true }], 'the stream subscribes before its snapshot');
  await resolveGets(harness, replyConversation('first paint'));
  assert.deepEqual(harness.pane.messages.value.map(message => message.text), ['first paint']);
  assert.deepEqual(harness.conversationSubscriptions.at(-1), { process_id: 'parallel_A', subscribed: false }, 'a polled provider releases the speculative stream');
  assert.equal(harness.timers.size, 1, 'a polled provider keeps one poll timer');
  await resolveSubscriptions(harness);
  await resolveControls(harness);
  assert.deepEqual(harness.pane.messages.value.map(message => message.text), ['first paint']);
  harness.scope.stop();
});

test('switching back paints the cached pane until the fresh snapshot replaces it', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'cache_A' });
  await mountSettled(harness, replyConversation('a cached'));
  harness.props.processId = 'cache_B';
  await nextTick();
  assert.deepEqual(harness.pane.messages.value, [], 'an unseen process starts empty');
  await mountSettled(harness, replyConversation('b reply'));
  const subscribes = harness.conversationSubscriptions.length;
  harness.props.processId = 'cache_A';
  await nextTick();
  assert.deepEqual(harness.pane.messages.value.map(message => message.text), ['a cached'], 'the cached pane paints before any read settles');
  await flush();
  assert.equal(harness.conversationSubscriptions.slice(subscribes).filter(entry => entry.subscribed).length, 0, 'a process last seen polling reads directly');
  await resolveGets(harness, replyConversation('a fresh'));
  assert.deepEqual(harness.pane.messages.value.map(message => message.text), ['a fresh']);
  harness.scope.stop();
});

test('a streaming process revisited from cache still reads a single snapshot', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'cache_push_A' });
  await mountPush(harness, 1, 'A live');
  harness.props.processId = 'cache_push_B';
  await nextTick();
  await mountPush(harness, 1, 'B live');
  harness.props.processId = 'cache_push_A';
  await nextTick();
  assert.equal(harness.pane.messages.value[0]?.text, 'A live');
  await mountPush(harness, 2, 'A newer');
  assert.equal(harness.pane.messages.value[0]?.text, 'A newer');
  assert.deepEqual(harness.conversationSubscriptions.at(-1), { process_id: 'cache_push_A', subscribed: true, snapshot: true });
  harness.scope.stop();
});

test('a subscription reply with a snapshot opens the pane without a separate read', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'reply_A', subscribeReply: args => ({ ok: true, snapshot: pushConversation(2, `${args.process_id} from the reply`) }) });
  await resolveSubscriptions(harness);
  await resolveControls(harness);
  await flush();
  assert.equal(harness.requests.filter(entry => entry.tool === 'integrated_get').length, 0, 'no transcript read follows the subscription');
  assert.equal(harness.pane.messages.value[0]?.text, 'reply_A from the reply');
  harness.emitConversationEvent({ processId: 'reply_A', revision: 2, kind: 'append', id: 'assistant_1', delta: ' STALE' });
  harness.emitConversationEvent({ processId: 'reply_A', revision: 3, kind: 'append', id: 'assistant_1', delta: ' LIVE' });
  await flush();
  assert.equal(harness.pane.messages.value[0]?.text, 'reply_A from the reply LIVE', 'deltas the snapshot already holds are skipped');
  harness.props.processId = 'reply_B';
  await nextTick();
  await flush();
  assert.equal(harness.pane.messages.value[0]?.text, 'reply_B from the reply', 'a switch also takes one round trip');
  assert.equal(harness.requests.filter(entry => entry.tool === 'integrated_get').length, 0);
  harness.scope.stop();
});

test('a subscription reply answered after a later refresh cannot replace it', async () => {
  composer.clearDrafts();
  // The server answers the snapshot outside its request queue, so a refresh
  // asked for later, such as after a permission reply, can land first.
  let releaseReply;
  const harness = createHarness({ processId: 'reply_late', subscribeReply: () => new Promise((resolve) => { releaseReply = () => resolve({ ok: true, snapshot: pushConversation(1, 'OLD') }); }) });
  await resolveSubscriptions(harness);
  await resolveControls(harness);
  await flush();
  void harness.pane.refresh();
  await flush();
  await resolveGets(harness, pushConversation(2, 'NEW'));
  assert.equal(harness.pane.messages.value[0]?.text, 'NEW');
  releaseReply();
  await flush();
  assert.equal(harness.pane.messages.value[0]?.text, 'NEW', 'the older subscription snapshot is dropped');
  harness.emitConversationEvent({ processId: 'reply_late', revision: 3, kind: 'append', id: 'assistant_1', delta: ' LIVE' });
  await flush();
  assert.equal(harness.pane.messages.value[0]?.text, 'NEW LIVE', 'later events still apply');
  harness.scope.stop();
});

test('a subscription reply that cannot read an ended session shows the ended state', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'reply_gone', subscribeReply: () => ({ ok: true, snapshot_error: 'Claude Integrated session is not active' }) });
  await resolveSubscriptions(harness);
  await resolveControls(harness);
  await flush();
  assert.equal(harness.pane.state().ended, true);
  assert.equal(harness.pane.state().refreshError, '');
  assert.equal(harness.requests.filter(entry => entry.tool === 'integrated_get').length, 0);
  harness.scope.stop();
});

test('an exited process drops its cached pane', async () => {
  composer.clearDrafts();
  const first = createHarness({ processId: 'cache_exit' });
  await mountSettled(first, replyConversation('before exit'));
  first.props.exited = true;
  await nextTick();
  first.lifecycle.beforeUnmount.forEach(callback => callback());
  first.scope.stop();
  const second = createHarness({ processId: 'cache_exit', keepCache: true });
  assert.deepEqual(second.pane.messages.value, []);
  second.scope.stop();
});

test('an unmounted pane is cached for its next mount', async () => {
  composer.clearDrafts();
  const first = createHarness({ processId: 'cache_mount' });
  await mountSettled(first, replyConversation('kept'));
  first.lifecycle.beforeUnmount.forEach(callback => callback());
  first.scope.stop();
  const second = createHarness({ processId: 'cache_mount', keepCache: true });
  assert.deepEqual(second.pane.messages.value.map(message => message.text), ['kept']);
  second.scope.stop();
});

test('controls are read again only when a snapshot reports a new revision', async () => {
  composer.clearDrafts();
  const controlsWith = (model, revision) => ({ selectors: [{ id: 'model', label: 'Model', value: model, options: [] }], commands: [{ name: 'compact' }], ...(revision ? { revision } : {}) });
  const first = createHarness({ processId: 'revision_A' });
  await resolveSubscriptions(first);
  pending(first, 'integrated_controls')[0].resolve(controlsWith('opus', 'r1'));
  await flush();
  await resolveGets(first, { ...replyConversation('hello'), controls_revision: 'r1' });
  assert.equal(pending(first, 'integrated_controls').length, 0, 'a snapshot with the revision just read reads nothing');
  first.lifecycle.beforeUnmount.forEach(callback => callback());
  first.scope.stop();

  const second = createHarness({ processId: 'revision_A', keepCache: true });
  await resolveSubscriptions(second);
  assert.equal(pending(second, 'integrated_controls').length, 0, 'a revisit shows its cached controls without reading them');
  await resolveGets(second, { ...replyConversation('hello'), controls_revision: 'r1' });
  assert.equal(pending(second, 'integrated_controls').length, 0);
  assert.equal(second.pane.controls.value.selectors[0].value, 'opus');
  void second.pane.refresh();
  await flush();
  await resolveGets(second, { ...replyConversation('hello'), controls_revision: 'r2' });
  assert.equal(pending(second, 'integrated_controls').length, 1, 'a changed revision reads them again');
  pending(second, 'integrated_controls')[0].resolve(controlsWith('sonnet', 'r2'));
  await flush();
  assert.equal(second.pane.controls.value.selectors[0].value, 'sonnet');
  second.lifecycle.beforeUnmount.forEach(callback => callback());
  second.scope.stop();

  // A newer revision arriving while controls are read is not lost when the
  // read returns the older state.
  const racing = createHarness({ processId: 'revision_A', keepCache: true });
  await resolveSubscriptions(racing);
  await resolveGets(racing, { ...replyConversation('hello'), controls_revision: 'r3' });
  assert.equal(pending(racing, 'integrated_controls').length, 1);
  void racing.pane.refresh();
  await flush();
  await resolveGets(racing, { ...replyConversation('hello'), controls_revision: 'r4' });
  assert.equal(pending(racing, 'integrated_controls').length, 1, 'one read at a time');
  pending(racing, 'integrated_controls')[0].resolve(controlsWith('opus', 'r3'));
  await flush();
  assert.equal(pending(racing, 'integrated_controls').length, 1, 'a read that returned older controls than the latest snapshot reads again');
  pending(racing, 'integrated_controls')[0].resolve(controlsWith('haiku', 'r4'));
  await flush();
  assert.equal(pending(racing, 'integrated_controls').length, 0);
  assert.equal(racing.pane.controls.value.selectors[0].value, 'haiku');
  assert.equal(racing.pane.controls.value.revision, 'r4');

  // Settings that change and change back report an earlier revision again;
  // it still counts while a read for the changed ones is under way.
  void racing.pane.refresh();
  await flush();
  await resolveGets(racing, { ...replyConversation('hello'), controls_revision: 'r5' });
  assert.equal(pending(racing, 'integrated_controls').length, 1);
  void racing.pane.refresh();
  await flush();
  await resolveGets(racing, { ...replyConversation('hello'), controls_revision: 'r4' });
  pending(racing, 'integrated_controls')[0].resolve(controlsWith('opus', 'r5'));
  await flush();
  assert.equal(pending(racing, 'integrated_controls').length, 1, 'changed back while reading, the controls are read again');
  pending(racing, 'integrated_controls')[0].resolve(controlsWith('haiku', 'r4'));
  await flush();
  assert.equal(pending(racing, 'integrated_controls').length, 0);
  assert.equal(racing.pane.controls.value.revision, 'r4');
  racing.lifecycle.beforeUnmount.forEach(callback => callback());
  racing.scope.stop();

  const unversioned = createHarness({ processId: 'revision_B' });
  await mountSettled(unversioned, replyConversation('no revision'));
  unversioned.lifecycle.beforeUnmount.forEach(callback => callback());
  unversioned.scope.stop();
  const revisit = createHarness({ processId: 'revision_B', keepCache: true });
  await flush();
  assert.equal(pending(revisit, 'integrated_controls').length, 1, 'controls without a revision are read on every visit');
  revisit.scope.stop();
});

test('palette requests run through the open conversation and its controls are published', async () => {
  const harness = createHarness({ processId: 'A' });
  await resolveSubscriptions(harness);
  for (const entry of pending(harness, 'integrated_controls')) {
    entry.resolve({ selectors: [{ id: 'model', label: 'Model', value: 'opus', options: [{ value: 'opus', label: 'Opus' }, { value: 'sonnet', label: 'Sonnet' }] }], commands: [] });
  }
  await flush();
  await resolveGets(harness, emptyConversation());
  assert.equal(harness.published.get('A')?.selectors[0]?.value, 'opus', 'the palette can offer this conversation\'s selectors');
  assert.equal(harness.workspaceRequest({ kind: 'integrated', processId: 'B', action: 'interrupt' }), false, 'another agent\'s request is not handled here');
  assert.equal(harness.workspaceRequest({ kind: 'integrated', processId: 'A', action: 'interrupt' }), true);
  await flush();
  assert.deepEqual(harness.mutations.map(entry => [entry.tool, entry.args]), [['integrated_interrupt', { process_id: 'A' }]], 'Stop response uses the controlled mutation path');
  harness.lifecycle.beforeUnmount.forEach(callback => callback());
  assert.equal(harness.published.has('A'), false, 'closing the conversation withdraws its selectors');
  assert.equal(harness.workspaceRequest({ kind: 'integrated', processId: 'A', action: 'interrupt' }), false);
  harness.scope.stop();
});

test('a submitted message stays visible from sending through acknowledgement and native echo', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'optimistic_A' });
  await mountPush(harness, 1, 'I am checking the implementation.');
  composer.draftFor('optimistic_A').text = 'Please include the failure state too.';
  const prepared = composer.payloadFor('optimistic_A');
  void harness.pane.sendRequest({ ...prepared.payload, hash: prepared.hash });
  await flush();
  const userRows = () => harness.pane.transcriptMessages.value.filter(message => message.role === 'user');
  assert.equal(userRows().length, 1, 'the user sees the message before any backend reply');
  assert.equal(userRows()[0].delivery.state, 'sending');
  assert.equal(composer.draftFor('optimistic_A').text, '', 'the composer clears immediately');
  const rowId = helpers.groupTranscriptMessages(harness.pane.transcriptMessages.value).at(-1).id;
  composer.draftFor('optimistic_A').text = 'A newer draft';
  harness.mutations.find(entry => entry.tool === 'integrated_send').resolve({ turnId: 'active-turn' });
  await flush();
  await resolveGets(harness, pushConversation(1, 'I am checking the implementation.'));
  assert.equal(userRows().length, 1, 'acknowledgement does not remove the local row');
  assert.equal(userRows()[0].delivery.state, 'accepted');
  assert.equal(composer.draftFor('optimistic_A').text, 'A newer draft');
  harness.emitConversationEvent({ processId: 'optimistic_A', revision: 2, kind: 'replace', message: {
    id: 'native-user-1', clientMessageId: prepared.payload.messageId,
    role: 'user', kind: 'text', text: prepared.payload.text
  } });
  await flush();
  assert.equal(userRows().length, 1, 'the native echo replaces the local row without duplication');
  assert.equal(userRows()[0].id, 'native-user-1');
  assert.equal(helpers.groupTranscriptMessages(harness.pane.transcriptMessages.value).at(-1).id, rowId, 'the rendered row retains its key');
  harness.scope.stop();
});

test('a native echo before a lost send reply cannot regress delivery or clear the next submission', async () => {
  composer.clearDrafts();
  const h = createHarness({ processId: 'echo_first' });
  await mountPush(h, 1, 'Working.');
  composer.draftFor('echo_first').text = 'Same text';
  const first = composer.payloadFor('echo_first');
  void h.pane.sendRequest({ ...first.payload, hash: first.hash });
  await flush();
  const firstSend = h.mutations.at(-1);
  h.emitConversationEvent({ processId: 'echo_first', revision: 2, kind: 'replace', message: {
    id: 'native-first', clientMessageId: first.payload.messageId, role: 'user', kind: 'text', text: 'Same text'
  } });
  await flush();
  assert.equal(h.pane.state().pending, false, 'native admission settles the send');
  assert.equal(composer.outgoingFor('echo_first').length, 0);
  composer.draftFor('echo_first').text = 'Same text';
  const second = composer.payloadFor('echo_first');
  assert.notEqual(second.payload.messageId, first.payload.messageId);
  void h.pane.sendRequest({ ...second.payload, hash: second.hash });
  await flush();
  firstSend.reject(new Error('Connection lost. The command was not retried.'));
  await flush();
  assert.equal(composer.submissionFor('echo_first').payload.messageId, second.payload.messageId);
  assert.equal(h.pane.state().uncertain, false);
  assert.equal(h.pane.transcriptMessages.value.filter(message => message.role === 'user').length, 2, 'identical text is distinct intent');
  h.scope.stop();
});

test('an accepted message survives tab switches before its native row arrives', async () => {
  composer.clearDrafts();
  const h = createHarness({ processId: 'pending_A' });
  await mountPush(h, 1, 'Working.');
  composer.draftFor('pending_A').text = 'Keep this visible';
  const prepared = composer.payloadFor('pending_A');
  void h.pane.sendRequest({ ...prepared.payload, hash: prepared.hash });
  await flush();
  h.mutations.at(-1).resolve({ turnId: 'turn_A' });
  await flush();
  await resolveGets(h, pushConversation(1, 'Working.'));
  h.props.processId = 'pending_B';
  await nextTick();
  await mountPush(h, 1, 'Another agent.');
  assert.equal(h.pane.transcriptMessages.value.some(message => message.text === 'Keep this visible'), false);
  h.props.processId = 'pending_A';
  await nextTick();
  await mountPush(h, 1, 'Working.');
  const row = h.pane.transcriptMessages.value.find(message => message.role === 'user');
  assert.equal(row.text, 'Keep this visible');
  assert.equal(row.delivery.state, 'accepted');
  h.scope.stop();
});

test('several follow-ups keep their send order as native echoes arrive', async () => {
  composer.clearDrafts();
  const id = 'multiple_followups';
  const h = createHarness({ processId: id });
  await mountPush(h, 1, 'Still working.');
  const prepared = [];
  for (const text of ['First follow-up', 'Second follow-up', 'Third follow-up']) {
    composer.draftFor(id).text = text;
    const request = composer.payloadFor(id);
    prepared.push(request);
    void h.pane.sendRequest({ ...request.payload, hash: request.hash });
    await flush();
    if (prepared.length < 3) {
      h.mutations.at(-1).resolve({ turnId: 'active-turn' });
      await flush();
      await resolveGets(h, pushConversation(1, 'Still working.'));
    }
  }
  const rows = () => h.pane.transcriptMessages.value.filter(message => message.role === 'user');
  const expected = ['First follow-up', 'Second follow-up', 'Third follow-up'];
  assert.deepEqual(rows().map(message => message.text), expected);
  assert.deepEqual(rows().map(message => message.delivery.state), ['accepted', 'accepted', 'sending']);
  for (let index = 0; index < prepared.length; index++) {
    h.emitConversationEvent({ processId: id, revision: index + 2, kind: 'replace', message: {
      id: `native-${index}`, clientMessageId: prepared[index].payload.messageId,
      role: 'user', kind: 'text', text: expected[index]
    } });
    await flush();
    assert.deepEqual(rows().map(message => message.text), expected, `echo ${index + 1} does not reorder later sends`);
  }
  h.scope.stop();
});

test('/new in the assistant starts a fresh assistant without a workspace project', async () => {
  const calls = [];
  const harness = createHarness({ processId: 'assistant_new', onNewSession: async id => { calls.push(id); } });
  await mountSettled(harness);
  harness.pane.controls.value = { selectors: [], commands: [{ name: 'new', source: 'patterm' }] };
  composer.draftFor('assistant_new').text = '/new';
  const prepared = composer.payloadFor('assistant_new');
  await harness.pane.sendRequest({ ...prepared.payload, hash: prepared.hash });
  await flush();
  assert.deepEqual(calls, ['assistant_new']);
  assert.deepEqual(harness.mutations, [], 'the workspace new-agent tool is not used');
  harness.scope.stop();
});

test('/new during an assistant restart surfaces an error instead of succeeding', async () => {
  const client = { exports: {} };
  const source = fs.readFileSync(new URL('../resources/js/lib/assistant.ts', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  let finish;
  const calls = [];
  const window = { patterm: { integratedCall: tool => { calls.push(tool); return new Promise(resolve => { finish = resolve; }); } } };
  new Function('require', 'exports', 'window', outputText)(require, client.exports, window);
  const restarting = client.exports.restartAssistant('assistant_busy');
  const harness = createHarness({ processId: 'assistant_busy', onNewSession: client.exports.newAssistantSession });
  await mountSettled(harness);
  harness.pane.controls.value = { selectors: [], commands: [{ name: 'new', source: 'patterm' }] };
  composer.draftFor('assistant_busy').text = '/new';
  const prepared = composer.payloadFor('assistant_busy');
  await harness.pane.sendRequest({ ...prepared.payload, hash: prepared.hash });
  await flush();
  assert.match(harness.pane.state().error, /already restarting/);
  assert.deepEqual(calls, ['assistant_restart']);
  finish({ process_id: 'assistant_resumed', voice: { active: false } });
  await restarting;
  harness.scope.stop();
});


test('/restart in the assistant resumes through its owner without a workspace project', async () => {
  const calls = [];
  const harness = createHarness({ processId: 'assistant_restart', onRestartSession: async id => { calls.push(id); } });
  await mountSettled(harness);
  harness.pane.controls.value = { selectors: [], commands: [{ name: 'restart', source: 'patterm' }] };
  composer.draftFor('assistant_restart').text = '/restart';
  const prepared = composer.payloadFor('assistant_restart');
  await harness.pane.sendRequest({ ...prepared.payload, hash: prepared.hash });
  await flush();
  assert.deepEqual(calls, ['assistant_restart']);
  assert.deepEqual(harness.mutations, []);
  harness.scope.stop();
});


test('a control rejection reveals takeover and takeover restores a lost subscription', async () => {
  const h = createHarness({ processId: 'assistant_control' });
  await mountSettled(h);
  assert.equal(h.pane.state().controlling, true);
  // BrowserTerminalSessions.guard sends this before rejecting a stale write.
  h.emitControl({ processId: 'assistant_control', controlling: false });
  assert.equal(h.pane.state().controlling, false, 'the composer shows Take control');
  const takes = [];
  h.windowMock.patterm.terminalTakeControl = async args => {
    takes.push(args);
    h.emitControl({ processId: args.process_id, controlling: true });
    return { ok: true };
  };
  const taking = h.pane.takeControl();
  assert.deepEqual(h.subscriptions.at(-1).args, { process_id: 'assistant_control', subscribed: true });
  assert.deepEqual(takes, [], 'restore subscription before claiming control');
  await resolveSubscriptions(h);
  await taking;
  assert.deepEqual(takes, [{ process_id: 'assistant_control' }]);
  assert.equal(h.pane.state().controlling, true);
  h.scope.stop();
});

test('assistant /restart refuses an active response until it finishes', async () => {
  const calls = [];
  const h = createHarness({ processId: 'assistant_busy_restart', onRestartSession: async id => { calls.push(id); } });
  await mountPush(h, 1, 'Still responding.');
  h.pane.controls.value = { selectors: [], commands: [{ name: 'restart', source: 'patterm' }] };
  const restart = async () => {
    composer.draftFor(h.props.processId).text = '/restart';
    const prepared = composer.payloadFor(h.props.processId);
    await h.pane.sendRequest({ ...prepared.payload, hash: prepared.hash });
    await flush();
  };
  await restart();
  assert.deepEqual(calls, [], 'a slash command cannot silently interrupt active work');
  assert.match(h.pane.state().error, /working|responding/i);
  h.emitConversationEvent({ processId: h.props.processId, revision: 2, kind: 'status', status: 'idle' });
  await flush();
  await restart();
  assert.deepEqual(calls, ['assistant_busy_restart']);
  h.scope.stop();
});


test('reopening a dead parent reads saved history and /restart uses its owner without sending a prompt', async () => {
  composer.clearDrafts();
  const calls = [];
  const h = createHarness({ processId: 'dead_parent', exited: true, restartable: true, onRestartSession: async id => { calls.push(id); } });
  await flush();
  await resolveSubscriptions(h);
  const read = pending(h, 'integrated_get')[0];
  assert.deepEqual(read.args, { process_id: 'dead_parent', transcript_only: true });
  read.resolve({ provider: 'claude', ...replyConversation('saved before crash') });
  await flush();
  assert.equal(h.pane.messages.value[0].text, 'saved before crash');
  assert.equal(h.conversationSubscriptions.length, 0, 'reopening does not reconnect to the dead host');
  h.emitControl({ processId: 'dead_parent', controlling: true });
  composer.draftFor('dead_parent').text = 'continue';
  let prepared = composer.payloadFor('dead_parent');
  await h.pane.sendRequest({ ...prepared.payload, hash: prepared.hash });
  assert.deepEqual(calls, []);
  composer.draftFor('dead_parent').text = ' /restart ';
  prepared = composer.payloadFor('dead_parent');
  await h.pane.sendRequest({ ...prepared.payload, hash: prepared.hash });
  assert.deepEqual(calls, ['dead_parent']);
  assert.deepEqual(h.mutations, []);
  h.scope.stop();
});
