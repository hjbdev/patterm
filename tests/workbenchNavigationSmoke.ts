import assert from 'node:assert/strict';
import { lastProjectLocation, rememberProjectLocation, resolveProjectReturnPath } from '../resources/js/lib/projectLocations';
import type { ProjectWorkbench } from '../resources/js/types';

const projects: ProjectWorkbench[] = [{
  project: { id: 'project-a', name: 'Example', path: '/server/example' },
  projectSessions: [], processes: [], worktrees: [], timers: []
}];
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
