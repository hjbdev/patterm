import assert from 'node:assert/strict';
import { z } from 'zod';

import type { ProjectWorkbenchDto } from '../app/Repositories/WorkbenchRepository';
import type { HostService, PeerHost } from '../app/Services/HostService';
import type { PeerLinkService } from '../app/Services/PeerLinkService';
import type { ProjectLinkService } from '../app/Services/ProjectLinkService';
import type { NotificationChange, NotificationRecord, NotificationUnread } from '../app/Services/NotificationService';
import { RemoteClientService } from '../app/Services/RemoteClientService';
import { defaultAssistantBot } from '../app/Bots/BotSettings';
import { botHidden, botRows } from '../resources/js/lib/bots';
import type { ProjectWorkbench } from '../resources/js/types';

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
  // The bot's helper, waiting on the user in a linked project.
  const linkedProject: ProjectWorkbenchDto = {
    ...project('project_linked', 'workspace'),
    projectSessions: [{ id: 'session_worker', parentId: null, parentProcessId: 'process_helper', processId: 'process_worker', ptyProcessId: null, worktreeId: null, activity: 'question', asking: 'Which branch?', startedAt: '2026-11-02T00:00:00Z' } as unknown as ProjectWorkbenchDto['projectSessions'][number]]
  };
  const botPeers = {
    handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
    onConnected: (listener: typeof onConnected) => { onConnected = listener; },
    onDisconnected() {},
    onEvent() {},
    emit() {},
    request: async (_host: string, method: string, params: unknown) => {
      requests.push({ method, params });
      if (method === 'workbench.read') return [linkedProject, ...(olderHost ? [] : [botsProject])];
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

  // A local bot whose process ID is the same as the paired host's bot's.
  const localBots = { ...project('project_local_bots', 'workspace'), project: { ...project('project_local_bots', 'workspace').project, kind: 'bots' as const },
    projectSessions: [{ id: 'session_mine', parentId: null, processId: 'process_helper', botId: 'mine', startedAt: '2026-11-02T00:00:00Z' }] } as unknown as ProjectWorkbenchDto;
  const all = service.merge({ ...here, projects: [project('project_here', 'workspace'), localBots] }).projects as unknown as ProjectWorkbench[];
  const userProjects = all.filter((item) => item.project.kind !== 'bots');
  const ownProjects = all.filter((item) => item.project.kind === 'bots');
  assert.equal(all.find((item) => item.project.id === 'project_here')?.projectSessions[0]?.parentProcessId, 'workstation:process_helper', 'a helper names its parent on its own host');
  assert.ok(botHidden(userProjects, ownProjects).sessions.has('workstation:session_worker'), 'the paired bot\'s helper stays out of agent lists');
  const rows = botRows({ bots: [{ ...helper, id: 'mine' }, listed!], userName: null }, userProjects, ownProjects);
  assert.equal(rows.find((row) => row.bot.id === 'workstation:helper')?.waitingHelper?.id, 'workstation:session_worker', 'its waiting helper surfaces on it');
  assert.equal(rows.find((row) => row.bot.id === 'mine')?.waitingHelper, null, 'and not on a local bot with the same process ID');

  assert.equal(service.target({ tool: 'bot_start', arguments: { bot_id: 'workstation:helper' } })?.name, 'workstation', 'starting its bot goes to its host');
  assert.equal(service.target({ tool: 'bot_start', arguments: { bot_id: 'assistant' } }), null, 'this host\'s bots stay here');
  assert.equal(service.target({ tool: 'project_create', arguments: { path: '/srv/app' }, host: 'workstation' })?.name, 'workstation', 'explicit host routes tools without a prefixed ID');
  assert.throws(() => service.target({ tool: 'project_create', arguments: { path: '/srv/app' }, host: 'unknown' }), /No paired host is called unknown/, 'unknown explicit host refuses to fall back locally');
  const relayed = await service.relay(peer, 'patterm:mcp:call', { tool: 'bot_state', arguments: { bot_id: 'workstation:helper' } }) as { bot_id: string; process_id: string };
  assert.deepEqual(requests.at(-1)?.params, { channel: 'patterm:mcp:call', args: { tool: 'bot_state', arguments: { bot_id: 'helper' } } });
  assert.deepEqual(relayed, { bot_id: 'workstation:helper', process_id: 'workstation:process_helper' });
  await service.relay(peer, 'patterm:mcp:call', { tool: 'harness_presets', arguments: {}, host: 'workstation' });
  assert.deepEqual(requests.at(-1)?.params, { channel: 'patterm:mcp:call', args: { tool: 'harness_presets', arguments: {} } }, 'explicit routing host is stripped before relaying to the peer');
  const beforeCreateReads = requests.filter((item) => item.method === 'workbench.read').length;
  await service.relay(peer, 'patterm:mcp:call', { tool: 'project_create', arguments: { path: '/srv/new' }, host: 'workstation' });
  assert.equal(requests.filter((item) => item.method === 'workbench.read').length, beforeCreateReads + 1, 'creating a project on a peer refreshes its workbench before returning');

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

// Notifications stream from paired hosts, merge into unread state and cursor-paginated
// history, rewrite URLs for paired hosts, and route read/resolve back to owning peers.
async function sharedNotifications(): Promise<void> {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const emitted: Array<{ host: string; event: string; payload: unknown }> = [];
  const requests: Array<{ host: string; method: string; params: unknown }> = [];
  const receivedChanges: NotificationChange[] = [];
  let onEvent: (event: { host_id: string; event: string; payload: unknown }) => void = () => {};
  let onConnected: (hostId: string) => void = () => {};
  let onDisconnected: (hostId: string) => void = () => {};
  let peerConnected = true;

  const remoteRecord = (id: string, updatedAt: string, fields: Partial<NotificationRecord> = {}): NotificationRecord => ({
    id,
    project_id: 'project_linked',
    process_id: 'process_9',
    session_id: 'session_9',
    source: 'mcp',
    kind: 'attention',
    urgency: 'high',
    delivery: 'all',
    held: false,
    audience: 'user',
    routed_to_process_id: null,
    title: `Remote ${id}`,
    body: 'Needs review',
    occurrences: 1,
    created_at: updatedAt,
    updated_at: updatedAt,
    read_at: null,
    resolved_at: null,
    url: '/projects/project_linked/agents/session_9',
    project_name: 'Linked Repo',
    process_name: 'Builder',
    ...fields
  });

  let peerUnreadRows: NotificationUnread[] = [
    { process_id: 'process_9', project_id: 'project_linked', count: 2, urgency: 'high', snoozed: false, preview: 'Needs review' }
  ];
  const remoteListItems: NotificationRecord[] = [
    remoteRecord('notification_r2', '2026-11-25T10:00:00.000Z', { url: '/routines?report=run_42', project_id: null, process_id: null, session_id: null }),
    remoteRecord('notification_r1', '2026-11-25T09:00:00.000Z', { url: '/bots/assistant', project_id: 'project_assistant', process_id: 'process_bot', session_id: 'session_bot' })
  ];
  const localListItems: NotificationRecord[] = [
    remoteRecord('notification_l2', '2026-11-25T10:00:00.000Z', { project_id: 'project_here', process_id: 'process_1', session_id: 'session_1', url: '/projects/project_here/agents/session_1', title: 'Local l2' }),
    remoteRecord('notification_l1', '2026-11-25T08:00:00.000Z', { project_id: 'project_here', process_id: 'process_1', session_id: 'session_1', url: '/projects/project_here/agents/session_1', title: 'Local l1' })
  ];

  const filterList = (items: NotificationRecord[], raw: unknown) => {
    const input = (raw ?? {}) as { cursor?: string; limit?: number; project_id?: string; process_id?: string };
    let filtered = items.filter((item) => (!input.project_id || item.project_id === input.project_id) && (!input.process_id || item.process_id === input.process_id));
    if (input.cursor) {
      const split = input.cursor.indexOf('|');
      const updatedAt = input.cursor.slice(0, split);
      const id = input.cursor.slice(split + 1);
      filtered = filtered.filter((item) => item.updated_at < updatedAt || (item.updated_at === updatedAt && item.id < id));
    }
    filtered.sort((a, b) => a.updated_at !== b.updated_at ? (a.updated_at < b.updated_at ? 1 : -1) : (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const limit = input.limit ?? 50;
    const page = filtered.slice(0, limit);
    const last = page.at(-1);
    return { items: page, total: items.length, next_cursor: filtered.length > limit && last ? `${last.updated_at}|${last.id}` : null };
  };

  const notifPeers = {
    handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
    onConnected: (listener: typeof onConnected) => { onConnected = listener; },
    onDisconnected: (listener: typeof onDisconnected) => { onDisconnected = listener; },
    onEvent: (listener: typeof onEvent) => { onEvent = listener; },
    emit: (host: string, event: string, payload: unknown) => emitted.push({ host, event, payload }),
    request: async (host: string, method: string, params: unknown) => {
      requests.push({ host, method, params });
      if (method === 'workbench.read') return [];
      if (method === 'bots.read') return [];
      if (method === 'notifications.state') return { unread: peerUnreadRows };
      if (method === 'notifications.list') return filterList(remoteListItems, params);
      if (method === 'notifications.read' || method === 'notifications.resolve') return { updated: 1 };
      return null;
    },
    connected: () => peerConnected
  } as unknown as PeerLinkService;

  const service = new RemoteClientService(hosts, notifPeers, {
    localProjectFor: (_host: string, id: string) => id === 'project_linked' ? 'project_here' : null,
    links: () => [{ host_id: peer.host_id, project_id: 'project_here', remote_project_id: 'project_linked' }]
  } as unknown as ProjectLinkService, {
    localWorkbench: () => ({ projects: [project('project_here', 'workspace')] }),
    terminal: { onFrame() {} },
    terminalSubscriptions: { release: async () => {} },
    invalidate() {},
    notifyRemoteTopics() {},
    notifications: {
      state: () => ({ unread: [] }),
      list: (raw: unknown) => filterList(localListItems, raw),
      read: () => ({ updated: 1 }),
      resolve: () => ({ updated: 1 }),
      onChange: (change: NotificationChange) => receivedChanges.push(change)
    }
  } as unknown as ConstructorParameters<typeof RemoteClientService>[3]);

  // Peer connects -> unread state refreshes and maps linked project IDs.
  onConnected(peer.host_id);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const mergedUnread = service.mergeUnread([
    { process_id: 'process_1', project_id: 'project_here', count: 1, urgency: 'normal', snoozed: false, preview: 'Hi' }
  ]);
  assert.deepEqual(mergedUnread.map((row) => [row.process_id, row.project_id, row.count]), [
    ['process_1', 'project_here', 1],
    ['workstation:process_9', 'project_here', 2]
  ], 'remote unread rows qualify process IDs and map linked projects');

  // Local change broadcasts to peers; remote-tagged notifications never echo back.
  service.localNotificationChanged({ type: 'raised', notification: localListItems[0]! });
  service.localNotificationChanged({ type: 'raised', notification: { ...localListItems[0]!, host: 'workstation' } });
  assert.equal(emitted.filter((e) => e.event === 'notifications.changed').length, 1, 'remote notifications are never echoed back to peers');

  // Incoming peer notification qualifies IDs, rewrites URLs, and caches for delayed desktop delivery.
  const incoming = remoteRecord('notification_live', '2026-11-25T11:00:00.000Z');
  onEvent({ host_id: peer.host_id, event: 'notifications.changed', payload: { type: 'raised', notification: incoming } });
  const raisedChange = receivedChanges.find((c) => c.type === 'raised');
  assert.ok(raisedChange && raisedChange.type === 'raised');
  assert.equal(raisedChange.notification.id, 'workstation:notification_live');
  assert.equal(raisedChange.notification.host, 'workstation');
  assert.equal(raisedChange.notification.project_id, 'project_here');
  assert.equal(raisedChange.notification.url, '/projects/project_here/agents/workstation%3Asession_9');
  assert.equal(service.notification('workstation:notification_live')?.read_at, null);

  // Remote read marks the cached notification read so delayed desktop delivery cancels it.
  onEvent({ host_id: peer.host_id, event: 'notifications.changed', payload: { type: 'read', ids: ['notification_live'] } });
  assert.ok(service.notification('workstation:notification_live')?.read_at, 'cached notification reflects remote read');

  // Cursor-paginated list merges equal-timestamp local and remote records cleanly with URL rewriting.
  const page1 = await service.listNotifications({ limit: 2, include_resolved: true }, (raw) => filterList(localListItems, raw));
  assert.deepEqual(page1.items.map((item) => item.id), ['workstation:notification_r2', 'notification_l2']);
  assert.equal(page1.items[0]!.url, '/routines?host=workstation&report=run_42', 'routine report URL carries paired host');
  assert.ok(page1.next_cursor);
  const page2 = await service.listNotifications({ limit: 2, include_resolved: true, cursor: page1.next_cursor! }, (raw) => filterList(localListItems, raw));
  assert.deepEqual(page2.items.map((item) => item.id), ['workstation:notification_r1', 'notification_l1'], 'cursor pagination neither skips nor duplicates across hosts');
  assert.equal(page2.items[0]!.url, '/bots/workstation%3Aassistant', 'bot notification URL qualifies bot ID');
  assert.equal(page2.next_cursor, null);

  // Read/resolve route to owning peers and fan out all:true.
  const readMixed = await service.readNotifications({ ids: ['notification_l1', 'workstation:notification_r1'] }, () => ({ updated: 1 }));
  assert.equal(readMixed.updated, 2);
  assert.deepEqual(requests.filter((r) => r.method === 'notifications.read').at(-1), { host: peer.host_id, method: 'notifications.read', params: { ids: ['notification_r1'] } });

  const readAll = await service.readNotifications({ all: true }, () => ({ updated: 2 }));
  assert.equal(readAll.updated, 3);
  assert.deepEqual(requests.filter((r) => r.method === 'notifications.read').at(-1), { host: peer.host_id, method: 'notifications.read', params: { all: true } });

  const resolvedRemote = await service.resolveNotifications({ process_id: 'workstation:process_9' }, () => ({ updated: 0 }));
  assert.equal(resolvedRemote.updated, 1);
  assert.deepEqual(requests.filter((r) => r.method === 'notifications.resolve').at(-1), { host: peer.host_id, method: 'notifications.resolve', params: { process_id: 'process_9' } });

  // Hidden peer contributes no unreads, cached notifications, or list items.
  peer.show_agents = false;
  assert.deepEqual(service.mergeUnread([]), [], 'hidden peer contributes no unread counts');
  assert.equal(service.notification('workstation:notification_live'), null, 'hidden peer cancels delayed desktop lookup');
  const hiddenList = await service.listNotifications({ limit: 10, include_resolved: true }, (raw) => filterList(localListItems, raw));
  assert.deepEqual(hiddenList.items.map((item) => item.id), ['notification_l2', 'notification_l1']);
  peer.show_agents = true;

  // Disconnecting clears peer unreads and cached remote notifications.
  peerConnected = false;
  onDisconnected(peer.host_id);
  assert.deepEqual(service.mergeUnread([]), []);
  assert.equal(service.notification('workstation:notification_live'), null);
  service.dispose();
}

function workbenchesOf(service: RemoteClientService): Map<string, ProjectWorkbenchDto[]> {
  return (service as unknown as { workbenches: Map<string, ProjectWorkbenchDto[]> }).workbenches;
}

void sharedTopics().then(sharedBots).then(sharedNotifications).then(() => console.log('remote merge smoke passed'), (error: unknown) => { console.error(error); process.exitCode = 1; });
