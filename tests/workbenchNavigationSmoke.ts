import assert from 'node:assert/strict';
import { resolveTopBarProjectSelection, resolveWorkbenchScreen } from '../resources/js/lib/workbenchNavigation';
import { resolveWorkbenchSelection } from '../resources/js/lib/workbenchSelection';
import { lastProjectLocation, rememberProjectLocation, resolveProjectReturnPath } from '../resources/js/lib/projectLocations';
import type { ProjectWorkbench } from '../resources/js/types';

const openTerminal = {
  activeProjectId: 'project-a',
  activeTerminalId: 'pty-a',
  pendingExplicitTerminalId: 'pty-a'
};
assert.equal(resolveTopBarProjectSelection(openTerminal, 'project-a'), openTerminal, 'reselecting the project preserves its terminal');
assert.deepEqual(resolveTopBarProjectSelection(openTerminal, 'project-b'), {
  activeProjectId: 'project-b', activeTerminalId: null, pendingExplicitTerminalId: null
}, 'switching projects clears terminal selection');
assert.deepEqual(resolveTopBarProjectSelection(openTerminal, null), {
  ...openTerminal, activeProjectId: null, activeTerminalId: null, pendingExplicitTerminalId: null
}, 'returning to the selector clears terminal selection');

for (const [mode, screen] of [['agents', 'agent-project'], ['processes', 'process-project'], ['worktrees', 'worktrees']] as const) {
  assert.equal(resolveWorkbenchScreen({ activeProjectId: 'project-a', projectViewMode: mode }), screen);
  assert.equal(resolveWorkbenchScreen({ activeProjectId: null, projectViewMode: mode }), 'project-selector');
}

const projects: ProjectWorkbench[] = [{
  project: { id: 'project-a', name: 'Example', path: '/server/example' },
  projectSessions: [], processes: [], worktrees: [], timers: []
}];
assert.deepEqual(resolveWorkbenchSelection(projects, { activeProjectId: 'project-a' }), { activeProjectId: 'project-a' });
assert.deepEqual(resolveWorkbenchSelection(projects, { activeProjectId: 'removed' }), { activeProjectId: null });
assert.deepEqual(resolveWorkbenchSelection(projects, { activeProjectId: null }), { activeProjectId: null }, 'refresh does not select a project automatically');

const liveProject: ProjectWorkbench = {
  ...projects[0]!,
  projectSessions: [{ id: 'session-a', processId: 'proc-a', ptyProcessId: 'pty-a', exitedAt: null } as ProjectWorkbench['projectSessions'][number]],
  processes: []
};
rememberProjectLocation({ name: 'agent', fullPath: '/projects/project-a/agents/session-a', params: { projectId: 'project-a', sessionId: 'session-a' } });
assert.equal(resolveProjectReturnPath(liveProject, lastProjectLocation('project-a')), '/projects/project-a/agents/session-a', 'switching back restores the last agent');
assert.equal(resolveProjectReturnPath(projects[0]!, lastProjectLocation('project-a')), null, 'an ended agent falls back to the default tab');
rememberProjectLocation({ name: 'project', fullPath: '/projects/project-a', params: { projectId: 'project-a' } });
rememberProjectLocation({ name: 'todos', fullPath: '/projects/project-a/todos', params: { projectId: 'project-a' } });
assert.equal(resolveProjectReturnPath(liveProject, lastProjectLocation('project-a')), '/projects/project-a/todos', 'non-terminal views are restored');
