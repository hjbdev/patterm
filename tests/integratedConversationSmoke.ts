import assert from 'node:assert/strict';
import { appendedTextStart } from '../resources/js/lib/streamReveal';
import {
  applyConversationStreamEvent,
  buildFormAnswer,
  buildQuestionAnswers,
  buildTranscriptTool,
  diffChangeCounts,
  extractUnifiedDiff,
  formAsQuestions,
  formFieldVisible,
  formOptionValue,
  formQuestionState,
  groupTranscriptMessages,
  transcriptMessageOrigin,
  transcriptThoughtDurations,
  transcriptToolGroupSummary,
  transcriptTurnDurations,
  transcriptRowIndexForMessage,
  isSessionUnavailableError,
  mergeTranscriptWindows,
  normaliseConversation,
  normaliseForms,
  normaliseMessages,
  normaliseQuestions,
  normaliseTranscriptAttachments,
  stripAnsi,
  nestSubagentMessages,
  normalisePermissions,
  normaliseTasks,
  normaliseUsage,
  subagentSummary,
  toolActivityLabel,
  elapsedLabel,
  type TranscriptMessage
} from '../resources/js/lib/integratedConversation';
import { archiveTranscript } from '../resources/js/lib/historyTranscript';
import type { ConversationMessageRecord } from '../resources/js/types';
import { countTasks, taskInlineDetail, taskKindLabel, taskStatusLabel } from '../resources/js/lib/integratedTasks';
import { contextPercent, formatCost, usageRows } from '../resources/js/lib/integratedUsage';

assert.equal(appendedTextStart('Hello', 'Hello world', true), 5, 'only the new suffix fades');
assert.equal(appendedTextStart('Hello\n', 'Hello world\n', true), 5, 'Markdown presentation newlines do not hide an append');
assert.equal(appendedTextStart('Hello', 'Hello world', false), null, 'static history never animates');
assert.equal(appendedTextStart('Hello', 'Hi world', true), null, 'Markdown restructuring does not fade unrelated text');
assert.equal(appendedTextStart('Hello', `Hello ${'x'.repeat(257)}`, true), null, 'large snapshots appear without a long fade');
assert.equal(appendedTextStart('', 'Hello', true), null, 'virtualised remounts do not replay the animation');

// Claude flattens tool_use records into shell rows without text, so the
// normaliser must keep them (regression: they were dropped from the pane).
const claude = normaliseConversation({
  messages: {
    data: [
      { id: 'user_1', type: 'user', text: 'Hello' },
      { id: 'assistant_1', type: 'assistant', text: 'Working' },
      { id: 'tool_1', type: 'shell', command: 'Bash', output: '{"command":"ls"}' },
      {
        id: 'msg_1',
        type: 'assistant',
        content: [
          { type: 'text', text: 'Reading the file' },
          { type: 'tool', name: 'read', state: { status: 'completed', input: { filePath: '/tmp/a' }, output: 'contents' } }
        ]
      }
    ]
  },
  permissions: { data: [{ id: 'per_1', action: 'Bash', resources: ['ls'] }] },
  questions: { data: [] }
});
assert.deepEqual(claude.messages.map((message) => [message.id, message.kind, message.title]), [
  ['user_1', 'text', undefined],
  ['assistant_1', 'text', undefined],
  ['tool_1', 'tool', 'Bash'],
  ['msg_1-0', 'text', undefined],
  ['msg_1-1', 'tool', 'read']
]);
assert.equal(claude.messages[2]?.text, '{"command":"ls"}', 'shell output is preserved');
assert.equal(claude.messages[4]?.text, 'contents', 'tool part output is extracted');
assert.deepEqual(claude.messages[4]?.tool?.state, { status: 'completed', input: { filePath: '/tmp/a' }, output: 'contents' }, 'provider state stays available for richer rendering');
assert.equal(claude.messages[4]?.tool?.target, '/tmp/a', 'a completed native tool keeps its file target when input is nested in state');
assert.deepEqual(claude.messages[4]?.tool?.input, { filePath: '/tmp/a' }, 'a completed native tool keeps inspectable input');
assert.deepEqual(claude.permissions, [{ id: 'per_1', action: 'Bash', resources: ['ls'] }]);

// Codex shell rows also arrive without text.
const codex = normaliseMessages({ data: [{ id: 'shell_1', type: 'shell', command: 'exec_command', output: 'done' }] });
assert.equal(codex.length, 1);
assert.equal(codex[0]?.kind, 'tool');
assert.equal(codex[0]?.title, 'exec_command');
assert.equal(codex[0]?.text, 'done');
assert.equal(normaliseMessages([{ id: 'bare', type: 'assistant', text: 'plain' }]).length, 1, 'bare arrays are accepted');
assert.deepEqual(normaliseMessages([
  { id: 'msg_instructions', type: 'synthetic', text: 'Instructions from: /repo/AGENTS.md\n# AGENTS.md' },
  { id: 'msg_agent', type: 'agent-switched', text: 'build' },
  { id: 'msg_model', type: 'model-switched', text: 'gpt' }
]), [], 'OpenCode synthetic and switch rows stay out of the transcript');
assert.deepEqual(mergeTranscriptWindows(
  [{ id: 'old', role: 'user', kind: 'text', text: 'earlier' }, { id: 'shared', role: 'assistant', kind: 'text', text: 'partial' }],
  [{ id: 'shared', role: 'assistant', kind: 'text', text: 'complete' }, { id: 'new', role: 'user', kind: 'text', text: 'latest' }]
).map((message) => [message.id, message.text]), [
  ['old', 'earlier'], ['shared', 'complete'], ['new', 'latest']
], 'a refreshed live window replaces overlapping rows without dropping loaded history');
assert.deepEqual(normaliseMessages({ data: [{ id: 'assistant', type: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }] }] })
  .map((message) => [message.id, message.kind, message.text]), [['assistant-0', 'reasoning', 'thinking']]);
assert.deepEqual(groupTranscriptMessages([
  { id: 'redacted', role: 'assistant', kind: 'reasoning', text: '' },
  { id: 'answer', role: 'assistant', kind: 'text', text: 'Visible answer' }
]).map((row) => row.id), ['answer'], 'empty native thinking blocks do not create blank transcript rows');
const prependedContext = groupTranscriptMessages([
  { id: 'older', role: 'assistant', kind: 'tool', text: '', tool: buildTranscriptTool('read', { input: { path: 'older.ts' }, state: { status: 'completed' } }, '') },
  { id: 'visible', role: 'assistant', kind: 'tool', text: '', tool: buildTranscriptTool('read', { input: { path: 'visible.ts' }, state: { status: 'completed' } }, '') }
]);
assert.equal(transcriptRowIndexForMessage(prependedContext, 'tools:visible'), 0, 'a visible context group keeps its scroll anchor when an older call joins it');

// Questions keep provider order and namespace keys by request id.
const questions = normaliseQuestions({
  data: [{
    id: 'que_1',
    questions: [
      { id: 'q_colour', header: 'Colour', question: 'Which colour?', options: [{ label: 'Red', description: 'Warm' }], multiple: true, custom: true },
      { id: 'q_other', header: 'Other', question: 'Anything else?', options: [], multiple: false, custom: true }
    ]
  }]
});
const colour = 'que_1:q_colour';
const other = 'que_1:q_other';
assert.equal(questions.length, 1);
assert.deepEqual(questions[0]?.questions.map((question) => question.key), [colour, other]);
assert.equal(questions[0]?.questions[0]?.multiple, true);
assert.equal(questions[0]?.questions[0]?.custom, true);
assert.deepEqual(questions[0]?.questions[0]?.options, [{ label: 'Red', description: 'Warm' }]);
assert.equal(questions[0]?.questions[1]?.multiple, false);

// Two distinct pending requests that reuse a question id must not share answers.
const shared = normaliseQuestions({
  data: [
    { id: 'request-one', questions: [{ id: 'choice', question: 'First task?', options: [{ label: 'Yes' }], custom: true }] },
    { id: 'request-two', questions: [{ id: 'choice', question: 'Different task?', options: [{ label: 'No' }], custom: true }] }
  ]
});
assert.deepEqual(shared.map((request) => request.questions[0]?.key), ['request-one:choice', 'request-two:choice']);
const isolated = buildQuestionAnswers(shared[1]!.questions, {
  multiple: {},
  single: { 'request-one:choice': 'Yes' },
  custom: {}
});
assert.equal(isolated.ok, false, 'the second request has no answer of its own');
assert.match(isolated.ok ? '' : isolated.error, /Different task\?/);

// Multi-select plus a typed answer, single choice, and the missing-answer error.
const multi = questions[0]!.questions.slice(0, 1);
const free = questions[0]!.questions.slice(1);
assert.deepEqual(buildQuestionAnswers(multi, {
  multiple: { [colour]: ['Red', 'Blue'] },
  single: {},
  custom: { [colour]: 'Green' }
}), { ok: true, answers: [['Red', 'Blue', 'Green']] }, 'custom answers append to multi-select answers');
assert.deepEqual(buildQuestionAnswers(free, {
  multiple: {},
  single: { [other]: 'Nothing' },
  custom: {}
}), { ok: true, answers: [['Nothing']] }, 'single choices submit as a one-item answer');
assert.deepEqual(buildQuestionAnswers(free, {
  multiple: {},
  single: { [other]: 'Nothing' },
  custom: { [other]: 'Actually something' }
}), { ok: true, answers: [['Actually something']] }, 'a typed answer replaces a single choice');
assert.deepEqual(buildQuestionAnswers(questions[0]!.questions, {
  multiple: { [colour]: ['Red'] },
  single: { [other]: 'Nothing' },
  custom: { [colour]: 'Red' }
}), { ok: true, answers: [['Red'], ['Nothing']] }, 'a typed answer equal to a selected option is not duplicated');
const missing = buildQuestionAnswers(questions[0]!.questions, { multiple: {}, single: {}, custom: {} });
assert.equal(missing.ok, false);
assert.match(missing.ok ? '' : missing.error, /Answer "Which colour\?"/);

assert.equal(isSessionUnavailableError('OpenCode Integrated session is not active'), true);
assert.equal(isSessionUnavailableError('Claude Integrated session not found'), true);
assert.equal(isSessionUnavailableError('Codex app-server timed out: thread/items/list'), false);

// Native typed forms keep their own field types and conditional visibility.
const forms = normaliseForms({ data: [
  {
    id: 'frm_1', title: 'Deploy', fields: [
      { key: 'name', type: 'string', title: 'Name', required: true },
      { key: 'count', type: 'integer', title: 'Count', minimum: 1, maximum: 10 },
      { key: 'ratio', type: 'number', title: 'Ratio', minimum: 0.5 },
      { key: 'enabled', type: 'boolean', title: 'Enabled', default: true },
      { key: 'labels', type: 'multiselect', title: 'Labels', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], minItems: 1 },
      { key: 'callback', type: 'external', title: 'Callback', url: 'https://example.test/cb' },
      { key: 'extra', type: 'string', title: 'Extra', when: [{ key: 'enabled', op: 'eq', value: false }] },
      { key: 'unsupported', type: 'matrix' }
    ]
  },
  { id: 'frm_bad', fields: [] }
] });
assert.equal(forms.length, 1, 'malformed forms and unsupported fields are dropped');
const form = forms[0]!;
assert.deepEqual(form.fields.map((field) => field.type), ['string', 'integer', 'number', 'boolean', 'multiselect', 'external', 'string']);
assert.equal(form.fields[4]?.minItems, 1);

// A declinable request with no supported fields stays visible so it can be
// declined; a non-declinable one without fields is still dropped.
assert.deepEqual(normaliseForms([
  { id: 'elicit', title: 'Pick', detail: 'Requested by the linear MCP server', declinable: true, fields: [{ key: 'x', type: 'object' }] },
  { id: 'empty', title: 'Empty', fields: [] }
]), [{ id: 'elicit', title: 'Pick', detail: 'Requested by the linear MCP server', declinable: true, fields: [] }]);

// A conditional field is only required and submitted while its clause matches.
assert.equal(formFieldVisible(form.fields[6]!, { enabled: false }), true);
assert.equal(formFieldVisible(form.fields[6]!, { enabled: true }), false);
const conditionalRequired = normaliseForms({ data: [{ id: 'frm_2', title: 'C', fields: [
  { key: 'enabled', type: 'boolean' },
  { key: 'extra', type: 'string', required: true, when: [{ key: 'enabled', op: 'eq', value: false }] }
] }] })[0]!;
assert.deepEqual(buildFormAnswer(conditionalRequired, { enabled: true }), { ok: true, answer: { enabled: true } }, 'hidden required fields are not submitted');
assert.equal(buildFormAnswer(conditionalRequired, { enabled: false }).ok, false, 'a visible required field is enforced');

// A form made only of choices, as OpenCode's question tool sends, reads as
// questions; answers stay in the form's state as option values.
const choiceForm = normaliseForms([{ id: 'frm_q', title: 'Questions', fields: [
  { key: 'db', type: 'string', title: 'Database', description: 'Which database?', required: true, custom: true, options: [
    { value: 'pg', label: 'PostgreSQL', description: 'Matches the other services' },
    { value: 'sqlite', label: 'SQLite' }
  ] },
  { key: 'envs', type: 'multiselect', title: 'Environments', custom: true, options: [{ value: 'stg', label: 'Staging' }, { value: 'prod', label: 'Production' }] }
] }])[0]!;
assert.deepEqual(formAsQuestions(choiceForm, choiceForm.fields), { id: 'frm_q', questions: [
  { key: 'db', question: 'Which database?', header: 'Database', options: [{ label: 'PostgreSQL', description: 'Matches the other services' }, { label: 'SQLite' }], multiple: false, custom: true },
  { key: 'envs', question: 'Environments', options: [{ label: 'Staging' }, { label: 'Production' }], multiple: true, custom: true, optional: true }
] });
assert.equal(formAsQuestions(form, form.fields), null, 'forms with other field types keep the form card');
assert.equal(formOptionValue(choiceForm.fields[0]!, 'SQLite'), 'sqlite');
assert.deepEqual(formQuestionState(choiceForm.fields, { db: 'pg', envs: ['prod'], 'envs:custom': 'QA' }), {
  multiple: { envs: ['Production'] }, single: { db: 'PostgreSQL' }, custom: { db: '', envs: 'QA' }
});
assert.deepEqual(formQuestionState(choiceForm.fields, { db: 'DuckDB' }).custom.db, 'DuckDB', 'a single answer outside the options is your own text');

// Answers keep native types and validate the native constraints.
assert.deepEqual(buildFormAnswer(form, {
  name: 'Patterm', count: '3', ratio: 1.25, enabled: true, labels: ['a'], 'labels:custom': 'c', callback: 'ignored'
}), { ok: true, answer: { name: 'Patterm', count: 3, ratio: 1.25, enabled: true, labels: ['a', 'c'] } }, 'numbers parse and external fields are not answered');
const formError = (answers: Record<string, unknown>): string => {
  const result = buildFormAnswer(form, answers);
  return result.ok ? '' : result.error;
};
assert.match(formError({ name: '', count: 3, labels: ['a'] }), /Answer "Name"/);
assert.match(formError({ name: 'x', count: 11, labels: ['a'] }), /at most 10/);
assert.match(formError({ name: 'x', count: 2.5, labels: ['a'] }), /whole number/);
assert.match(formError({ name: 'x', count: 2, labels: [] }), /Answer "Labels"/);
const minItemsForm = normaliseForms({ data: [{ id: 'frm_3', title: 'M', fields: [
  { key: 'labels', type: 'multiselect', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], minItems: 2 }
] }] })[0]!;
const minItemsResult = buildFormAnswer(minItemsForm, { labels: ['a'] });
assert.equal(minItemsResult.ok, false, 'minItems is enforced for partial selections');
assert.match(minItemsResult.ok ? '' : minItemsResult.error, /at least 2/);

// Permissions carry the provider's persistent-rule support.
const permissions = normaliseConversation({ messages: { data: [] }, permissions: { data: [
  { id: 'per_1', action: 'Bash', resources: ['rm -rf /'] },
  { id: 'per_2', action: 'Write', resources: [], always: false },
  { id: 'per_3', action: 'Run', resources: [], always: true, always_label: 'Allow for this session' }
] }, questions: { data: [] }, forms: { data: [] } }).permissions;
assert.equal(permissions[0]?.always, undefined, 'providers that support session rules keep Always allow');
assert.equal(permissions[1]?.always, false, 'a request without persistent support is marked');
assert.equal(permissions[2]?.alwaysLabel, 'Allow for this session', 'the persistent action carries its real scope');

// A numeric `when` condition compares the typed editor value with the native
// field type: '2' matches 2 for an integer field, and the dependent field is
// required and submitted like any other visible field.
const conditionalForm = normaliseForms({ data: [{ id: 'frm_cond', title: 'Conditional', fields: [
  { key: 'count', type: 'integer', title: 'Count', required: true, minimum: 1, maximum: 10 },
  { key: 'detail', type: 'string', title: 'Explanation for two', required: true, when: [{ key: 'count', op: 'eq', value: 2 }] }
] }] })[0]!;
const detailField = conditionalForm.fields[1]!;
assert.equal(formFieldVisible(detailField, { count: '2' }, conditionalForm.fields), true, 'a typed integer matches a numeric condition');
assert.equal(formFieldVisible(detailField, { count: 2 }, conditionalForm.fields), true, 'a numeric answer matches too');
assert.equal(formFieldVisible(detailField, { count: '2.5' }, conditionalForm.fields), false, 'a non-integer value does not match');
assert.equal(formFieldVisible(detailField, { count: '' }, conditionalForm.fields), false, 'an empty editor value does not match');
assert.equal(formFieldVisible(detailField, { count: '02' }, conditionalForm.fields), true, 'numeric normalisation ignores leading zeros');
assert.deepEqual(
  buildFormAnswer(conditionalForm, { count: '2', detail: 'Two of them' }),
  { ok: true, answer: { count: 2, detail: 'Two of them' } },
  'the dependent answer is required and the integer stays numeric'
);
const missingDetail = buildFormAnswer(conditionalForm, { count: '2' });
assert.equal(missingDetail.ok, false, 'a visible required dependent field is enforced');
assert.match(missingDetail.ok ? '' : missingDetail.error, /Explanation for two/);
assert.deepEqual(
  buildFormAnswer(conditionalForm, { count: '3' }),
  { ok: true, answer: { count: 3 } },
  'a hidden dependent field is not required or submitted'
);

// Native tool shapes classify into real families instead of title + raw JSON.
const tools = normaliseMessages({ data: [
  { id: 'shell_1', role: 'assistant', kind: 'tool', text: 'total 4\n\u001b[32mfile.txt\u001b[0m', tool: { name: 'commandExecution', input: { command: 'ls -la' }, state: 'inProgress' } },
  { id: 'patch_1', role: 'assistant', kind: 'tool', text: 'update a.ts', tool: { name: 'fileChange', input: { changes: [{ kind: 'update', path: 'a.ts', diff: '@@ -1 +1 @@\n-old\n+new' }] }, state: 'completed' } },
  { id: 'read_1', role: 'assistant', kind: 'tool', text: 'contents', tool: { name: 'read', input: { filePath: '/tmp/a.ts', offset: 10, limit: 20 }, state: { status: 'completed' } } },
  { id: 'grep_1', role: 'assistant', kind: 'tool', text: 'a.ts:1:hit', tool: { name: 'grep', input: { pattern: 'hit', include: 'src' }, state: { status: 'completed' } } },
  { id: 'mcp_1', role: 'assistant', kind: 'tool', text: '{}', tool: { name: 'mcpToolCall', input: { server: 'github', tool: 'search' }, state: 'completed' } },
  { id: 'weird_1', role: 'assistant', kind: 'tool', text: '', tool: { name: 'mysteryTool', input: { path: '/tmp/x' } } }
] });
const toolOf = (index: number) => tools[index]!.tool!;
const shellTool = toolOf(0);
const patchTool = toolOf(1);
const readTool = toolOf(2);
const grepTool = toolOf(3);
const mcpTool = toolOf(4);
const genericTool = toolOf(5);
assert.equal(shellTool.family, 'shell');
assert.equal(shellTool.status, 'running');
assert.equal(shellTool.command, 'ls -la');
assert.equal(shellTool.output?.includes('\u001b'), false, 'terminal colour sequences are stripped from readable output');
assert.equal(patchTool.family, 'patch');
assert.equal(patchTool.patch, '', 'bare hunks are not combined into an unattributed patch');
assert.deepEqual(patchTool.changes, { additions: 1, deletions: 1 });
assert.equal(patchTool.files?.[0]?.name, 'a.ts');
assert.equal(patchTool.files?.[0]?.patch, '@@ -1 +1 @@\n-old\n+new', 'the bare hunk stays with its filename');
assert.equal(readTool.family, 'read');
assert.equal(readTool.target, '/tmp/a.ts');
assert.deepEqual(readTool.args, ['lines 10-30']);
assert.equal(grepTool.family, 'grep');
assert.equal(grepTool.target, 'hit');
assert.deepEqual(grepTool.args, ['src']);
assert.equal(mcpTool.family, 'mcp');
assert.equal(mcpTool.target, 'github: search');
assert.equal(genericTool.family, 'generic');
assert.equal(genericTool.title, 'mysteryTool');
assert.equal(stripAnsi('\u001b[31mred\u001b[0m'), 'red');
assert.equal(extractUnifiedDiff('no diff here'), null);
assert.deepEqual(diffChangeCounts('@@ -1 +1,2 @@\n same\n+added'), { additions: 1, deletions: 0 });

// A live append keeps the rendered tool view consistent with the source text
// before any completion arrives, without mutating the previous state.
const liveTool = normaliseMessages({ data: [{ id: 'live', role: 'assistant', kind: 'tool', text: 'first output', tool: { name: 'commandExecution', input: { command: 'synthetic' }, state: 'inProgress' } }] });
const appended = applyConversationStreamEvent(liveTool, { processId: 'p', revision: 1, kind: 'append', id: 'live', delta: ' NEXT-LIVE-OUTPUT' });
assert.equal(appended[0]?.text, 'first output NEXT-LIVE-OUTPUT');
assert.equal(appended[0]?.tool?.output, 'first output NEXT-LIVE-OUTPUT', 'the tool view follows live deltas');
assert.equal(liveTool[0]?.tool?.output, 'first output', 'the previous state is not mutated');

// Multi-file native changes keep every file's patch and aggregate the counts.
const multiFile = buildTranscriptTool('fileChange', { input: { changes: [
  { path: 'a.ts', diff: '@@ -1 +1 @@\n-oldA\n+newA' },
  { path: 'b.ts', diff: '@@ -1 +1 @@\n-oldB\n+newB' }
] }, state: 'completed' }, '');
assert.deepEqual(multiFile.changes, { additions: 2, deletions: 2 }, 'every changed file is counted');
assert.equal(multiFile.files?.length, 2);
assert.equal(multiFile.files?.[1]?.name, 'b.ts');
assert.equal(multiFile.files?.[1]?.patch, '@@ -1 +1 @@\n-oldB\n+newB', 'the later file keeps its own patch');
assert.equal(multiFile.patch, '', 'bare hunks are not concatenated without their filenames');
const multiGitFile = buildTranscriptTool('fileChange', { input: { changes: [
  { path: 'a.ts', diff: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b' },
  { path: 'b.ts', diff: 'diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-c\n+d' }
] }, state: 'completed' }, '');
assert.match(multiGitFile.patch ?? '', /diff --git a\/a\.ts/);
assert.match(multiGitFile.patch ?? '', /diff --git a\/b\.ts/, 'git-format patches keep their filenames when combined');
assert.deepEqual(multiGitFile.changes, { additions: 2, deletions: 2 });

// Consecutive tool calls collapse without reordering; failures stay visible
// as their own rows.
const grouped = groupTranscriptMessages([
  { id: 'u1', role: 'user', kind: 'text', text: 'go' },
  { id: 'r1', role: 'assistant', kind: 'tool', text: 'a', tool: { name: 'read', family: 'read', status: 'completed', title: 'Read', target: '/a' } },
  { id: 'r2', role: 'assistant', kind: 'tool', text: 'b', tool: { name: 'grep', family: 'grep', status: 'completed', title: 'Search', target: 'needle' } },
  { id: 'r3', role: 'assistant', kind: 'tool', text: 'failed', tool: { name: 'read', family: 'read', status: 'failed', title: 'Read', target: '/b' } },
  { id: 'a1', role: 'assistant', kind: 'text', text: 'done' }
]);
assert.deepEqual(grouped.map((row) => row.kind), ['message', 'tools', 'message', 'message']);
const exploration = grouped[1]!;
assert.equal(exploration.kind, 'tools');
assert.deepEqual(exploration.kind === 'tools' ? exploration.messages.map((message) => message.id) : [], ['r1', 'r2'], 'order is kept and the failure is not swallowed');
assert.deepEqual(exploration.kind === 'tools' ? exploration.targets : [], ['/a', 'needle']);
assert.equal(grouped[2]!.kind === 'message' ? grouped[2]!.message.id : '', 'r3', 'the failed call stays its own row');

const mixed = groupTranscriptMessages([
  { id: 'm1', role: 'assistant', kind: 'tool', text: '', tool: buildTranscriptTool('Bash', { input: { command: 'ls' }, state: 'completed' }, 'x') },
  { id: 'm2', role: 'assistant', kind: 'tool', text: '', tool: buildTranscriptTool('Skill', { input: { skill: 'run' }, state: 'completed' }, 'x') },
  { id: 'm3', role: 'assistant', kind: 'tool', text: '', tool: buildTranscriptTool('Glob', { input: { pattern: '*.ts' }, state: 'completed' }, 'x') },
  { id: 'm4', role: 'assistant', kind: 'tool', text: '', tool: buildTranscriptTool('Bash', { input: { command: 'pwd' }, state: 'running' }, '') },
  { id: 'm5', role: 'assistant', kind: 'tool', text: '', tool: buildTranscriptTool('Edit', { input: { file_path: 'a.ts' }, state: 'completed' }, 'x') },
  { id: 'm6', role: 'assistant', kind: 'tool', text: '', tool: buildTranscriptTool('Bash', { input: { command: 'git diff' }, state: 'completed' }, 'x') }
]);
assert.deepEqual(mixed.map((row) => [row.kind, row.id]), [['tools', 'tools:m1']], 'any tool run groups, edits included');
const mixedGroup = mixed[0]!;
const lone = groupTranscriptMessages([
  { id: 'l1', role: 'assistant', kind: 'tool', text: '', tool: buildTranscriptTool('Bash', { input: { command: 'ls' }, state: 'completed' }, 'x') },
  { id: 'l2', role: 'assistant', kind: 'text', text: 'done' },
  { id: 'l3', role: 'assistant', kind: 'reasoning', text: 'hmm' },
  { id: 'l4', role: 'assistant', kind: 'text', text: 'ok' }
]);
assert.deepEqual(lone.map((row) => [row.kind, row.id]), [['tools', 'tools:l1'], ['message', 'l2'], ['message', 'l3'], ['message', 'l4']], 'a lone call collapses like a group; a lone thought stays a thought row');
assert.deepEqual(mixedGroup.kind === 'tools' ? transcriptToolGroupSummary(mixedGroup.messages) : null, {
  count: 6,
  tools: [{ title: 'Bash', count: 3 }, { title: 'Skill (run)', count: 1 }, { title: 'Glob', count: 1 }, { title: 'Edit', count: 1 }],
  label: '3 Bash, Skill (run), Glob, Edit'
}, 'tool titles are listed once each, in first-seen order, naming skills and counting each title');

// Skills and MCP calls name what ran, in rows and in the group summary.
const named = (name: string, input: Record<string, unknown>) => buildTranscriptTool(name, { input, state: 'completed' }, 'x');
assert.equal(named('Skill', { skill: 'simplify' }).target, 'simplify');
assert.equal(named('skill', { id: 'diagnose' }).target, 'diagnose', 'OpenCode names the skill by id');
assert.equal(named('mcp__patterm__notify_user', { message: 'x' }).target, 'patterm: notify_user');
assert.equal(named('mcp__patterm__scratchpad_create', { name: 'notes' }).target, 'patterm: scratchpad_create', 'an argument called name is not the tool');
assert.equal(named('patterm_f37653dcf531_send_message', { message: 'hi' }).target, 'patterm: send_message', 'OpenCode bridge names parse as MCP');
assert.equal(named('mcptoolcall', { server: 'linear', tool: 'get_issue' }).target, 'linear: get_issue');
assert.equal(named('TaskStop', { task_id: 'b1' }).target, 'b1');
assert.equal(named('AskUserQuestion', { questions: [{ question: 'Which one?' }] }).target, 'Which one?');
assert.deepEqual(transcriptToolGroupSummary([
  { id: 'n1', role: 'assistant', kind: 'tool', text: '', tool: named('mcp__patterm__notify_user', {}) },
  { id: 'n2', role: 'assistant', kind: 'tool', text: '', tool: named('mcp__linear__get_issue', {}) },
  { id: 'n3', role: 'assistant', kind: 'tool', text: '', tool: named('Skill', { skill: 'run' }) },
  { id: 'n4', role: 'assistant', kind: 'tool', text: '', tool: named('Skill', { skill: 'run' }) }
]), {
  count: 4,
  tools: [{ title: 'MCP (notify_user, get_issue)', count: 2 }, { title: 'Skill (run)', count: 2 }],
  label: '2 MCP (notify_user, get_issue), 2 Skill (run)'
});

// Thinking between tool calls folds into the same group, and its duration
// runs to its own finish or the next row's start.
const thoughtful: TranscriptMessage[] = [
  { id: 'p1', role: 'user', kind: 'text', text: 'go', createdAt: '2026-10-04T10:00:00.000Z' },
  { id: 't1', role: 'assistant', kind: 'reasoning', text: 'hmm', createdAt: '2026-10-04T10:00:01.000Z' },
  { id: 't2', role: 'assistant', kind: 'tool', text: '', tool: buildTranscriptTool('Bash', { input: { command: 'ls' }, state: 'completed' }, 'x'), createdAt: '2026-10-04T10:00:03.000Z', completedAt: '2026-10-04T10:00:04.000Z' },
  { id: 't3', role: 'assistant', kind: 'reasoning', text: 'ok', createdAt: '2026-10-04T10:00:04.000Z', completedAt: '2026-10-04T10:00:09.000Z' },
  { id: 't4', role: 'assistant', kind: 'text', text: 'done', createdAt: '2026-10-04T10:00:09.000Z', completedAt: '2026-10-04T10:01:19.000Z' }
];
const thoughtRows = groupTranscriptMessages(thoughtful);
assert.deepEqual(thoughtRows.map((row) => row.id), ['p1', 'tools:t1', 't4']);
assert.deepEqual(thoughtRows[1]!.kind === 'tools' ? transcriptToolGroupSummary(thoughtRows[1]!.messages).count : 0, 1, 'thoughts are not counted as tools');
assert.deepEqual([...transcriptThoughtDurations(thoughtful)], [['t1', 2_000], ['t3', 5_000]]);
assert.deepEqual([...transcriptTurnDurations(thoughtful, false)], [['t4', 79_000]], 'the turn runs from the prompt to its last finished row');
assert.deepEqual([...transcriptTurnDurations(thoughtful, true)], [['t4', null]], 'a running turn has no duration yet');
assert.deepEqual([...transcriptTurnDurations([...thoughtful, { id: 'p2', role: 'user', kind: 'text', text: 'again' }], true)], [['t4', 79_000]], 'an earlier turn is finished');

// Attachment descriptors become safe chips; no data payloads or server paths
// are turned into previews.
const attachments = normaliseTranscriptAttachments([
  { type: 'image', name: 'shot.png', url: 'https://example.test/shot.png', mime: 'image/png' },
  { type: 'localImage', name: 'inline.png', url: 'data:image/png;base64,AAAA' },
  { type: 'file', path: '/tmp/report.pdf', mime: 'application/pdf' }
]);
assert.equal(attachments.length, 3);
assert.equal(attachments[0]?.image, true);
assert.equal(attachments[0]?.url, 'https://example.test/shot.png');
assert.equal(attachments[1]?.url, undefined, 'data payloads are never expanded in the transcript');
assert.equal(attachments[2]?.name, 'report.pdf');
assert.equal(attachments[2]?.detail, '/tmp/report.pdf');
{
  // A stored image hash is kept for display; anything else in that field is dropped.
  const sha256 = 'a'.repeat(64);
  const stored = normaliseTranscriptAttachments([{ type: 'image', sha256 }, { type: 'image', name: 'bad.png', sha256: '../etc/passwd' }]);
  assert.deepEqual(stored.map((item) => [item.name, item.sha256]), [['Image', sha256], ['bad.png', undefined]]);
  const [tool] = normaliseMessages([{ id: 'read', role: 'assistant', kind: 'tool', text: '', tool: { name: 'Read', input: { file_path: '/tmp/a.png' }, state: { status: 'completed' }, images: [{ type: 'image', sha256, mime: 'image/png', width: 2, height: 1 }, { sha256: 'nope' }] } }]);
  assert.deepEqual(tool?.tool?.images, [{ sha256, mime: 'image/png', width: 2, height: 1 }], 'tool images keep only valid stored references');
}

// Subagent rows nest under the tool row that spawned them, in order, and the
// spawning row keeps its own transcript row instead of joining a tool group.
{
  const rows = normaliseMessages([
    { id: 'read_1', role: 'assistant', kind: 'tool', text: '', tool: { name: 'Read', input: { file_path: 'a.ts' }, state: { status: 'completed' } } },
    { id: 'task_1', role: 'assistant', kind: 'tool', text: '', tool: { name: 'Task', input: { description: 'Explore' }, state: { status: 'running' } } },
    { id: 'child_prompt', role: 'user', kind: 'text', text: 'Look around', parentId: 'task_1' },
    { id: 'child_read', role: 'assistant', kind: 'tool', text: '', parentId: 'task_1', tool: { name: 'Read', input: { file_path: 'c.ts' }, state: { status: 'completed' } } },
    { id: 'grandchild', role: 'assistant', kind: 'text', text: 'Deep', parentId: 'child_read' },
    { id: 'orphan', role: 'assistant', kind: 'text', text: 'Parent evicted', parentId: 'gone' },
    { id: 'read_2', role: 'assistant', kind: 'tool', text: '', tool: { name: 'Read', input: { file_path: 'b.ts' }, state: { status: 'completed' } } }
  ]);
  const nested = nestSubagentMessages(rows);
  assert.deepEqual(nested.map((row) => row.id), ['read_1', 'task_1', 'orphan', 'read_2'], 'children leave the main list; orphans stay visible');
  const task = nested.find((row) => row.id === 'task_1')!;
  assert.deepEqual(task.children?.map((row) => row.id), ['child_prompt', 'child_read']);
  assert.deepEqual(task.children?.[1]?.children?.map((row) => row.id), ['grandchild'], 'nesting is recursive');
  assert.equal(subagentSummary(task.children!), 'Read c.ts');
  // Activity lists name the MCP server and tool, or the command, not just the family.
  assert.equal(toolActivityLabel(buildTranscriptTool('mcpToolCall', { input: { server: 'patterm', tool: 'assistant_overview', arguments: {} } }, '')), 'patterm: assistant_overview');
  assert.equal(toolActivityLabel(buildTranscriptTool('mcpToolCall', { input: {} }, '')), 'MCP');
  assert.equal(toolActivityLabel(buildTranscriptTool('bash', { input: { command: 'cat notes.txt\necho done' } }, '')), 'Bash: cat notes.txt');
  assert.equal(toolActivityLabel(buildTranscriptTool('read', { input: { file_path: 'src/app.ts' } }, '')), 'Read src/app.ts');
  const grouped = groupTranscriptMessages(rows);
  assert.deepEqual(grouped.map((row) => row.id), ['tools:read_1', 'task_1', 'orphan', 'tools:read_2'], 'a subagent row breaks tool grouping');
  assert.equal(transcriptRowIndexForMessage(grouped, 'grandchild'), 1, 'jumping to a nested row finds its subagent row');
  assert.deepEqual(normaliseMessages([{ id: 'native', type: 'assistant', parentId: 'task_1', content: [{ type: 'text', text: 'Native child' }] }])[0]?.parentId, 'task_1', 'native rows keep their parent');
  assert.equal(normaliseMessages([{ id: 'prompt', type: 'user', parentId: 'task_1', text: 'Lead update' }])[0]?.parentId, 'task_1', 'an OpenCode subagent prompt keeps its parent');
  const cyclic = nestSubagentMessages([
    { id: 'a', role: 'assistant', kind: 'text', text: 'a', parentId: 'b' },
    { id: 'b', role: 'assistant', kind: 'text', text: 'b', parentId: 'a' }
  ]);
  assert.deepEqual(cyclic, [], 'a malformed cycle has no root and renders nothing rather than looping');
}

// Permission cards carry the native detail and labels, never inventing them.
assert.deepEqual(normalisePermissions([{ id: 'p', action: 'Approve the plan?', resources: [], plan: '# Plan', detail: 'Why', command: 'ls', cwd: '/w', patch: '+a', once_label: 'Manual', reject_label: 'Keep planning', feedback: true, extra: 1 }]), [
  { id: 'p', action: 'Approve the plan?', resources: [], onceLabel: 'Manual', rejectLabel: 'Keep planning', detail: 'Why', command: 'ls', cwd: '/w', patch: '+a', plan: '# Plan', feedback: true }
]);

// Native assistant errors, retries, unusual finishes, and compaction rows are
// notices, not prose; projected notice rows keep their level.
assert.deepEqual(normaliseMessages([
  { id: 'msg_a', type: 'assistant', content: [{ type: 'text', text: 'Partial' }], error: { type: 'api', message: 'Overloaded' } },
  { id: 'msg_b', type: 'assistant', content: [{ type: 'text', text: 'Ok' }], retry: { attempt: 2, at: 1, error: { type: 'api', message: '529' } }, finish: 'length' },
  { id: 'cmp', type: 'compaction', status: 'completed', summary: 'long summary' },
  { id: 'n1', role: 'assistant', kind: 'notice', level: 'warning', text: 'Heads up' }
]).map((row) => [row.id, row.kind, row.level, row.text]), [
  ['msg_a-0', 'text', undefined, 'Partial'],
  ['msg_a-error', 'notice', 'error', 'Overloaded'],
  ['msg_b-0', 'text', undefined, 'Ok'],
  ['msg_b-retry', 'notice', 'warning', '529; retried (attempt 2)'],
  ['msg_b-finish', 'notice', 'warning', 'The response stopped at the output token limit.'],
  ['cmp', 'notice', 'info', 'Conversation compacted'],
  ['n1', 'notice', 'warning', 'Heads up']
]);

// Claude TodoWrite and Codex plans share one checklist, summarised in the row.
{
  const [todo] = normaliseMessages([{ id: 'todo_1', role: 'assistant', kind: 'tool', text: '', tool: { name: 'TodoWrite', input: { todos: [
    { content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
    { content: 'Fix the bug', status: 'in_progress', activeForm: 'Fixing the bug' },
    { content: 'Add a test', status: 'pending', activeForm: 'Adding a test' }
  ] } } }]);
  assert.deepEqual(todo?.tool?.checklist, [
    { text: 'Read the code', status: 'completed' }, { text: 'Fixing the bug', status: 'in_progress' }, { text: 'Add a test', status: 'pending' }
  ]);
  assert.equal(todo?.tool?.target, '1/3 done · Fixing the bug');
  const [plan] = normaliseMessages([{ id: 'plan_t', role: 'assistant', kind: 'tool', text: '', tool: { name: 'todowrite', input: { todos: [{ content: 'Step', status: 'inProgress' }] } } }]);
  assert.deepEqual(plan?.tool?.checklist, [{ text: 'Step', status: 'in_progress' }], 'Codex inProgress is in progress');
}

// Tasks: only active tasks can be stopped, whatever the provider claims.
assert.deepEqual(normaliseTasks([
  { id: 't1', label: 'npm test', status: 'running', stoppable: true },
  { id: 't2', label: 'Done', status: 'completed', stoppable: true },
  { label: 'no id' },
  { id: 't3', status: 'weird' }
]), [
  { id: 't1', label: 'npm test', status: 'running', stoppable: true },
  { id: 't2', label: 'Done', status: 'completed', stoppable: false },
  { id: 't3', label: 'Background task', status: 'running', stoppable: false }
]);

// Task chips: readable types, and inline detail only for live or failed work.
{
  const [agent, shell, general, done, failed] = normaliseTasks([
    { id: 'a', label: 'Research', kind: 'local_agent', status: 'running', detail: 'Using WebFetch' },
    { id: 'b', label: 'npm test', kind: 'local_bash', status: 'pending' },
    { id: 'c', label: 'Explore', kind: 'general-purpose', status: 'paused' },
    { id: 'd', label: 'Audit', kind: 'local_agent', status: 'completed', detail: 'This agent\'s report was delivered to you as a message.' },
    { id: 'e', label: 'Lag', status: 'failed', detail: 'API Error: 529 Overloaded' }
  ]);
  assert.deepEqual([agent, shell, general, done, failed].map((task) => taskKindLabel(task!)), ['Agent', 'Shell', 'General purpose', 'Agent', 'Task']);
  assert.deepEqual([agent, shell, general, done, failed].map((task) => taskStatusLabel(task!)), ['Running', 'Queued', 'Paused', 'Done', 'Failed']);
  assert.equal(taskInlineDetail(agent!), 'Using WebFetch', 'live progress shows');
  assert.equal(taskInlineDetail(done!), undefined, 'a finished handback note stays in the drawer');
  assert.equal(taskInlineDetail(failed!), 'API Error: 529 Overloaded', 'failures show why');
  assert.deepEqual(countTasks([agent!, shell!, general!, done!, failed!]), { active: 3, failed: 1, finished: 1 });
}

// Usage telemetry: only valid numbers survive, and the meter's details are compact.
assert.equal(normaliseUsage({}), null);
assert.equal(normaliseUsage({ contextTokens: -1, costUsd: 'x' }), null);
{
  const usage = normaliseUsage({
    contextTokens: 42_300, contextWindow: 200_000, inputTokens: 1_250_000, outputTokens: 9_800, costUsd: 0.314,
    limits: [{ label: '5h limit', usedPercent: 61.6, resetsAt: '2026-09-29T18:00:00.000Z' }, { label: 'bad' }]
  });
  assert.equal(contextPercent(usage), 21);
  assert.deepEqual(usageRows(usage), [
    { label: 'Context', value: '42k / 200k (21%)' },
    { label: 'Tokens', value: '1.3M in · 10k out' },
    { label: 'Cost', value: '$0.31' },
    { label: '5h limit', value: '62% used' }
  ]);
}
assert.deepEqual(usageRows(normaliseUsage({ contextTokens: 900 })), [{ label: 'Context', value: '900' }]);
assert.equal(contextPercent(normaliseUsage({ contextTokens: 900 })), null, 'no ring without a context window');
assert.equal(contextPercent(normaliseUsage({ contextTokens: 300_000, contextWindow: 200_000 })), 100, 'an overfull context caps at 100%');
assert.deepEqual([0.314, 9.995, 12.4].map(formatCost), ['$0.31', '$9.99', '$12']);
assert.deepEqual(normaliseUsage({ lastModelActivityAt: '2026-09-29T18:00:00.000Z' }), { lastModelActivityAt: '2026-09-29T18:00:00.000Z' });
assert.equal(normaliseUsage({ lastModelActivityAt: 'yesterday' }), null);
assert.deepEqual([0, 42_900, 185_000, 4_380_000].map(elapsedLabel), ['0s', '42s', '3m 05s', '1h 13m']);

// Row times: projected rows accept camel and snake fields, native OpenCode
// rows use their message and part times, and a stream replace never moves a
// row's start.
{
  const iso = (ms: number): string => new Date(ms).toISOString();
  const [projected, snake] = normaliseMessages([
    { id: 'p1', role: 'assistant', kind: 'text', text: 'hi', createdAt: iso(1_000), completedAt: iso(2_000) },
    { id: 'p2', role: 'user', kind: 'text', text: 'yo', created_at: iso(3_000), completed_at: 'not a time' }
  ]);
  assert.deepEqual([projected?.createdAt, projected?.completedAt], [iso(1_000), iso(2_000)]);
  assert.deepEqual([snake?.createdAt, snake?.completedAt], [iso(3_000), undefined], 'unparseable times are dropped');
  const native = normaliseMessages([
    { id: 'u', type: 'user', text: 'go', time: { created: 10_000 } },
    { id: 'a', type: 'assistant', time: { created: 11_000, completed: 19_000 }, content: [
      { type: 'reasoning', text: 'think', time: { created: 11_500, completed: 13_500 } },
      { type: 'tool', id: 't', name: 'read', state: { status: 'completed', input: {}, content: [] }, time: { created: 14_000, ran: 14_100, completed: 15_000 } },
      { type: 'text', text: 'done' }
    ] }
  ]);
  assert.deepEqual(native.map((message) => [message.id, message.createdAt, message.completedAt]), [
    ['u', iso(10_000), undefined],
    ['a-0', iso(11_500), iso(13_500)],
    ['a-1', iso(14_000), iso(15_000)],
    ['a-2', iso(11_000), iso(19_000)]
  ], 'native OpenCode rows carry part times, and the last part finishes with its message');
  const started = applyConversationStreamEvent([], { processId: 'p', revision: 1, kind: 'replace', message: { id: 'r', role: 'assistant', kind: 'reasoning', text: '', createdAt: iso(5_000) } });
  const appendedTimes = applyConversationStreamEvent(started, { processId: 'p', revision: 2, kind: 'append', id: 'r', delta: 'hmm' });
  const finished = applyConversationStreamEvent(appendedTimes, { processId: 'p', revision: 3, kind: 'replace', message: { id: 'r', role: 'assistant', kind: 'reasoning', text: 'hmm', createdAt: iso(6_000), completedAt: iso(7_000) } });
  assert.deepEqual([appendedTimes[0]?.createdAt, finished[0]?.createdAt, finished[0]?.completedAt], [iso(5_000), iso(5_000), iso(7_000)], 'a row keeps its first start time');
  const replaced = applyConversationStreamEvent(finished, { processId: 'p', revision: 4, kind: 'replace', message: { id: 'r', role: 'assistant', kind: 'reasoning', text: 'hmm' } });
  assert.equal(replaced[0]?.completedAt, iso(7_000), 'a replace without times keeps the known finish');
}

// Imported history rows begin at the provider's time; a folded tool call
// finishes when its result was recorded.
{
  const row = (id: string, fields: Partial<ConversationMessageRecord>): ConversationMessageRecord => ({
    id, conversationId: 'c', providerMessageId: null, parentProviderMessageId: null, turnId: null, seq: 0, role: 'assistant', kind: 'message', text: '',
    toolName: null, toolStatus: null, toolInputSummary: null, toolOutputSummary: null, redactionCount: 0, tokenCount: null, providerCreatedAt: null,
    metadata: {}, createdAt: '2026-01-01T00:00:00.000Z', ...fields
  });
  const archived = archiveTranscript([
    row('u', { role: 'user', text: 'go', providerCreatedAt: '2026-10-01T10:00:00Z' }),
    row('call', { kind: 'tool_call', toolName: 'Bash', toolInputSummary: '{"command":"ls"}', metadata: { callId: 'x' }, providerCreatedAt: '2026-10-01T10:00:05Z' }),
    row('result', { kind: 'tool_result', role: 'tool', toolOutputSummary: 'a.ts', metadata: { callId: 'x' }, providerCreatedAt: '2026-10-01T10:00:09Z' }),
    row('old', { text: 'no time' })
  ], { projectPath: null, showReasoning: true });
  assert.deepEqual(archived.map((message) => [message.id, message.createdAt, message.completedAt]), [
    ['u', '2026-10-01T10:00:00.000Z', undefined],
    ['call', '2026-10-01T10:00:05.000Z', '2026-10-01T10:00:09.000Z'],
    ['old', undefined, undefined]
  ]);
}

// Text Patterm typed in for another agent or for itself names its sender.
{
  const origin = (text: string) => transcriptMessageOrigin({ id: 'u', role: 'user', kind: 'text', text });
  assert.deepEqual(origin('[message from process_42]\nHello\n\n(Reply with send_message target_process_id "assistant".)'), { kind: 'agent', processId: 'process_42', body: 'Hello' });
  assert.deepEqual(origin('[report from process_7: done]\nTitle\nBody'), { kind: 'agent', processId: 'process_7', status: 'done', body: 'Title\nBody' });
  assert.deepEqual(origin('[agent message from process_9 (Proj / Name), not the user]\nHi'), { kind: 'agent', processId: 'process_9', name: 'Proj / Name', body: 'Hi' });
  assert.deepEqual(origin('[Close requested by process_5 (Review #487)]\nAll checked.\nClose it with close_process once its work is settled, or send it follow-ups with send_message.'), { kind: 'agent', processId: 'process_5', name: 'Review #487', closeRequested: true, body: 'All checked.' });
  assert.deepEqual(origin('[Failure reported by process_6 (preview (serve))]\npreview\nExited with code 1'), { kind: 'agent', processId: 'process_6', name: 'preview (serve)', status: 'failure', body: 'preview\nExited with code 1' });
  assert.deepEqual(origin('[Attention needed by process_8 (Worker)]\nStuck'), { kind: 'agent', processId: 'process_8', name: 'Worker', body: 'Stuck' });
  assert.deepEqual(origin('[Patterm timer timer_1 (wait): condition met]\nprocess_7 reported done'), { kind: 'patterm', label: 'Timer', detail: 'timer_1 (wait): condition met', body: 'process_7 reported done' });
  assert.deepEqual(origin('[Patterm notifications]\nA needs input'), { kind: 'patterm', label: 'Notifications', detail: '', body: 'A needs input' });
  assert.equal(origin('Please read [message from process_1] in the log'), undefined);
  assert.equal(transcriptMessageOrigin({ id: 'a', role: 'assistant', kind: 'text', text: '[message from process_1]\nx' }), undefined);
  const [row] = groupTranscriptMessages([{ id: 'u', role: 'user', kind: 'text', text: '[message from process_42]\nHello' }]);
  assert.equal(row?.kind === 'message' ? row.origin?.kind : null, 'agent');
}

console.log('integrated conversation smoke passed');
