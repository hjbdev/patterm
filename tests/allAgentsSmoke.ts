import assert from 'node:assert/strict';

import {
  buildAllAgentsView,
  groupByProject,
  listedProjects,
  openAgentCount,
  projectShown,
  readAllAgentsState,
  chosenLaunchTarget,
  launchTargets,
  setProjectShown,
  tabsGroupedByProject,
  groupEntriesByProject,
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

// Tabs gather by project, each project's in their own order.
const tabs = [{ id: 'guide' }, { id: 'checkout' }, { id: 'reviewer' }, { id: 'dev-server' }];
assert.deepEqual(tabsGroupedByProject(tabs, [web.project, docs.project], (tab) => all.owners.get(tab.id) ?? null).map((tab) => tab.id), ['checkout', 'reviewer', 'dev-server', 'guide']);

// Folders group with their first tab's project; an empty one with the row
// after it. Each project keeps its own order of rows and folders.
{
  const tab = (id: string) => ({ kind: 'tab' as const, key: id, tab: { key: id, id } as never });
  const folder = (id: string, tabs: string[]) => ({ kind: 'folder' as const, key: `folder:${id}`, folder: { id, name: id }, tabs: tabs.map((each) => ({ key: each, id: each }) as never) });
  const owner = (item: { id: string }) => all.owners.get(item.id) ?? null;
  const grouped = groupEntriesByProject([tab('guide'), folder('retros', ['checkout']), tab('reviewer'), folder('empty', []), tab('dev-server')], [web.project, docs.project], owner as never);
  assert.deepEqual(grouped.map((group) => [group.project.id, group.items.map((entry) => entry.key)]), [
    ['web', ['folder:retros', 'reviewer', 'folder:empty', 'dev-server']],
    ['docs', ['guide']]
  ]);
}

// Stored state survives bad input.
const storage = (value: string | null) => ({ getItem: () => value });
assert.deepEqual(readAllAgentsState(storage(JSON.stringify({ active: true, hidden: ['web', 3] }))), { active: true, hidden: ['web'] });
assert.deepEqual(readAllAgentsState(storage('not json')), { active: false, hidden: [] });
assert.deepEqual(readAllAgentsState(storage(null)), { active: false, hidden: [] });

// Launching from All agents offers each shown project and its paired hosts.
const linked: ProjectWorkbench = { ...web, project: { ...web.project, remotes: [{ host: 'gpu', projectId: 'gpu:web' }] } };
const remoteOnly: ProjectWorkbench = { ...docs, project: { ...docs.project, id: 'gpu:docs', host: 'gpu' } };
const targets = launchTargets([linked, remoteOnly, helper, docs], { active: true, hidden: ['docs'] });
assert.deepEqual(targets.map((target) => [target.projectId, target.targetProjectId, target.host]), [['web', 'web', null], ['web', 'gpu:web', 'gpu'], ['gpu:docs', 'gpu:docs', 'gpu']]);
// The launch menu starts in the chosen target. Choosing among shown projects
// never falls back to a hidden one; a single project not yet listed still
// launches in place.
assert.equal(chosenLaunchTarget(targets, 'gpu:web', 'web', true)?.host, 'gpu');
assert.equal(chosenLaunchTarget([], 'web', 'web', true), null);
assert.equal(chosenLaunchTarget(targets, 'docs', 'docs', true), null);
assert.deepEqual(chosenLaunchTarget([], 'web', 'web', false), { projectId: 'web', targetProjectId: 'web', host: null });

console.log('all agents smoke passed');
