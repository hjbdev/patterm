import assert from 'node:assert/strict';

import { ago, capitalize, memberState, membersLabel, modelLabel, shortAgo, splitSummary, STATE_ORDER } from '../resources/js/lib/agentDigest';
import type { RowActivity } from '../resources/js/lib/rowActivity';

// A summary's first sentence says what the thread is for; the rest says where it stands.
assert.deepEqual(
  splitSummary('Adding a copy button to code blocks. The button matches the diff viewer; it wants to run the full check.'),
  { goal: 'Adding a copy button to code blocks.', now: 'The button matches the diff viewer; it wants to run the full check.' }
);
assert.deepEqual(splitSummary('Reviewing the release notes'), { goal: 'Reviewing the release notes', now: 'Reviewing the release notes' }, 'one sentence is both');
assert.equal(splitSummary('Checking the e.g. case before 0.9. Then shipping.').goal, 'Checking the e.g. case before 0.9.', 'a lower-case word after a full stop does not start a sentence');

assert.equal(modelLabel('claude-opus-5-5'), 'Opus 5.5');
assert.equal(modelLabel('claude-sonnet-5'), 'Sonnet 5');
assert.equal(modelLabel('gpt-5-codex'), 'GPT-5-codex');
assert.equal(modelLabel(null), null);

const now = Date.parse('2026-10-11T12:00:00Z');
assert.equal(shortAgo('2026-10-11T11:59:30Z', now), 'now');
assert.equal(shortAgo('2026-10-11T11:58:00Z', now), '2m');
assert.equal(shortAgo('2026-10-11T09:00:00Z', now), '3h');
assert.equal(shortAgo('2026-10-09T12:00:00Z', now), '2d');
assert.equal(shortAgo('2026-10-11T12:05:00Z', now), 'now', 'a clock behind the server reads as now');
assert.equal(shortAgo(null, now), '');
assert.equal(ago('2026-10-11T11:59:30Z', now), 'just now', 'under a minute reads as just now, never "now ago"');
assert.equal(ago('2026-10-11T11:58:00Z', now), '2m ago');

const activity = (self: RowActivity['self']): RowActivity => ({ self, subagents: { working: 0, permission: 0, error: 0 } });
assert.equal(memberState(activity('permission')), 'attention');
assert.equal(memberState(activity('error')), 'attention');
assert.equal(memberState(activity('working')), 'working');
assert.equal(memberState(activity('closing')), 'done');
assert.equal(memberState(activity('idle')), 'idle');

assert.equal(membersLabel({ subagents: 2, processes: 1 }, ' · '), '2 subagents · 1 process');
assert.equal(membersLabel({ subagents: 1, processes: 0 }, ', '), '1 subagent');
assert.equal(membersLabel({ subagents: 0, processes: 3 }, ', '), '3 processes');
assert.equal(capitalize('needs permission'), 'Needs permission');
assert.deepEqual(STATE_ORDER, ['attention', 'working', 'waiting', 'done', 'idle'], 'the board shows what needs you first');

console.log('agent digest smoke passed');
