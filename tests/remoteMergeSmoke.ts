import assert from 'node:assert/strict';
import { z } from 'zod';

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

// History changes travel between hosts, readable by hosts of every version.
async function sharedTopics(): Promise<void> {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const emitted: Array<{ host: string; event: string; payload: unknown }> = [];
  let onEvent: (event: { host_id: string; event: string; payload: unknown }) => void = () => {};
  let onConnected: (hostId: string) => void = () => {};
  const connected = new Set([peer.host_id]);
  const linkedPeers = {
    handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
    onConnected: (listener: typeof onConnected) => { onConnected = listener; },
    onDisconnected() {},
    onEvent: (listener: typeof onEvent) => { onEvent = listener; },
    emit: (host: string, event: string, payload: unknown) => emitted.push({ host, event, payload }),
    request: async () => [project('project_linked', 'workspace')],
    connected: (hostId: string) => connected.has(hostId)
  } as unknown as PeerLinkService;
  const notified: string[][] = [];
  const linked = new RemoteClientService(hosts, linkedPeers, { localProjectFor: () => 'project_here' } as unknown as ProjectLinkService, {
    localWorkbench: () => ({ projects: [project('project_here', 'workspace')] }),
    terminal: { onFrame() {} },
    invalidate() {},
    notifyRemoteTopics: (topics: string[]) => notified.push(topics)
  } as unknown as ConstructorParameters<typeof RemoteClientService>[3]);

  linked.localTopicsChanged(['context', 'history', 'settings']);
  assert.deepEqual(emitted.map((item) => item.payload), [{ topics: ['context'] }, { topics: ['history'] }], 'each shared topic goes in its own event, and unshared ones stay here');
  const olderHost = z.array(z.enum(['context']));
  assert.deepEqual(emitted.map((item) => olderHost.safeParse((item.payload as { topics: unknown }).topics).success), [true, false], 'a host that knows only context still reads the context event');

  onEvent({ host_id: peer.host_id, event: 'data.changed', payload: { topics: ['history'] } });
  onEvent({ host_id: peer.host_id, event: 'data.changed', payload: { topics: ['history', 'routines'] } });
  assert.deepEqual(notified, [['history']], 'a paired host\'s history change reaches clients here; unknown topics are refused');
  onConnected(peer.host_id);
  assert.deepEqual(notified.at(-1), ['history'], 'a host connecting counts as a history change, since announcements were missed');

  const served = await handlers.get('workbench.read')!() as ProjectWorkbenchDto[];
  assert.deepEqual(served.map((item) => item.project.sharesHistory), [true], 'projects sent to a paired host say this host announces history');
  await new Promise((resolve) => setTimeout(resolve, 0));
  workbenchesOf(linked).set(peer.host_id, [{ ...project('project_linked', 'workspace'), project: { ...project('project_linked', 'workspace').project, sharesHistory: true } }]);
  const here = { projects: [project('project_here', 'workspace')], harnesses: [], sidebarState: {} } as unknown as Parameters<RemoteClientService['merge']>[0];
  assert.deepEqual(linked.merge(here).projects[0]!.project.remotes, [{ host: 'workstation', projectId: 'workstation:project_linked', sharesHistory: true }]);
  workbenchesOf(linked).set(peer.host_id, [project('project_linked', 'workspace')]);
  assert.deepEqual(linked.merge(here).projects[0]!.project.remotes, [{ host: 'workstation', projectId: 'workstation:project_linked' }], 'an older host sends no flag');
  connected.delete(peer.host_id);
  assert.equal(linked.merge(here).projects[0]!.project.remotes, undefined, 'a disconnected host is not listed');
  connected.add(peer.host_id);
  peer.show_agents = false;
  assert.equal(linked.merge(here).projects[0]!.project.remotes, undefined, 'nor is a host whose agents are hidden');
  peer.show_agents = true;
  linked.dispose();
}

function workbenchesOf(service: RemoteClientService): Map<string, ProjectWorkbenchDto[]> {
  return (service as unknown as { workbenches: Map<string, ProjectWorkbenchDto[]> }).workbenches;
}

void sharedTopics().then(() => console.log('remote merge smoke passed'), (error: unknown) => { console.error(error); process.exitCode = 1; });
