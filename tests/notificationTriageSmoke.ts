import assert from 'node:assert/strict';
import type { IntegratedConversationEvent, IntegratedConversationMessage } from '../app/Services/IntegratedConversation';
import { NotificationTriage, QUIET_THRESHOLD, TurnDigests, messageTerms, quietProbability, turnStarter, type TurnDigest } from '../app/Services/NotificationTriage';

let revision = 0;
const event = (message: IntegratedConversationMessage, kind: 'append' | 'replace' = 'append'): IntegratedConversationEvent =>
  ({ processId: 'agent', revision: ++revision, kind, message });
const user = (id: string, text: string): IntegratedConversationMessage => ({ id, role: 'user', kind: 'text', text });
const say = (id: string, text: string): IntegratedConversationMessage => ({ id, role: 'assistant', kind: 'text', text });
const tool = (id: string, name: string, parentId?: string): IntegratedConversationMessage => ({ id, role: 'assistant', kind: 'tool', text: '', tool: { name }, parentId });
const turn = (startedBy: TurnDigest['startedBy'], finalMessage: string, tools: string[] = []): TurnDigest => ({ startedBy, finalMessage, tools, toolCount: tools.length });

// The user row that starts a turn says who sent it.
assert.equal(turnStarter('Can you fix the pager?'), 'user');
assert.equal(turnStarter('[report from process_12: completed]\nGREEN'), 'agent');
assert.equal(turnStarter('[message from process_7]\nRebase first'), 'agent');
assert.equal(turnStarter('[Patterm timer timer_1 (reviews): condition met]'), 'timer');
assert.equal(turnStarter('<task-notification>\n<task-id>b1</task-id>'), 'system');

// The digest keeps the current turn: its starter, last message and tools.
const digests = new TurnDigests();
assert.equal(digests.get('agent'), null);
digests.observe('agent', event(user('u1', '[report from process_3: completed] done')));
digests.observe('agent', event(tool('t1', 'Bash')));
digests.observe('agent', event(tool('t1', 'Bash'), 'replace'));
digests.observe('agent', event(tool('s1', 'Read', 't1')));
digests.observe('agent', event(say('a1', 'Still')));
digests.observe('agent', event(say('a1', 'Still waiting on Fable.'), 'replace'));
digests.observe('agent', event(tool('t2', 'mcp__patterm__timer_fire_when_reported_all')));
assert.deepEqual(digests.get('agent'), { startedBy: 'agent', finalMessage: 'Still waiting on Fable.', tools: ['Bash', 'mcp__patterm__timer_fire_when_reported_all'], toolCount: 2 },
  'a replaced row counts once and subagent rows are not the turn');
// A replay of the starting row keeps the turn; a new user row starts another.
digests.observe('agent', event(user('u1', '[report from process_3: completed] done'), 'replace'));
assert.equal(digests.get('agent')?.toolCount, 2);
digests.observe('agent', event(user('u2', 'Ship it')));
assert.equal(digests.get('agent'), null, 'a new turn has no final message yet');
digests.observe('agent', event(say('a2', 'Merged.')));
assert.equal(digests.get('agent')?.startedBy, 'user');

// A dropped stream recovers from a snapshot without replaying rows, so the
// turn has no digest until the next one starts.
digests.observe('agent', event(say('a3', 'Still waiting on the reviewers.')));
digests.observe('agent', { processId: 'agent', revision: ++revision, kind: 'reconnecting' });
digests.observe('agent', event(user('u2', 'Ship it'), 'replace'));
assert.equal(digests.get('agent'), null, 'a lost turn is announced as before');
digests.observe('agent', event(user('u3', 'Next one')));
digests.observe('agent', event(say('a4', 'On it.')));
assert.equal(digests.get('agent')?.finalMessage, 'On it.');
digests.observe('agent', { processId: 'agent', revision: ++revision, kind: 'error', id: 'connection_error' });
assert.equal(digests.get('agent'), null);

// Codex's generic tool rows map back to the native names the model learned.
const codex = new TurnDigests();
codex.observe('codex', event(user('c1', 'Open the PR')));
codex.observe('codex', event({ id: 'c2', role: 'assistant', kind: 'tool', text: '', tool: { name: 'commandExecution', input: { command: 'git push' } } }));
codex.observe('codex', event({ id: 'c3', role: 'assistant', kind: 'tool', text: '', tool: { name: 'mcpToolCall', input: { server: 'patterm', tool: 'reference_attach' } } }));
codex.observe('codex', event({ id: 'c4', role: 'assistant', kind: 'tool', text: '', tool: { name: 'dynamicToolCall', input: { tool: 'lookup' } } }));
codex.observe('codex', event(say('c5', 'Opened the PR.')));
assert.deepEqual(codex.get('codex')?.tools, ['exec', 'mcp__patterm__reference_attach', 'lookup']);

// Tokens match scikit-learn's analyzer, where a combining mark splits a word.
assert.deepEqual(messageTerms('Café build'), ['cafe', 'build', 'cafe build']);

// The model quiets turns that only wait, and keeps results and questions.
const quiet = [
  turn('agent', 'Two reviewers are running now. I will synthesise their findings once they both report.', ['mcp__patterm__spawn_agent']),
  turn('agent', 'Smartypants has finished round 1. I am still waiting on Fable before I fix anything.'),
  turn('user', 'The full test run is still going in the background. I will check the result when it finishes.', ['Bash'])
];
const loud = [
  turn('user', 'Which of the three layouts do you want me to build?'),
  turn('user', 'Done. I fixed the off-by-one in the pager and pushed it to main.', ['Edit', 'Bash']),
  turn('user', 'I have opened the PR: it adds the retry and the tests pass. Merging is your call.', ['Bash', 'Bash'])
];
for (const t of quiet) assert.ok(quietProbability(t, false) >= QUIET_THRESHOLD, `quiet: ${t.finalMessage}`);
for (const t of loud) assert.ok(quietProbability(t, false) < QUIET_THRESHOLD, `announced: ${t.finalMessage}`);

// A pending wait pushes a turn towards quiet, but the message still decides.
const relay = turn('agent', 'Round 2 came back red with three real bugs. I have fixed all three and sent it back for another review.', ['Bash']);
assert.ok(quietProbability(relay, true) > quietProbability(relay, false));
assert.ok(quietProbability(loud[0]!, true) < QUIET_THRESHOLD, 'a question is announced even while waiting');

// Triage: off by default, the model decides, no transcript announces.
let enabled = false;
let waiting = false;
let current: TurnDigest | null = quiet[0]!;
const triage = new NotificationTriage({ get: () => current }, () => waiting, () => enabled);
assert.deepEqual(triage.decide('agent'), { quiet: false, reason: 'disabled' });
enabled = true;
assert.equal(triage.decide('agent').quiet, true);
current = loud[0]!;
waiting = true;
const decision = triage.decide('agent');
assert.equal(decision.quiet, false, 'waiting alone does not quiet a question');
assert.equal(decision.reason === 'model' && decision.waiting, true);
current = null;
assert.deepEqual(triage.decide('agent'), { quiet: false, reason: 'no_transcript' });

// Scoring is cheap enough to run inline at every turn end.
const started = process.hrtime.bigint();
for (let i = 0; i < 2000; i++) quietProbability(quiet[i % 3]!, false);
const microseconds = Number(process.hrtime.bigint() - started) / 2000 / 1000;
assert.ok(microseconds < 2000, `scoring took ${microseconds.toFixed(0)} µs`);

console.log('notification triage smoke passed');
