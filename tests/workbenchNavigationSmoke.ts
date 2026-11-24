import assert from 'node:assert/strict';
import { firstDisplayedTabRoute, lastProjectLocation, projectFirstTab, rememberProjectLocation, resolveProjectReturnPath } from '../resources/js/lib/projectLocations';
import { buildAgentTabFamilies } from '../resources/js/lib/agentTabs';
import { activeProcesses } from '../resources/js/lib/processTabs';
import { buildStripTabs } from '../resources/js/lib/tabStrip';
import { tabSnoozed } from '../resources/js/lib/snooze';
import type { ProjectWorkbench } from '../resources/js/types';

const projects: ProjectWorkbench[] = [{
  project: { id: 'project-a', name: 'Example', path: '/server/example' },
  projectSessions: [], processes: [], worktrees: [], timers: []
}];
const liveProject: ProjectWorkbench = {
  ...projects[0]!,
  projectSessions: [{ id: 'session-a', processId: 'proc-a', exitedAt: null } as ProjectWorkbench['projectSessions'][number]],
  processes: []
};
rememberProjectLocation({ name: 'agent', fullPath: '/projects/project-a/agents/session-a', params: { projectId: 'project-a', sessionId: 'session-a' } });
assert.equal(resolveProjectReturnPath(liveProject, lastProjectLocation('project-a')), '/projects/project-a/agents/session-a', 'switching back restores the last agent');
assert.equal(resolveProjectReturnPath(projects[0]!, lastProjectLocation('project-a')), null, 'an ended agent falls back to the default tab');
rememberProjectLocation({ name: 'project', fullPath: '/projects/project-a', params: { projectId: 'project-a' } });
rememberProjectLocation({ name: 'todos', fullPath: '/projects/project-a/todos', params: { projectId: 'project-a' } });
assert.equal(resolveProjectReturnPath(liveProject, lastProjectLocation('project-a')), '/projects/project-a/todos', 'non-terminal views are restored');

// Opening a project skips hidden snoozed agents and picks the first displayed tab.
const snoozedOldest: ProjectWorkbench = {
  ...projects[0]!,
  projectSessions: [
    { id: 'session-snoozed', processId: 'proc-snoozed', exitedAt: null, snooze: { snoozedAt: '2026-11-24T00:00:00.000Z', reminder: null } } as ProjectWorkbench['projectSessions'][number],
    { id: 'session-awake', processId: 'proc-awake', exitedAt: null } as ProjectWorkbench['projectSessions'][number]
  ],
  processes: [{ id: 'proc-shell', kind: 'command', name: 'shell', status: 'running', ptyProcessId: 'pty-1' } as ProjectWorkbench['processes'][number]]
};
assert.deepEqual(projectFirstTab(snoozedOldest), { name: 'agent', params: { projectId: 'project-a', sessionId: 'session-awake' } }, 'fallback projectFirstTab skips snoozed oldest agent');

const onlySnoozedAndShell: ProjectWorkbench = {
  ...snoozedOldest,
  projectSessions: [snoozedOldest.projectSessions[0]!]
};
assert.deepEqual(projectFirstTab(onlySnoozedAndShell), { name: 'process', params: { projectId: 'project-a', processId: 'proc-shell' } }, 'fallback projectFirstTab picks visible shell over snoozed agent');

const stripTabs = buildStripTabs(
  buildAgentTabFamilies(onlySnoozedAndShell.projectSessions, {}),
  activeProcesses(onlySnoozedAndShell.processes),
  { order: [], folders: [], filed: {} }
);
const displayedWithoutSnoozed = stripTabs.filter((tab) => !tabSnoozed(tab));
assert.deepEqual(firstDisplayedTabRoute('project-a', displayedWithoutSnoozed), { name: 'process', params: { projectId: 'project-a', processId: 'proc-shell' } }, 'displayed-tab redirect picks visible shell when snoozed agents are hidden');
assert.equal(firstDisplayedTabRoute('project-a', []), null, 'displayed-tab redirect stays on empty state when all tabs are hidden');
