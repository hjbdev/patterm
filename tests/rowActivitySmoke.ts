import assert from 'node:assert/strict';

import { buildAgentTabFamilies } from '../resources/js/lib/agentTabs';
import { activityLookup, countInRing, describeActivity, memberLabel, processActivity, subagentCountClass, subagentPulse } from '../resources/js/lib/rowActivity';
import type { ActivityState, ProcessRecord, SessionRecord } from '../resources/js/types';

function session(id: string, parentId: string | null, activity: ActivityState): SessionRecord {
  return {
    id,
    parentId,
    ptyProcessId: `pty-${id}`,
    processId: `process-${id}`,
    worktreeId: null,
    harness: 'claude',
    interfaceMode: 'tui',
    sessionRole: parentId ? 'child' : 'orchestrator',
    resumeStatus: 'unknown',
    activity,
    lastTitle: id,
    displayName: null,
    model: null,
    reasoning: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    exitedAt: null
  };
}

function processRecord(id: string, status: string, activity: ActivityState): ProcessRecord {
  return {
    id,
    parentProcessId: null,
    kind: 'command',
    name: id,
    command: id,
    cwd: null,
    argv: [],
    status,
    activity,
    ptyProcessId: status === 'running' ? `pty-${id}` : null,
    worktreeId: null,
    autoRestart: false,
    exitedAt: status === 'running' ? null : '2026-01-01T00:01:00.000Z',
    exitCode: null
  };
}

const sessions = [
  // An idle orchestrator whose subagents work, one of them through a subagent of its own.
  session('triage', null, 'idle'),
  session('security', 'triage', 'working'),
  session('release', 'triage', 'thinking'),
  session('hygiene', 'triage', 'idle'),
  session('changelog', 'hygiene', 'working'),
  // A working agent with one subagent at a prompt and one with an error.
  session('lead', null, 'working'),
  session('asking', 'lead', 'permission'),
  session('broken', 'lead', 'error'),
  // An agent at a prompt on its own.
  session('solo', null, 'permission'),
  // An agent whose state couldn't be read, with a subagent in the same state.
  session('unsure', null, 'unknown'),
  session('unsure-child', 'unsure', 'unknown')
];
const byId = new Map(sessions.map((candidate) => [candidate.id, candidate]));
const activityFor = activityLookup(buildAgentTabFamilies(sessions));
const activity = (id: string) => activityFor(byId.get(id)!);

{
  // A tab counts subagents at any depth, and thinking counts as working.
  const triage = activity('triage');
  assert.deepEqual(triage, { self: 'idle', subagents: { working: 3, permission: 0, question: 0, error: 0 } });
  assert.equal(describeActivity(triage), 'Idle, 3 subagents working');
  assert.equal(subagentPulse(triage), 'working');
  assert.equal(subagentCountClass(triage), 'text-muted-foreground');
}

{
  // A subagent's row covers only the agents below it.
  assert.deepEqual(activity('hygiene'), { self: 'idle', subagents: { working: 1, permission: 0, question: 0, error: 0 } });
  assert.equal(describeActivity(activity('hygiene')), 'Idle, 1 subagent working');
  assert.deepEqual(activity('security'), { self: 'working', subagents: { working: 0, permission: 0, question: 0, error: 0 } });
}

{
  // A subagent at a prompt outranks an error, which outranks work.
  const lead = activity('lead');
  assert.deepEqual(lead, { self: 'working', subagents: { working: 0, permission: 1, question: 0, error: 1 } });
  assert.equal(subagentPulse(lead), 'permission');
  assert.equal(subagentCountClass(lead), 'text-warning');
  assert.equal(describeActivity(lead), 'Working, 1 subagent needs permission, 1 subagent has an error');
  assert.equal(activity('broken').self, 'error');
  assert.equal(subagentPulse(activity('broken')), null, 'an agent\'s own error is not a subagent\'s');
}

{
  // The agent's own state stays separate from its subagents'.
  const solo = activity('solo');
  assert.deepEqual(solo, { self: 'permission', subagents: { working: 0, permission: 0, question: 0, error: 0 } });
  assert.equal(describeActivity(solo), 'Needs permission');
  assert.equal(subagentPulse(solo), null);
  assert.equal(subagentCountClass(solo), 'text-muted-foreground');
}

{
  // A question needs you like a permission, and says what it is.
  const asking = activityFor(session('curious', null, 'question'));
  assert.equal(asking.self, 'question');
  assert.equal(describeActivity(asking), 'Has a question');
  assert.equal(countInRing(asking), false, 'the ring shows `?` for a question');
  const lead = buildAgentTabFamilies([session('boss', null, 'working'), session('asker', 'boss', 'question')]);
  const boss = activityLookup(lead)(lead[0]!.root.session);
  assert.equal(subagentPulse(boss), 'question');
  assert.equal(subagentCountClass(boss), 'text-warning');
  assert.equal(describeActivity(boss), 'Working, 1 subagent has a question');
}

{
  // Unknown looks idle, without a spinner or a count, but says it is unknown.
  const unsure = activity('unsure');
  assert.deepEqual(unsure, { self: 'unknown', subagents: { working: 0, permission: 0, question: 0, error: 0 } });
  assert.equal(describeActivity(unsure), 'Unknown');
  assert.equal(subagentPulse(unsure), null);
  assert.equal(describeActivity(processActivity(processRecord('dev', 'running', 'unknown'))), 'Unknown');
}

{
  // Equal activities share one object, so unchanged rows keep the same prop.
  assert.equal(activity('security'), activity('changelog'));
  assert.equal(activityLookup(buildAgentTabFamilies(sessions))(byId.get('triage')!), activity('triage'));
  assert.ok(Object.isFrozen(activity('triage')) && Object.isFrozen(activity('triage').subagents));
}

{
  // An agent outside the families shows only its own state.
  assert.deepEqual(activityFor(session('alone', null, 'thinking')), { self: 'working', subagents: { working: 0, permission: 0, question: 0, error: 0 } });
}

{
  // Only running processes can be busy.
  assert.equal(processActivity(processRecord('dev', 'running', 'working')).self, 'working');
  assert.equal(processActivity(processRecord('dev', 'running', 'idle')).self, 'idle');
  assert.equal(processActivity(processRecord('done', 'exited', 'working')).self, 'idle');
}

{
  // The count sits in the status ring unless the ring shows `?`, `✕` or `✓`.
  const none = { working: 0, permission: 0, question: 0, error: 0 };
  for (const self of ['working', 'idle', 'unknown'] as const) assert.equal(countInRing({ self, subagents: none }), true);
  for (const self of ['permission', 'error', 'closing'] as const) assert.equal(countInRing({ self, subagents: none }), false);
}

{
  // A member count names subagents and processes separately, so owned
  // processes aren't announced as subagents.
  assert.equal(memberLabel(2, 0), '2 subagents');
  assert.equal(memberLabel(1, 1), '1 subagent, 1 process');
  assert.equal(memberLabel(0, 2), '2 processes');
}
