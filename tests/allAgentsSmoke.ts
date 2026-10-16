import assert from 'node:assert/strict';

import {
  buildAllAgentsView,
  groupByProject,
  listedProjects,
  openAgentCount,
  projectShown,
  readAllAgentsState,
  setProjectShown,
  tabsGroupedByProject,
  type AllAgentsState
} from '../resources/js/lib/allAgents';
import type { ProcessRecord, ProjectSummary, ProjectWorkbench, SessionRecord } from '../resources/js/types';

function session(id: string, parentId: string | null = null): SessionRecord {
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
    activity: 'idle',
    lastTitle: id,
    displayName: null,
    model: null,
    reasoning: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    exitedAt: null
  };
}

function processRecord(id: string): ProcessRecord {
  return {
    id, parentProcessId: null, kind: 'command', name: id, command: id, cwd: null, argv: [], status: 'running',
    activity: 'idle', ptyProcessId: `pty-${id}`, worktreeId: null, autoRestart: false, exitedAt: null, exitCode: null
  };
}

function workbench(id: string, sessions: SessionRecord[], processes: ProcessRecord[] = [], kind?: ProjectSummary['kind']): ProjectWorkbench {
  return { project: { id, name: id, path: `/repos/${id}`, ...(kind ? { kind } : {}) }, projectSessions: sessions, processes, worktrees: [], timers: [] };
}

const web = workbench('web', [session('checkout'), session('reviewer', 'checkout')], [processRecord('dev-server')]);
const docs = workbench('docs', [session('guide')]);
const helper = workbench('assistant', [session('assistant-agent')], [], 'assistant');
const projects = [web, docs, helper];

// The assistant's own project never lists; every other project does.
assert.deepEqual(listedProjects(projects).map((item) => item.project.id), ['web', 'docs']);
assert.equal(openAgentCount(web), 2);

// Shown projects contribute their records; hidden ones still name their owners.
const all = buildAllAgentsView(projects, []);
assert.deepEqual(all.sessions.map((item) => item.id), ['checkout', 'reviewer', 'guide']);
assert.deepEqual(all.processes.map((item) => item.id), ['dev-server']);
assert.equal(all.owners.get('reviewer')?.id, 'web');
assert.equal(all.owners.get('dev-server')?.id, 'web');
assert.equal(all.owners.get('assistant-agent'), undefined);

const withoutWeb = buildAllAgentsView(projects, ['web']);
assert.deepEqual(withoutWeb.sessions.map((item) => item.id), ['guide']);
assert.deepEqual(withoutWeb.processes, []);
assert.equal(withoutWeb.owners.get('checkout')?.id, 'web');

// Toggling a project twice, or showing a shown one, leaves one entry at most.
const state: AllAgentsState = { active: true, hidden: [] };
setProjectShown(state, 'web', false);
setProjectShown(state, 'web', false);
assert.deepEqual(state.hidden, ['web']);
assert.equal(projectShown(state, 'web'), false);
setProjectShown(state, 'web', true);
setProjectShown(state, 'docs', true);
assert.deepEqual(state.hidden, []);

// Grouping follows the project list and keeps each project's own order;
// projects without items drop out.
const items = ['guide', 'reviewer', 'checkout', 'stray'];
const grouped = groupByProject(items, listedProjects(projects).map((item) => item.project), (id) => all.owners.get(id) ?? null);
assert.deepEqual(grouped.map((group) => [group.project.id, group.items]), [['web', ['reviewer', 'checkout']], ['docs', ['guide']]]);
assert.deepEqual(groupByProject(['guide'], [web.project, docs.project], (id) => all.owners.get(id) ?? null).map((group) => group.project.id), ['docs']);

// Pinned tabs stay first in their own order; the rest gather by project.
const tabs = [{ id: 'guide', pinned: false }, { id: 'checkout', pinned: true }, { id: 'reviewer', pinned: false }, { id: 'dev-server', pinned: false }];
assert.deepEqual(tabsGroupedByProject(tabs, [web.project, docs.project], (tab) => all.owners.get(tab.id) ?? null).map((tab) => tab.id), ['checkout', 'reviewer', 'dev-server', 'guide']);

// Stored state survives bad input.
const storage = (value: string | null) => ({ getItem: () => value });
assert.deepEqual(readAllAgentsState(storage(JSON.stringify({ active: true, hidden: ['web', 3] }))), { active: true, hidden: ['web'] });
assert.deepEqual(readAllAgentsState(storage('not json')), { active: false, hidden: [] });
assert.deepEqual(readAllAgentsState(storage(null)), { active: false, hidden: [] });

console.log('all agents smoke passed');
