import assert from 'node:assert/strict';

import type { ProjectWorkbenchDto } from '../app/Repositories/WorkbenchRepository';
import type { HostService, PeerHost } from '../app/Services/HostService';
import type { PeerLinkService } from '../app/Services/PeerLinkService';
import type { ProjectLinkService } from '../app/Services/ProjectLinkService';
import { RemoteClientService } from '../app/Services/RemoteClientService';

// Another host's Personal project never links, so it shows on its own, with
// the Personal projects ahead of repositories.
const peer = { host_id: 'host_peer', name: 'workstation', show_agents: true } as PeerHost;
const hosts = { peers: () => [peer], peer: () => peer, identity: () => ({ name: 'devbox' }) } as unknown as HostService;
const peers = { handle() {}, onConnected() {}, onDisconnected() {}, onEvent() {}, connected: () => true } as unknown as PeerLinkService;
const links = { localProjectFor: () => null } as unknown as ProjectLinkService;
const remote = new RemoteClientService(hosts, peers, links, { localWorkbench: () => ({ projects: [] }), terminal: { onFrame() {} } } as unknown as ConstructorParameters<typeof RemoteClientService>[3]);

function project(id: string, kind: 'workspace' | 'personal'): ProjectWorkbenchDto {
  return { project: { id, name: id, path: `/${id}`, logo: null, kind }, projectSessions: [], processes: [], worktrees: [], timers: [] };
}

const workbenches = (remote as unknown as { workbenches: Map<string, ProjectWorkbenchDto[]> }).workbenches;
workbenches.set(peer.host_id, [project('project_personal', 'personal'), project('project_other', 'workspace')]);
const snapshot = { projects: [project('project_personal', 'personal'), project('project_repo', 'workspace')], harnesses: [], sidebarState: {} } as unknown as Parameters<RemoteClientService['merge']>[0];

assert.deepEqual(remote.merge(snapshot).projects.map((item) => item.project.id),
  ['project_personal', 'workstation:project_personal', 'project_repo', 'workstation:project_other']);
assert.deepEqual(remote.merge({ ...snapshot, projects: [project('project_repo', 'workspace')] }).projects.map((item) => item.project.id),
  ['workstation:project_personal', 'project_repo', 'workstation:project_other'], 'with Personal hidden here, the other host’s still leads');

remote.dispose();
console.log('remote merge smoke passed');
