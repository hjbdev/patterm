import assert from 'node:assert/strict';

import type { ProjectWorkbenchDto, SessionDto } from '../app/Repositories/WorkbenchRepository';
import type { HostService, PeerHost } from '../app/Services/HostService';
import type { PeerLinkService } from '../app/Services/PeerLinkService';
import type { ProjectLinkService } from '../app/Services/ProjectLinkService';
import { RemoteClientService } from '../app/Services/RemoteClientService';

// A linked project hidden on this host, such as Personal, still shows the
// other host's running agents, and nothing when they are idle.
const peer = { host_id: 'host_peer', name: 'workstation', show_agents: true } as PeerHost;
const hosts = { peers: () => [peer], peer: () => peer, identity: () => ({ name: 'devbox' }) } as unknown as HostService;
const peers = { handle() {}, onConnected() {}, onDisconnected() {}, onEvent() {}, connected: () => true } as unknown as PeerLinkService;
const links = { localProjectFor: () => 'project_personal' } as unknown as ProjectLinkService;
const remote = new RemoteClientService(hosts, peers, links, { localWorkbench: () => ({ projects: [] }), terminal: { onFrame() {} } } as unknown as ConstructorParameters<typeof RemoteClientService>[3]);

function personal(sessions: Array<Partial<SessionDto>>): ProjectWorkbenchDto {
  return {
    project: { id: 'project_personal', name: 'Personal', path: '/data/personal', logo: null, kind: 'personal' },
    projectSessions: sessions.map((session, index) => ({ id: `session_${index}`, parentId: null, processId: `process_${index}`, ptyProcessId: null, worktreeId: null, exitedAt: null, ...session }) as SessionDto),
    processes: [], worktrees: [], timers: []
  };
}

const workbenches = (remote as unknown as { workbenches: Map<string, ProjectWorkbenchDto[]> }).workbenches;
const hiddenHere = { projects: [], harnesses: [], sidebarState: {} } as unknown as Parameters<RemoteClientService['merge']>[0];

workbenches.set(peer.host_id, [personal([{}])]);
const running = remote.merge(hiddenHere).projects;
assert.deepEqual(running.map((project) => project.project.id), ['workstation:project_personal'], 'the peer’s running agent stays visible');
assert.equal(running[0]?.projectSessions[0]?.id, 'workstation:session_0');

workbenches.set(peer.host_id, [personal([{ exitedAt: '2026-10-12T00:00:00.000Z' }])]);
assert.deepEqual(remote.merge(hiddenHere).projects, [], 'an idle linked project stays hidden');

// Restored next to a local repository, it is still listed first.
const repository = { project: { id: 'project_repo', name: 'repo', path: '/repo', logo: null, kind: 'workspace' }, projectSessions: [], processes: [], worktrees: [], timers: [] } as ProjectWorkbenchDto;
workbenches.set(peer.host_id, [personal([{}])]);
assert.deepEqual(remote.merge({ ...hiddenHere, projects: [repository] }).projects.map((project) => project.project.id), ['workstation:project_personal', 'project_repo']);

remote.dispose();
console.log('remote merge smoke passed');
