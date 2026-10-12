import assert from 'node:assert/strict';

import { agentStatusText, displayPath, projectOverviews } from '../resources/js/lib/projectOverview';
import type { ActivityState, ProjectWorkbench, SessionRecord } from '../resources/js/types';

function session(id: string, fields: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    parentId: null,
    ptyProcessId: `pty-${id}`,
    processId: `process-${id}`,
    worktreeId: null,
    harness: 'claude',
    interfaceMode: 'tui',
    sessionRole: fields.parentId ? 'child' : 'orchestrator',
    resumeStatus: 'unknown',
    activity: 'idle' as ActivityState,
    lastTitle: id,
    displayName: null,
    model: null,
    reasoning: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    exitedAt: null,
    ...fields
  };
}

function project(id: string, projectSessions: SessionRecord[]): ProjectWorkbench {
  return { project: { id, name: id, path: `/home/someone/Dev/${id}` }, projectSessions, processes: [], worktrees: [], timers: [] };
}

const quiet = project('quiet', []);
const recent = project('recent', [session('ended', { exitedAt: '2026-01-01T05:00:00.000Z' })]);
const busy = project('busy', [
  session('root', { activity: 'working', summary: { text: 'Refactoring the parser.', generatedAt: '2026-01-01T00:10:00.000Z', provider: 'claude', model: 'haiku' } }),
  session('child', { parentId: 'root', activity: 'permission', lastTitle: 'Reviewer' }),
  session('worker', { activity: 'working' }),
  session('waiting', { activity: 'idle' })
]);

const overviews = projectOverviews([quiet, recent, busy]);
assert.deepEqual(overviews.map((overview) => overview.project.id), ['busy', 'recent', 'quiet'], 'projects with live agents come first, then the most recently active');

const personal: ProjectWorkbench = { ...project('personal', []), project: { id: 'personal', name: 'Personal', path: '/data/personal', kind: 'personal' } };
assert.equal(projectOverviews([busy, recent, personal])[0]?.project.id, 'personal', 'the Personal project stays first, even when idle');

const [busyOverview, recentOverview, quietOverview] = overviews;
assert.equal(busyOverview?.agents.length, 3, 'subagents nest under their root');
assert.deepEqual([busyOverview?.waiting, busyOverview?.working, busyOverview?.idle], [1, 1, 1], 'families count once, by their most urgent state');

const root = busyOverview?.agents.find((agent) => agent.session.id === 'root');
assert.equal(root?.state, 'waiting', 'a subagent at a prompt makes its family wait');
assert.equal(root?.waiting?.id, 'child');
assert.deepEqual(root?.subagents.map((member) => member.id), ['child']);
assert.equal(agentStatusText(root!), 'Reviewer needs permission', 'the waiting subagent replaces the summary');

const worker = busyOverview?.agents.find((agent) => agent.session.id === 'worker');
assert.equal(agentStatusText(worker!), '', 'agents without a summary show no status text');

assert.equal(recentOverview?.agents.length, 0, 'ended agents are not listed');
assert.equal(recentOverview?.lastActiveAt, '2026-01-01T05:00:00.000Z', 'ended agents still date the project');
assert.equal(quietOverview?.lastActiveAt, null);

assert.equal(displayPath('/home/someone/Dev/project'), '~/Dev/project');
assert.equal(displayPath('/Users/someone'), '~');
assert.equal(displayPath('/srv/project'), '/srv/project');
assert.equal(displayPath('C:\\Users\\someone\\Dev\\project'), '~\\Dev\\project', 'a Windows home abbreviates');
assert.equal(displayPath('D:/Users/someone'), '~', 'a forward-slash Windows path abbreviates too');
assert.equal(displayPath('C:\\Users\\someone2'), '~', 'any user directory under C:\\Users is a home');
assert.equal(displayPath('C:\\Users'), 'C:\\Users');
assert.equal(displayPath('C:\\work\\project'), 'C:\\work\\project');
