import assert from 'node:assert/strict';
import { z } from 'zod';

import type { ProjectWorkbenchDto } from '../app/Repositories/WorkbenchRepository';
import type { HostService, PeerHost } from '../app/Services/HostService';
import type { PeerLinkService } from '../app/Services/PeerLinkService';
import type { ProjectLinkService } from '../app/Services/ProjectLinkService';
import { RemoteClientService } from '../app/Services/RemoteClientService';
import { defaultAssistantBot } from '../app/Bots/BotSettings';

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

// Each host lists the other's bots, with their sessions and the projects
// they work in as this host knows them. Their settings stay on their host.
async function sharedBots(): Promise<void> {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let onConnected: (hostId: string) => void = () => {};
  let olderHost = false;
  const requests: Array<{ method: string; params: unknown }> = [];
  const helper = { ...defaultAssistantBot(), id: 'helper', name: 'Helper', instructions: 'Private notes', purview: { kind: 'projects' as const, projectIds: ['project_linked', 'project_other'] } };
  const botsProject: ProjectWorkbenchDto = {
    ...project('project_bots', 'workspace'),
    project: { ...project('project_bots', 'workspace').project, kind: 'bots' },
    projectSessions: [{ id: 'session_helper', parentId: null, processId: 'process_helper', ptyProcessId: null, worktreeId: null, botId: 'helper', ownerBotId: null } as unknown as ProjectWorkbenchDto['projectSessions'][number]]
  };
  const botPeers = {
    handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
    onConnected: (listener: typeof onConnected) => { onConnected = listener; },
    onDisconnected() {},
    onEvent() {},
    emit() {},
    request: async (_host: string, method: string, params: unknown) => {
      requests.push({ method, params });
      if (method === 'workbench.read') return [project('project_linked', 'workspace'), ...(olderHost ? [] : [botsProject])];
      if (method === 'bots.read') {
        if (olderHost) throw new Error('Unknown peer method: bots.read');
        return [helper, { ...helper, id: 'broken', avatar: null }];
      }
      return { bot_id: 'helper', process_id: 'process_helper' };
    },
    connected: () => true
  } as unknown as PeerLinkService;
  let botsChanged = 0;
  const service = new RemoteClientService(hosts, botPeers, {
    localProjectFor: (_host: string, id: string) => id === 'project_linked' ? 'project_here' : null,
    links: () => []
  } as unknown as ProjectLinkService, {
    localWorkbench: () => ({ projects: [project('project_here', 'workspace'), botsProject] }),
    localBots: () => [helper, { ...helper, id: 'off', enabled: false }],
    botsChanged: () => { botsChanged++; },
    terminal: { onFrame() {} },
    invalidate() {},
    notifyRemoteTopics() {}
  } as unknown as ConstructorParameters<typeof RemoteClientService>[3]);

  const plain = await handlers.get('workbench.read')!() as ProjectWorkbenchDto[];
  assert.deepEqual(plain.map((item) => item.project.id), ['project_here'], 'an older host, which asks without bots, never sees the bots\' projects');
  const withBots = await handlers.get('workbench.read')!({ bots: true }) as ProjectWorkbenchDto[];
  assert.deepEqual(withBots.map((item) => item.project.id), ['project_here', 'project_bots']);
  const served = await handlers.get('bots.read')!() as Array<{ id: string; instructions: string }>;
  assert.deepEqual(served.map((bot) => [bot.id, bot.instructions]), [['helper', '']], 'turned-off bots and instructions stay here');

  onConnected(peer.host_id);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(requests.find((item) => item.method === 'workbench.read')?.params, { bots: true });
  const [listed, ...rest] = service.remoteBots();
  assert.equal(rest.length, 0, 'a malformed bot is dropped');
  assert.equal(listed!.id, 'workstation:helper');
  assert.equal(listed!.host, 'workstation');
  assert.deepEqual(listed!.purview, { kind: 'projects', projectIds: ['project_here', 'workstation:project_other'] }, 'a linked project is named as this host\'s');
  assert.equal(botsChanged, 1, 'clients read the bots again');

  const here = { projects: [project('project_here', 'workspace')], harnesses: [], sidebarState: {} } as unknown as Parameters<RemoteClientService['merge']>[0];
  const merged = service.merge(here).projects.find((item) => item.project.id === 'workstation:project_bots');
  assert.equal(merged?.project.kind, 'bots');
  assert.equal(merged?.projectSessions[0]?.botId, 'workstation:helper', 'its sessions name the bot as remoteBots lists it');

  assert.equal(service.target({ tool: 'bot_start', arguments: { bot_id: 'workstation:helper' } })?.name, 'workstation', 'starting its bot goes to its host');
  assert.equal(service.target({ tool: 'bot_start', arguments: { bot_id: 'assistant' } }), null, 'this host\'s bots stay here');
  const relayed = await service.relay(peer, 'patterm:mcp:call', { tool: 'bot_state', arguments: { bot_id: 'workstation:helper' } }) as { bot_id: string; process_id: string };
  assert.deepEqual(requests.at(-1)?.params, { channel: 'patterm:mcp:call', args: { tool: 'bot_state', arguments: { bot_id: 'helper' } } });
  assert.deepEqual(relayed, { bot_id: 'workstation:helper', process_id: 'workstation:process_helper' });

  peer.show_agents = false;
  assert.deepEqual(service.remoteBots(), [], 'a host whose agents are hidden lists no bots');
  peer.show_agents = true;

  olderHost = true;
  onConnected(peer.host_id);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(service.remoteBots(), [], 'an older host shares no bots');
  assert.equal(botsChanged, 2);
  assert.ok(service.merge(here).projects.some((item) => item.project.id === 'project_here' && item.project.remotes?.length), 'its projects still show');
  service.dispose();
}

function workbenchesOf(service: RemoteClientService): Map<string, ProjectWorkbenchDto[]> {
  return (service as unknown as { workbenches: Map<string, ProjectWorkbenchDto[]> }).workbenches;
}

void sharedTopics().then(sharedBots).then(() => console.log('remote merge smoke passed'), (error: unknown) => { console.error(error); process.exitCode = 1; });
