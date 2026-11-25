import { z } from 'zod';
import { botInput, type Bot } from '../Bots/BotSettings';
import { listedProject, type ProjectWorkbenchDto, type WorkbenchSnapshotDto } from '../Repositories/WorkbenchRepository';
import type { HostService, PeerHost } from './HostService';
import type { PeerIdentity, PeerLinkService } from './PeerLinkService';
import type { ProjectLinkService } from './ProjectLinkService';
import { renameDamageFrame, type TerminalFrame, type TerminalService } from './TerminalService';
import type { TerminalSubscriptions } from './TerminalSubscriptions';
import type { TimerRecord } from './TimerService';
import type { KeyedPatch, ProjectPatch, WorkbenchChanges, WorkbenchPatch } from './WorkbenchPatch';
import type { WorkbenchRead, WorkbenchSince, WorkbenchSyncService } from './WorkbenchSyncService';
import { CONTROL_OPERATIONS, INTEGRATED_CONTROL_TOOLS } from '../Http/BrowserTools';
import { notificationListInput, notificationReadInput, notificationResolveInput } from '../Actions/NotificationActions';
import type { IntegratedConversationEvent } from './IntegratedConversation';
import type { NotificationChange, NotificationRecord, NotificationUnread } from './NotificationService';
import type { TerminalClientRequest, TerminalClientRequestService } from './TerminalClientRequestService';

// Records from a paired host carry IDs qualified with its name, such as
// `workstation:process_7`, so the UI can show them beside local records and this
// host can relay requests that name them.
const ID_KEYS = new Set([
  'process_id', 'processId', 'session_id', 'sessionId', 'pty_process_id', 'ptyProcessId', 'worktree_id', 'worktreeId',
  'parent_process_id', 'parentProcessId', 'parentId', 'owner_process_id', 'ownerProcessId',
  // Stored transcript images, which a paired host serves by hash.
  'sha256',
  // Project context records, assignees and attachment targets, timers, and
  // imported conversations.
  'todo_id', 'scratchpad_id', 'reference_id', 'target_id', 'assignee_id', 'blocker_id', 'timer_id', 'conversation_id',
  // A paired host's bot, which its UI starts and reads.
  'bot_id'
]);
// A generic `id` field is qualified only when it names a Patterm record, so
// unrelated IDs, such as an Integrated control's, pass through unchanged.
const RECORD_ID = /^(?:todo|scratchpad|reference|worktree|session|process|notification|conversation|timer)_[A-Za-z0-9-]+$/;
const PROJECT_KEYS = new Set(['project_id', 'projectId']);
// Lists of record IDs, such as a todo's assigned sessions or the processes a
// timer watches.
const ID_LIST_KEYS = new Set(['assignments', 'watched']);
// Imported conversations have plain UUIDs, so the `id` of a record listed
// under these keys is a conversation's.
const CONVERSATION_KEYS = new Set(['conversation', 'conversations']);
// The owner as an assignee, the same on every host.
const OWNER_ALIAS = 'user';

// UI requests that may name a paired host's records. Everything else, such
// as settings, is about this host only.
export const RELAY_CHANNELS = new Set([
  'patterm:mcp:call', 'patterm:workbench:record', 'patterm:timers:set',
  'patterm:terminal:input', 'patterm:terminal:resize', 'patterm:terminal:configure', 'patterm:terminal:refresh',
  'patterm:terminal:subscribe', 'patterm:terminal:take-control', 'patterm:terminal:output', 'patterm:terminal:status', 'patterm:terminal:focus',
  'patterm:terminal:stop', 'patterm:terminal:select', 'patterm:terminal:selection-text', 'patterm:terminal:search',
  'patterm:terminal:scroll', 'patterm:terminal:wheel', 'patterm:terminal:mouse'
]);

const MAX_DEPTH = 12;
const RELAY_TIMEOUT_MS = 30_000;
const ANNOUNCE_DELAY_MS = 100;
const REMOTE_NOTIFICATION_CACHE_LIMIT = 200;
// Raw binary peer WebSocket frame header: 'P', 'T', 0x01 (terminal-damage),
// uint16BE processId byte length, UTF-8 processId, raw damage payload.
const BINARY_TERMINAL_MAGIC_0 = 0x50;
const BINARY_TERMINAL_MAGIC_1 = 0x54;
const BINARY_TERMINAL_FRAME_DAMAGE = 0x01;
// Change topics hosts announce to each other.
const SHARED_TOPICS = ['context', 'history'] as const;
type SharedTopic = typeof SHARED_TOPICS[number];

type RemoteWorkbenchRead =
  | { epoch: string; version: number; current: true }
  | { epoch: string; version: number; patches: WorkbenchPatch[] }
  | { epoch: string; version: number; projects: ProjectWorkbenchDto[] };

const rpcRequest = z.object({ channel: z.string().max(100), args: z.unknown().optional() }).strict();
const uploadRequest = z.object({ name: z.string().min(1).max(255), data: z.string().max(15 * 1024 * 1024) }).strict();
const clientRequest = z.object({ kind: z.literal('clipboard'), processId: z.string().min(1).max(200), text: z.string().max(1024 * 1024) });
const conversationRequest = z.object({ process_id: z.string().min(1).max(200), subscribed: z.boolean() }).strict();
const frameEvent = z.object({ process_id: z.string().min(1).max(200), payload: z.string(), frame_kind: z.enum(['snapshot', 'damage']).nullable(), frame_seq: z.number().nullable(), resize_seq: z.number().nullable() });

export type RouteHandler = (raw: unknown) => unknown;

// A paired host's bot as this host lists it: its ID qualified with the
// host's name, and the projects it works in as this host knows them.
export type RemoteBot = Bot & { host: string };
type ConversationListener = (event: IntegratedConversationEvent) => void;
export type NotificationListResult = { items: NotificationRecord[]; total: number; next_cursor: string | null };

export interface RemoteNotificationsOptions {
  state: () => { unread: NotificationUnread[] };
  list: (raw: unknown) => NotificationListResult;
  read: (raw: unknown) => { updated: number };
  resolve: (raw: unknown) => { updated: number };
  onChange: (change: NotificationChange) => void;
}

export interface RemoteClientOptions {
  // This host's own records, without any paired host's.
  localWorkbench: () => WorkbenchSnapshotDto;
  // Optional versioned local workbench sync for incremental paired-host patches.
  localWorkbenchSync?: Pick<WorkbenchSyncService, 'read'>;
  // A paired host's records changed; rebuild the published workbench.
  invalidate: () => void;
  terminal: Pick<TerminalService, 'onFrame' | 'emitRelayedFrame'>;
  terminalSubscriptions: TerminalSubscriptions;
  resolvePty: (processId: string) => string;
  // Integrated agents have no terminal to stream.
  isIntegrated: (processId: string) => boolean;
  subscribeConversation: (processId: string, listener: ConversationListener) => Promise<() => void>;
  // Stores a file a paired host's UI attached for one of this host's agents.
  saveUpload: (name: string, bytes: Buffer) => Promise<string>;
  // A paired host's todos, scratchpads or conversation history changed;
  // refresh those views here without announcing the change back.
  notifyRemoteTopics: (topics: SharedTopic[]) => void;
  // Integrated and MCP tools a paired host may call as the owner.
  allowedTools: ReadonlySet<string>;
  // This host's turned-on bots, which paired hosts list beside their own.
  localBots?: () => Bot[];
  // A paired host's bots changed; clients here read them again.
  botsChanged?: () => void;
  // Local notifications, shared with paired hosts and merged with theirs.
  notifications?: RemoteNotificationsOptions;
}

// Shows paired hosts' records in this host's workbench and relays the UI's
// requests for them. A paired host acts as the owner here: that is what
// pairing two of the owner's machines is for. Agents never reach these
// routes, which only the UI calls.
export class RemoteClientService {
  private readonly workbenches = new Map<string, ProjectWorkbenchDto[]>();
  private readonly peerVersions = new Map<string, { epoch: string; version: number }>();
  private readonly bots = new Map<string, Bot[]>();
  private readonly peerUnreads = new Map<string, NotificationUnread[]>();
  // Recent qualified notifications from paired hosts, so delayed desktop
  // delivery can check whether one is still unread and unresolved.
  private readonly remoteNotifications = new Map<string, { hostId: string; record: NotificationRecord }>();
  private readonly fetchingNotifications = new Map<string, Promise<void>>();
  private readonly refetchNotificationsPending = new Set<string>();
  private readonly resetNotificationsPending = new Set<string>();
  private readonly notificationsGeneration = new Map<string, number>();
  private readonly fetching = new Map<string, Promise<void>>();
  private readonly refetchPending = new Set<string>();
  private readonly peerTerminals = new Map<string, Set<string>>();
  // Processes of this host that a paired host controls, by PTY or Integrated
  // process ID.
  private readonly peerControl = new Map<string, string>();
  private readonly localControlListeners = new Set<(key: string) => void>();
  private readonly controlLostListeners = new Set<(processId: string) => void>();
  private readonly localOwners = new Set<(key: string) => boolean>();
  // Processes of this host the desktop window shows.
  private readonly desktopViewing = new Set<string>();
  private readonly peerConversations = new Map<string, Map<string, () => void>>();
  private readonly conversationListeners = new Map<string, Set<ConversationListener>>();
  private routes = new Map<string, RouteHandler>();
  private clientRequests: Pick<TerminalClientRequestService, 'emit'> | null = null;
  private announceTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly hosts: HostService,
    private readonly peers: PeerLinkService,
    private readonly links: ProjectLinkService,
    private readonly options: RemoteClientOptions
  ) {
    // The flag tells a paired host it may cache this host's history reads:
    // its changes are announced. Older hosts send no flag. The bots' and the
    // assistant's projects go only to a host that asks for them, which lists
    // this host's bots; an older host would mistake them for its own.
    peers.handle('workbench.read', (raw) => {
      const request = raw && typeof raw === 'object' ? raw as { bots?: unknown; since?: unknown } : null;
      const withBots = request?.bots === true;
      if (this.options.localWorkbenchSync && request && 'since' in request) {
        return formatRemoteWorkbenchRead(this.options.localWorkbenchSync, parseWorkbenchSince(request.since), withBots);
      }
      return this.options.localWorkbench().projects
        .filter((project) => withBots || listedProject(project))
        .map(withSharesHistory);
    });
    // Who the bots are and where they work. Their instructions stay here.
    peers.handle('bots.read', () => (this.options.localBots?.() ?? []).filter((bot) => bot.enabled).map((bot) => ({ ...bot, instructions: '' })));
    peers.handle('notifications.state', () => this.options.notifications?.state() ?? { unread: [] });
    peers.handle('notifications.list', (raw) => this.options.notifications?.list(raw) ?? { items: [], total: 0, next_cursor: null });
    peers.handle('notifications.read', (raw) => this.options.notifications?.read(raw) ?? { updated: 0 });
    peers.handle('notifications.resolve', (raw) => this.options.notifications?.resolve(raw) ?? { updated: 0 });
    peers.handle('client.rpc', (raw, peer) => this.serveRequest(raw, peer));
    peers.handle('client.conversation', (raw, peer) => this.serveConversation(raw, peer));
    peers.handle('client.upload', (raw) => {
      const { name, data } = uploadRequest.parse(raw);
      return this.options.saveUpload(name, Buffer.from(data, 'base64'));
    });
    peers.onConnected((hostId) => {
      void this.refresh(hostId);
      void this.refreshNotifications(hostId, true);
      // History announced while the link was down was missed.
      this.options.notifyRemoteTopics(['history']);
    });
    peers.onDisconnected((hostId) => this.dropHost(hostId));
    peers.onBinary?.((hostId, payload) => this.receiveBinaryFrame(hostId, payload));
    peers.onEvent((event) => {
      if (event.event === 'workbench.changed') void this.refresh(event.host_id);
      else if (event.event === 'notifications.changed') this.receiveNotificationChange(event.host_id, event.payload);
      else if (event.event === 'terminal.frame') this.receiveFrame(event.host_id, event.payload);
      else if (event.event === 'terminal.lifecycle') this.receiveLifecycle(event.host_id, event.payload);
      else if (event.event === 'conversation.event') this.receiveConversation(event.host_id, event.payload);
      else if (event.event === 'terminal.client_request') this.receiveClientRequest(event.host_id, event.payload);
      else if (event.event === 'terminal.control') {
        const peer = this.hosts.peer(event.host_id);
        const processId = (event.payload as { process_id?: unknown } | null)?.process_id;
        if (peer && typeof processId === 'string') for (const listener of this.controlLostListeners) listener(`${peer.name}:${processId}`);
      }
      else if (event.event === 'data.changed') {
        const topics = z.array(z.enum(SHARED_TOPICS)).safeParse((event.payload as { topics?: unknown } | null)?.topics);
        if (topics.success && topics.data.length) this.options.notifyRemoteTopics(topics.data);
      }
    });
    options.terminal.onFrame((frame) => this.forwardFrame(frame));
  }

  // Copies and link opens from a terminal a paired host is viewing go to
  // that host, where the person is.
  forwardClientRequests(requests: Pick<TerminalClientRequestService, 'on' | 'emit'>): void {
    this.clientRequests = requests;
    requests.on((request) => {
      if (request.processId.includes(':')) return;
      const pty = this.options.resolvePty(request.processId);
      for (const [hostId, subscribed] of this.peerTerminals) {
        if (subscribed.has(pty)) this.peers.emit(hostId, 'terminal.client_request', { ...request, processId: pty });
      }
    });
  }

  // The routes this host's UI uses, run for a paired host's UI.
  serve(routes: Map<string, RouteHandler>): void {
    this.routes = routes;
  }

  // This host's records changed: paired hosts showing them should refetch.
  localChanged(): void {
    if (this.announceTimer || this.disposed) return;
    this.announceTimer = setTimeout(() => {
      this.announceTimer = null;
      for (const peer of this.hosts.peers()) this.peers.emit(peer.host_id, 'workbench.changed');
    }, ANNOUNCE_DELAY_MS);
    this.announceTimer.unref?.();
  }

  // This host's todos, scratchpads or history changed: tell paired hosts so
  // their views of them refresh. One topic per event: an older host rejects
  // an event naming a topic it doesn't know.
  localTopicsChanged(topics: readonly string[]): void {
    if (this.disposed) return;
    for (const topic of SHARED_TOPICS) {
      if (!topics.includes(topic)) continue;
      for (const peer of this.hosts.peers()) this.peers.emit(peer.host_id, 'data.changed', { topics: [topic] });
    }
  }

  // Forward a local notification change to connected paired hosts. Remote
  // notifications are never echoed back.
  localNotificationChanged(change: NotificationChange): void {
    if (this.disposed) return;
    if ((change.type === 'raised' || change.type === 'updated') && change.notification.host) return;
    for (const peer of this.hosts.peers()) this.peers.emit(peer.host_id, 'notifications.changed', change);
  }

  // Called when peer visibility (show_agents, unpair, project link) changes so
  // badges and open notification lists recalculate immediately.
  notificationsVisibilityChanged(): void {
    if (this.disposed) return;
    this.options.notifications?.onChange({ type: 'reset' });
  }

  // A recently relayed remote notification, for delayed desktop delivery checks.
  notification(id: string): NotificationRecord | null {
    const entry = this.remoteNotifications.get(id);
    if (!entry) return null;
    const peer = this.hosts.peer(entry.hostId);
    if (!peer || !peer.show_agents || !this.peers.connected(peer.host_id) || entry.record.host !== peer.name) return null;
    return entry.record;
  }

  // Merges local unread counts with connected, visible paired hosts' counts.
  mergeUnread(local: NotificationUnread[]): NotificationUnread[] {
    if (this.peerUnreads.size === 0) return local;
    const merged: NotificationUnread[] = [...local];
    for (const peer of this.hosts.peers()) {
      if (!peer.show_agents || !this.peers.connected(peer.host_id)) continue;
      const rows = this.peerUnreads.get(peer.host_id);
      if (!rows?.length) continue;
      for (const row of rows) {
        merged.push({
          ...row,
          process_id: row.process_id ? this.qualifyId(row.process_id, peer) : null,
          project_id: row.project_id ? (this.links.localProjectFor(peer.host_id, row.project_id) ?? `${peer.name}:${row.project_id}`) : null
        });
      }
    }
    return merged;
  }

  // Lists notifications across this host and visible connected peers, merged
  // by newest activity first with stable cursor pagination.
  async listNotifications(
    raw: unknown,
    local: (input: unknown) => NotificationListResult
  ): Promise<NotificationListResult> {
    const input = notificationListInput.parse(raw ?? {});
    const visiblePeers = this.hosts.peers().filter((peer) => peer.show_agents && this.peers.connected(peer.host_id));

    type PeerTarget = { peer: PeerHost; args: Record<string, unknown> };
    let includeLocal = true;
    let peerTargets: PeerTarget[] = [];

    if (input.process_id) {
      const owner = this.splitPeerPrefix(input.process_id);
      if (owner) {
        includeLocal = false;
        if (owner.peer.show_agents && this.peers.connected(owner.peer.host_id)) {
          const remoteProject = input.project_id ? this.unqualifyProjectId(input.project_id, owner.peer) : undefined;
          peerTargets = [{
            peer: owner.peer,
            args: { ...input, process_id: owner.id, ...(remoteProject !== undefined ? { project_id: remoteProject } : {}) }
          }];
        }
      }
    } else if (input.project_id) {
      const owner = this.splitPeerPrefix(input.project_id);
      if (owner) {
        includeLocal = false;
        if (owner.peer.show_agents && this.peers.connected(owner.peer.host_id)) {
          peerTargets = [{ peer: owner.peer, args: { ...input, project_id: owner.id } }];
        }
      } else {
        // A local project may be linked to projects on paired hosts.
        peerTargets = visiblePeers.flatMap((peer) => {
          const link = this.links.links(peer.host_id).find((candidate) => candidate.project_id === input.project_id);
          return link ? [{ peer, args: { ...input, project_id: link.remote_project_id } }] : [];
        });
      }
    } else {
      peerTargets = visiblePeers.map((peer) => ({ peer, args: { ...input } }));
    }

    if (includeLocal && peerTargets.length === 0) return local(input);
    if (!includeLocal && peerTargets.length === 0) return { items: [], total: 0, next_cursor: null };

    const cursor = decodeNotificationCursor(input.cursor);
    const cursorOwner = cursor ? this.splitPeerPrefix(cursor.id) : null;
    const needed = cursor ? input.limit + 1 : input.offset + input.limit + 1;

    // Pages a single host in 200-item chunks when an offset query needs more
    // than one SQLite page, keeping multi-host offset slices lossless.
    const fetchHostPages = async (
      fetchPage: (pageCursor: string | undefined, pageLimit: number) => Promise<NotificationListResult | null>,
      initialCursor: string | undefined
    ): Promise<NotificationListResult | null> => {
      const items: NotificationRecord[] = [];
      let total = 0;
      let pageCursor = initialCursor;
      let lastNextCursor: string | null = null;
      let gotPage = false;
      while (items.length < needed) {
        const batchLimit = Math.min(needed - items.length, 200);
        const page = await fetchPage(pageCursor, batchLimit);
        if (!page) return gotPage ? { items, total, next_cursor: lastNextCursor } : null;
        if (!gotPage) total = page.total;
        gotPage = true;
        items.push(...page.items);
        lastNextCursor = page.next_cursor;
        if (!page.next_cursor || page.items.length === 0) break;
        pageCursor = page.next_cursor;
      }
      return { items, total, next_cursor: lastNextCursor };
    };

    const queries: Array<Promise<NotificationListResult | null>> = [];
    if (includeLocal) {
      // Local IDs are unqualified in both SQLite and the merged list, so
      // SQLite can apply the exact cursor predicate directly.
      const localCursor = cursor ? input.cursor : undefined;
      queries.push(fetchHostPages(async (pageCursor, pageLimit) => local({
        ...input,
        limit: pageLimit,
        offset: 0,
        ...(pageCursor ? { cursor: pageCursor } : { cursor: undefined })
      }), localCursor));
    }
    for (const target of peerTargets) {
      // A non-owner peer's qualified IDs all start with `${peer.name}:`, so
      // every same-timestamp row on that peer compares `< cursor.id` iff
      // `${peer.name}: < cursor.id`; otherwise skip same-timestamp rows with
      // an empty ID bound so older timestamps are never crowded out.
      const peerCursor = cursor
        ? (cursorOwner?.peer.host_id === target.peer.host_id
          ? `${cursor.updatedAt}|${cursorOwner.id}`
          : `${target.peer.name}:` < cursor.id
            ? `${cursor.updatedAt}|~`
            : `${cursor.updatedAt}|`)
        : undefined;
      queries.push(fetchHostPages(async (pageCursor, pageLimit) => {
        const peerArgs = {
          ...target.args,
          limit: pageLimit,
          offset: 0,
          ...(pageCursor ? { cursor: pageCursor } : {})
        };
        if (!pageCursor) delete peerArgs.cursor;
        return this.peers.request(target.peer.host_id, 'notifications.list', peerArgs, RELAY_TIMEOUT_MS)
          .then((response) => {
            if (!response || typeof response !== 'object' || !Array.isArray((response as { items?: unknown }).items)) return null;
            const page = response as NotificationListResult;
            return {
              items: page.items.map((item) => this.qualifyNotification(item, target.peer)),
              total: typeof page.total === 'number' ? page.total : page.items.length,
              next_cursor: typeof page.next_cursor === 'string' ? page.next_cursor : null
            };
          })
          .catch(() => null);
      }, peerCursor));
    }

    const results = await Promise.all(queries);
    const combined: NotificationRecord[] = [];
    let total = 0;
    let anyHostHasMore = false;
    for (const result of results) {
      if (!result) continue;
      total += result.total;
      if (result.next_cursor !== null) anyHostHasMore = true;
      for (const item of result.items) {
        if (cursor && !(item.updated_at < cursor.updatedAt || (item.updated_at === cursor.updatedAt && item.id < cursor.id))) continue;
        combined.push(item);
      }
    }
    combined.sort((left, right) => {
      if (left.updated_at !== right.updated_at) return left.updated_at < right.updated_at ? 1 : -1;
      return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
    });
    const start = cursor ? 0 : input.offset;
    const items = combined.slice(start, start + input.limit);
    const hasMore = combined.length > start + input.limit || (items.length === input.limit && anyHostHasMore);
    const last = items.at(-1);
    return { items, total, next_cursor: hasMore && last ? `${last.updated_at}|${last.id}` : null };
  }

  // Routes mark-read to this host and/or owning paired hosts.
  async readNotifications(
    raw: unknown,
    local: (input: unknown) => { updated: number }
  ): Promise<{ updated: number }> {
    const input = notificationReadInput.parse(raw);
    if (input.all) {
      const visiblePeers = this.hosts.peers().filter((peer) => peer.show_agents && this.peers.connected(peer.host_id));
      const localResult = local(input);
      if (!visiblePeers.length) return localResult;
      const peerIds = [...this.remoteNotifications.entries()]
        .filter(([, entry]) => visiblePeers.some((peer) => peer.host_id === entry.hostId))
        .map(([id]) => id);
      this.markCachedNotifications(peerIds, 'read');
      const peerResults = await Promise.all(visiblePeers.map((peer) =>
        this.peers.request(peer.host_id, 'notifications.read', { all: true }, RELAY_TIMEOUT_MS)
          .then((res) => (res && typeof (res as { updated?: unknown }).updated === 'number' ? (res as { updated: number }).updated : 0))
          .catch(() => 0)
      ));
      for (const peer of visiblePeers) void this.refreshNotifications(peer.host_id);
      return { updated: localResult.updated + peerResults.reduce((sum, count) => sum + count, 0) };
    }

    if (input.process_id || input.session_id) {
      const owner = (input.process_id ? this.splitPeerPrefix(input.process_id) : null)
        ?? (input.session_id ? this.splitPeerPrefix(input.session_id) : null);
      if (owner) {
        const matchingIds = [...this.remoteNotifications.entries()]
          .filter(([, entry]) => entry.hostId === owner.peer.host_id
            && ((input.process_id && entry.record.process_id === input.process_id)
              || (input.session_id && entry.record.session_id === input.session_id)))
          .map(([id]) => id);
        if (matchingIds.length) this.markCachedNotifications(matchingIds, 'read');
        if (!this.peers.connected(owner.peer.host_id)) return { updated: 0 };
        const payload: Record<string, unknown> = {};
        if (input.process_id) payload.process_id = stripHost(input.process_id, owner.peer.name);
        if (input.session_id) payload.session_id = stripHost(input.session_id, owner.peer.name);
        const res = await this.peers.request(owner.peer.host_id, 'notifications.read', payload, RELAY_TIMEOUT_MS)
          .catch(() => ({ updated: 0 })) as { updated?: unknown };
        void this.refreshNotifications(owner.peer.host_id);
        return { updated: typeof res?.updated === 'number' ? res.updated : 0 };
      }
      return local(input);
    }

    if (input.ids?.length) {
      const localIds: string[] = [];
      const byPeer = new Map<PeerHost, string[]>();
      const qualifiedRemoteIds: string[] = [];
      for (const id of input.ids) {
        const owner = this.splitPeerPrefix(id);
        if (owner) {
          qualifiedRemoteIds.push(id);
          let list = byPeer.get(owner.peer);
          if (!list) byPeer.set(owner.peer, list = []);
          list.push(owner.id);
        } else {
          localIds.push(id);
        }
      }
      if (qualifiedRemoteIds.length) this.markCachedNotifications(qualifiedRemoteIds, 'read');
      let updated = localIds.length ? local({ ids: localIds }).updated : 0;
      if (byPeer.size) {
        const counts = await Promise.all([...byPeer.entries()].map(async ([peer, ids]) => {
          if (!this.peers.connected(peer.host_id)) return 0;
          const res = await this.peers.request(peer.host_id, 'notifications.read', { ids }, RELAY_TIMEOUT_MS)
            .catch(() => ({ updated: 0 })) as { updated?: unknown };
          void this.refreshNotifications(peer.host_id);
          return typeof res?.updated === 'number' ? res.updated : 0;
        }));
        updated += counts.reduce((sum, count) => sum + count, 0);
      }
      return { updated };
    }

    return local(input);
  }

  // Routes resolve to this host and/or owning paired hosts.
  async resolveNotifications(
    raw: unknown,
    local: (input: unknown) => { updated: number }
  ): Promise<{ updated: number }> {
    const input = notificationResolveInput.parse(raw);
    if (input.process_id) {
      const owner = this.splitPeerPrefix(input.process_id);
      if (owner) {
        const matchingIds = [...this.remoteNotifications.entries()]
          .filter(([, entry]) => entry.hostId === owner.peer.host_id && entry.record.process_id === input.process_id)
          .map(([id]) => id);
        if (matchingIds.length) this.markCachedNotifications(matchingIds, 'resolved');
        if (!this.peers.connected(owner.peer.host_id)) return { updated: 0 };
        const res = await this.peers.request(owner.peer.host_id, 'notifications.resolve', { process_id: owner.id }, RELAY_TIMEOUT_MS)
          .catch(() => ({ updated: 0 })) as { updated?: unknown };
        void this.refreshNotifications(owner.peer.host_id);
        return { updated: typeof res?.updated === 'number' ? res.updated : 0 };
      }
      return local(input);
    }

    if (input.ids?.length) {
      const localIds: string[] = [];
      const byPeer = new Map<PeerHost, string[]>();
      const qualifiedRemoteIds: string[] = [];
      for (const id of input.ids) {
        const owner = this.splitPeerPrefix(id);
        if (owner) {
          qualifiedRemoteIds.push(id);
          let list = byPeer.get(owner.peer);
          if (!list) byPeer.set(owner.peer, list = []);
          list.push(owner.id);
        } else {
          localIds.push(id);
        }
      }
      if (qualifiedRemoteIds.length) this.markCachedNotifications(qualifiedRemoteIds, 'resolved');
      let updated = localIds.length ? local({ ids: localIds }).updated : 0;
      if (byPeer.size) {
        const counts = await Promise.all([...byPeer.entries()].map(async ([peer, ids]) => {
          if (!this.peers.connected(peer.host_id)) return 0;
          const res = await this.peers.request(peer.host_id, 'notifications.resolve', { ids }, RELAY_TIMEOUT_MS)
            .catch(() => ({ updated: 0 })) as { updated?: unknown };
          void this.refreshNotifications(peer.host_id);
          return typeof res?.updated === 'number' ? res.updated : 0;
        }));
        updated += counts.reduce((sum, count) => sum + count, 0);
      }
      return { updated };
    }

    return local(input);
  }

  dispose(): void {
    this.disposed = true;
    if (this.announceTimer) clearTimeout(this.announceTimer);
    this.announceTimer = null;
  }

  // Adds connected paired hosts' records to this host's snapshot. A linked
  // project gains the other host's agents; another project appears on its
  // own.
  merge(snapshot: WorkbenchSnapshotDto): WorkbenchSnapshotDto {
    if (this.workbenches.size === 0) return snapshot;
    const projects = snapshot.projects.map((project) => ({ ...project }));
    for (const peer of this.hosts.peers()) {
      const remote = this.workbenches.get(peer.host_id);
      if (!remote || !peer.show_agents || !this.peers.connected(peer.host_id)) continue;
      for (const remoteProject of remote) {
        const qualified = this.qualifyProject(remoteProject, peer);
        const localId = this.links.localProjectFor(peer.host_id, remoteProject.project.id);
        const local = localId ? projects.find((project) => project.project.id === localId) : undefined;
        if (local) {
          local.project = { ...local.project, remotes: [...(local.project.remotes ?? []), {
            host: peer.name,
            projectId: qualified.project.id,
            ...(qualified.project.contextRevision === undefined ? {} : { contextRevision: qualified.project.contextRevision }),
            ...(qualified.project.sharesHistory ? { sharesHistory: true } : {})
          }] };
          local.projectSessions = [...local.projectSessions, ...qualified.projectSessions];
          local.processes = [...local.processes, ...qualified.processes];
          local.worktrees = [...local.worktrees, ...qualified.worktrees];
          local.timers = [...local.timers, ...qualified.timers];
        } else if (!localId) {
          // Another host's Personal project goes with the Personal projects,
          // ahead of repositories.
          const firstRepository = projects.findIndex((project) => project.project.kind !== 'personal');
          projects.splice(qualified.project.kind === 'personal' && firstRepository >= 0 ? firstRepository : projects.length, 0, qualified);
        }
      }
    }
    return { ...snapshot, projects };
  }

  // Connected paired hosts' turned-on bots, for the hosts whose agents show.
  remoteBots(): RemoteBot[] {
    const listed: RemoteBot[] = [];
    for (const peer of this.hosts.peers()) {
      const bots = this.bots.get(peer.host_id);
      if (!bots || !peer.show_agents || !this.peers.connected(peer.host_id)) continue;
      for (const bot of bots) {
        const purview = bot.purview.kind === 'projects'
          ? { kind: 'projects' as const, projectIds: bot.purview.projectIds.map((id) => this.links.localProjectFor(peer.host_id, id) ?? `${peer.name}:${id}`) }
          : bot.purview;
        listed.push({ ...bot, id: `${peer.name}:${bot.id}`, purview, host: peer.name });
      }
    }
    return listed;
  }

  // The paired host a request names, if any.
  target(raw: unknown): PeerHost | null {
    const explicitName = raw && typeof raw === 'object'
      && typeof (raw as { tool?: unknown }).tool === 'string'
      && typeof (raw as { host?: unknown }).host === 'string'
      ? (raw as { host: string }).host.trim()
      : '';
    const names = new Set<string>();
    collectPrefixes(raw, names, 0);
    const allPeers = this.hosts.peers();
    const peers = allPeers.filter((peer) => names.has(peer.name));
    if (explicitName) {
      const explicit = allPeers.find((peer) => peer.name === explicitName);
      if (!explicit) throw new Error(`No paired host is called ${explicitName}.`);
      if (peers.some((peer) => peer.host_id !== explicit.host_id)) throw new Error('A request cannot name records on two hosts.');
      return explicit;
    }
    if (peers.length > 1) throw new Error('A request cannot name records on two hosts.');
    return peers[0] ?? null;
  }

  // Runs a UI request on the paired host it names.
  async relay(host: PeerHost, channel: string, raw: unknown): Promise<unknown> {
    if (!RELAY_CHANNELS.has(channel)) throw new Error('That request cannot reach another host.');
    const payload = channel === 'patterm:mcp:call' && raw && typeof raw === 'object' && 'host' in raw
      ? (({ host: _host, ...rest }) => rest)(raw as Record<string, unknown>)
      : raw;
    const args = this.unqualify(payload, host, 0);
    const result = await this.peers.request(host.host_id, 'client.rpc', { channel, args }, RELAY_TIMEOUT_MS);
    if (channel === 'patterm:mcp:call' && payload && typeof payload === 'object' && (payload as { tool?: unknown }).tool === 'project_create') {
      await this.refresh(host.host_id);
      const pending = this.fetching.get(host.host_id);
      if (pending) await pending;
    }
    return this.qualify(result, host, 0);
  }

  // Saves an attachment on the host that runs the agent it is for, so the
  // path the agent receives is on its own machine.
  async upload(host: PeerHost, name: string, bytes: Buffer): Promise<string> {
    return z.string().parse(await this.peers.request(host.host_id, 'client.upload', { name, data: bytes.toString('base64') }, 60_000));
  }

  // Conversation events for a paired host's Integrated agent.
  async subscribeConversation(processId: string, listener: ConversationListener): Promise<() => void> {
    const host = this.target({ process_id: processId });
    if (!host) return this.options.subscribeConversation(processId, listener);
    let listeners = this.conversationListeners.get(processId);
    if (!listeners) {
      this.conversationListeners.set(processId, listeners = new Set());
      try {
        await this.peers.request(host.host_id, 'client.conversation', { process_id: stripHost(processId, host.name), subscribed: true });
      } catch (error) {
        this.conversationListeners.delete(processId);
        throw error;
      }
    }
    listeners.add(listener);
    return () => {
      listeners!.delete(listener);
      if (listeners!.size > 0 || this.conversationListeners.get(processId) !== listeners) return;
      this.conversationListeners.delete(processId);
      void this.peers.request(host.host_id, 'client.conversation', { process_id: stripHost(processId, host.name), subscribed: false }).catch(() => undefined);
    };
  }

  private async refresh(hostId: string): Promise<void> {
    const running = this.fetching.get(hostId);
    if (running) {
      this.refetchPending.add(hostId);
      return running;
    }
    const task = (async () => {
      let workbenchChanged = false;
      try {
        const supportsPatches = this.peers.supportsWorkbenchPatches?.(hostId) === true;
        const knownVersion = supportsPatches ? (this.peerVersions.get(hostId) ?? null) : null;
        const params = supportsPatches ? { bots: true, since: knownVersion } : { bots: true };
        const [workbenchResponse, bots] = await Promise.all([
          this.peers.request(hostId, 'workbench.read', params),
          // An older host has no bots to share.
          this.peers.request(hostId, 'bots.read').catch(() => [])
        ]);
        if (this.peers.connected(hostId)) {
          const applied = this.applyRemoteWorkbench(hostId, workbenchResponse, knownVersion);
          if (applied === 'resync') {
            this.peerVersions.delete(hostId);
            const full = await this.peers.request(hostId, 'workbench.read', { bots: true, since: null });
            if (this.peers.connected(hostId)) {
              workbenchChanged = this.applyRemoteWorkbench(hostId, full, null) === 'changed';
            }
          } else {
            workbenchChanged = applied === 'changed';
          }
          this.setBots(hostId, Array.isArray(bots) ? bots.flatMap((bot) => {
            const parsed = botInput.safeParse(bot);
            return parsed.success ? [parsed.data] : [];
          }) : []);
        }
      } catch {
        // The next change or reconnect fetches again.
      } finally {
        this.fetching.delete(hostId);
      }
      if (workbenchChanged) this.options.invalidate();
      if (this.refetchPending.delete(hostId) && !this.disposed && this.peers.connected(hostId)) {
        void this.refresh(hostId);
      }
    })();
    this.fetching.set(hostId, task);
    return task;
  }

  private applyRemoteWorkbench(
    hostId: string,
    raw: unknown,
    expected: { epoch: string; version: number } | null
  ): 'changed' | 'unchanged' | 'resync' {
    if (Array.isArray(raw)) {
      this.workbenches.set(hostId, raw as ProjectWorkbenchDto[]);
      this.peerVersions.delete(hostId);
      return 'changed';
    }
    if (!raw || typeof raw !== 'object') return 'unchanged';
    const response = raw as Partial<RemoteWorkbenchRead> & { epoch?: unknown; version?: unknown };
    if (typeof response.epoch !== 'string' || typeof response.version !== 'number') return 'unchanged';
    if ('current' in response && response.current === true) {
      if (!this.workbenches.has(hostId)) return 'resync';
      this.peerVersions.set(hostId, { epoch: response.epoch, version: response.version });
      return 'unchanged';
    }
    if ('projects' in response && Array.isArray(response.projects)) {
      this.workbenches.set(hostId, response.projects);
      this.peerVersions.set(hostId, { epoch: response.epoch, version: response.version });
      return 'changed';
    }
    if ('patches' in response && Array.isArray(response.patches)) {
      const base = this.workbenches.get(hostId);
      if (!base || !expected || expected.epoch !== response.epoch) return 'resync';
      let currentVersion = expected.version;
      let projects = base;
      for (const patch of response.patches) {
        if (!patch || patch.epoch !== response.epoch || patch.from !== currentVersion) return 'resync';
        projects = applyRemoteProjectChanges(projects, patch.changes);
        currentVersion = patch.to;
      }
      if (currentVersion !== response.version) return 'resync';
      this.workbenches.set(hostId, projects);
      this.peerVersions.set(hostId, { epoch: response.epoch, version: response.version });
      return 'changed';
    }
    return 'unchanged';
  }

  private setBots(hostId: string, bots: Bot[]): void {
    const previous = this.bots.get(hostId);
    if (bots.length) this.bots.set(hostId, bots);
    else this.bots.delete(hostId);
    if (JSON.stringify(previous ?? []) !== JSON.stringify(bots)) this.options.botsChanged?.();
  }

  private dropHost(hostId: string): void {
    this.workbenches.delete(hostId);
    this.peerVersions.delete(hostId);
    this.refetchPending.delete(hostId);
    this.setBots(hostId, []);
    this.notificationsGeneration.set(hostId, (this.notificationsGeneration.get(hostId) ?? 0) + 1);
    this.refetchNotificationsPending.delete(hostId);
    this.resetNotificationsPending.delete(hostId);
    this.peerUnreads.delete(hostId);
    for (const [id, entry] of [...this.remoteNotifications]) {
      if (entry.hostId === hostId) this.remoteNotifications.delete(id);
    }
    this.options.notifications?.onChange({ type: 'reset' });
    this.options.invalidate();
    const subscriber = `peer:${hostId}`;
    void this.options.terminalSubscriptions.release(subscriber);
    this.peerTerminals.delete(hostId);
    for (const [key, holder] of [...this.peerControl]) if (holder === hostId) this.peerControl.delete(key);
    for (const off of this.peerConversations.get(hostId)?.values() ?? []) off();
    this.peerConversations.delete(hostId);
  }

  // A paired host's UI asks this host to run one of its routes.
  private async serveRequest(raw: unknown, peer: PeerIdentity): Promise<unknown> {
    const { channel, args } = rpcRequest.parse(raw);
    if (!RELAY_CHANNELS.has(channel)) throw new Error('That request cannot reach another host.');
    if (channel === 'patterm:mcp:call') {
      const call = z.object({ tool: z.string(), arguments: z.record(z.string(), z.unknown()).optional() }).passthrough().parse(args);
      if (!this.options.allowedTools.has(call.tool)) throw new Error('This tool is not available to another host.');
      if (INTEGRATED_CONTROL_TOOLS.has(call.tool)) this.requireControl(peer, z.string().min(1).parse(call.arguments?.process_id));
    }
    if (channel === 'patterm:terminal:subscribe') {
      const input = z.object({ process_id: z.string().min(1), subscribed: z.boolean(), take_control: z.boolean().optional() }).passthrough().parse(args);
      const key = this.controlKey(input.process_id);
      // The first viewer of an uncontrolled process controls it, as a browser
      // here would; the desktop app asks for control when it opens one.
      if (input.subscribed && (input.take_control || (!this.peerControl.has(key) && !this.localOwner(key)))) this.grantControl(key, peer.host_id);
      if (!input.subscribed && this.peerControl.get(key) === peer.host_id) this.peerControl.delete(key);
      const controlling = this.peerControl.get(key) === peer.host_id;
      if (this.options.isIntegrated(input.process_id)) return { ok: true, process_id: input.process_id, controlling };
      let subscribed = this.peerTerminals.get(peer.host_id);
      if (!subscribed) this.peerTerminals.set(peer.host_id, subscribed = new Set());
      if (input.subscribed) subscribed.add(key);
      else subscribed.delete(key);
      await this.options.terminalSubscriptions.set(`peer:${peer.host_id}`, key, input.subscribed);
      return { ok: true, process_id: input.process_id, controlling };
    }
    if (channel === 'patterm:terminal:take-control') {
      const { process_id } = z.object({ process_id: z.string().min(1) }).parse(args);
      this.grantControl(this.controlKey(process_id), peer.host_id);
      return { ok: true };
    }
    const operation = channel.replace('patterm:terminal:', '');
    if (channel.startsWith('patterm:terminal:') && CONTROL_OPERATIONS.has(operation)) {
      this.requireControl(peer, z.object({ process_id: z.string().min(1) }).passthrough().parse(args).process_id);
    }
    const route = this.routes.get(channel);
    if (!route) throw new Error('Unknown operation');
    return route(args);
  }

  // Control of a terminal or Integrated agent is decided here, on the host
  // that runs it. A paired host holds it on behalf of its own viewers.
  private requireControl(peer: PeerIdentity, processId: string): void {
    if (this.peerControl.get(this.controlKey(processId)) !== peer.host_id) throw new Error('Take control of this terminal first');
  }

  private controlKey(processId: string): string {
    return this.options.isIntegrated(processId) ? processId : this.options.resolvePty(processId);
  }

  private grantControl(key: string, hostId: string): void {
    const previous = this.peerControl.get(key);
    this.peerControl.set(key, hostId);
    if (previous && previous !== hostId) this.peers.emit(previous, 'terminal.control', { process_id: key, controlling: false });
    for (const listener of this.localControlListeners) listener(key);
  }

  // A viewer on this host took control, so the paired host that held it
  // loses it.
  claimLocal(key: string): void {
    const previous = this.peerControl.get(key);
    if (!previous) return;
    this.peerControl.delete(key);
    this.peers.emit(previous, 'terminal.control', { process_id: key, controlling: false });
  }

  peerControls(key: string): boolean {
    return this.peerControl.has(key);
  }

  // Registers this host's own viewers: whether one controls a process, and
  // what to do when a paired host takes control from them.
  trackLocalControl(owner: (key: string) => boolean, lost: (key: string) => void): void {
    this.localOwners.add(owner);
    this.localControlListeners.add(lost);
  }

  // The desktop window is its machine's only viewer and has no Take control
  // action. It holds the processes it shows, and acting on one takes control
  // back from a paired host, as it does for a paired host's processes.
  desktopRequest(channel: string, raw: unknown): void {
    const args = (raw ?? {}) as { process_id?: unknown; subscribed?: unknown };
    if (channel === 'patterm:terminal:subscribe' && args.subscribed === false && typeof args.process_id === 'string') {
      this.desktopViewing.delete(this.controlKey(args.process_id));
      return;
    }
    const processId = controlledProcess(channel, raw);
    if (!processId) return;
    const key = this.controlKey(processId);
    if (channel === 'patterm:terminal:subscribe') this.desktopViewing.add(key);
    this.claimLocal(key);
  }

  private localOwner(key: string): boolean {
    if (this.desktopViewing.has(key)) return true;
    for (const owner of this.localOwners) if (owner(key)) return true;
    return false;
  }

  // Runs when the owning host gives control of one of its processes, named
  // here by its qualified ID, to another viewer.
  onControlLost(listener: (processId: string) => void): () => void {
    this.controlLostListeners.add(listener);
    return () => this.controlLostListeners.delete(listener);
  }


  private async serveConversation(raw: unknown, peer: PeerIdentity): Promise<unknown> {
    const { process_id, subscribed } = conversationRequest.parse(raw);
    let current = this.peerConversations.get(peer.host_id);
    if (!current) this.peerConversations.set(peer.host_id, current = new Map());
    if (!subscribed) {
      current.get(process_id)?.();
      current.delete(process_id);
      return { ok: true };
    }
    if (!current.has(process_id)) {
      const off = await this.options.subscribeConversation(process_id, (event) => this.peers.emit(peer.host_id, 'conversation.event', { process_id, event }));
      current.set(process_id, off);
    }
    return { ok: true };
  }

  private forwardFrame(frame: TerminalFrame): void {
    if (this.peerTerminals.size === 0 || !frame.processId) return;
    let binaryPacket: Buffer | null = null;
    let base64Payload: string | null = null;
    for (const [hostId, subscribed] of this.peerTerminals) {
      if (!subscribed.has(frame.processId)) continue;
      if (frame.type === 'terminal-damage') {
        if (this.peers.supportsBinary?.(hostId)) {
          binaryPacket ??= encodeBinaryDamageFrame(frame.processId, frame.payload);
          if (binaryPacket) {
            this.peers.emitBinary(hostId, binaryPacket);
            continue;
          }
        }
        base64Payload ??= Buffer.from(frame.payload).toString('base64');
        this.peers.emit(hostId, 'terminal.frame', {
          process_id: frame.processId, payload: base64Payload,
          frame_kind: frame.frameKind, frame_seq: frame.frameSeq, resize_seq: frame.resizeSeq
        });
      } else if (frame.type === 'terminal-lifecycle' && frame.event === 'mouse_mode') {
        this.peers.emit(hostId, 'terminal.lifecycle', frame);
      }
    }
  }

  private receiveBinaryFrame(hostId: string, data: Buffer): void {
    if (data.byteLength < 5 || data[0] !== BINARY_TERMINAL_MAGIC_0 || data[1] !== BINARY_TERMINAL_MAGIC_1 || data[2] !== BINARY_TERMINAL_FRAME_DAMAGE) return;
    const idLen = data.readUInt16BE(3);
    if (idLen === 0 || idLen > 200 || 5 + idLen > data.byteLength) return;
    const peer = this.hosts.peer(hostId);
    if (!peer) return;
    const rawProcessId = data.subarray(5, 5 + idLen).toString('utf8');
    const rawDamage = data.subarray(5 + idLen);
    const processId = `${peer.name}:${rawProcessId}`;
    const payload = renameDamageFrame(rawDamage, processId);
    if (!payload) return;
    const rawKind = rawDamage.readUInt8(2);
    const frameKind = rawKind === 0 ? 'snapshot' : rawKind === 1 ? 'damage' : null;
    const frameSeq = rawDamage.readUInt32LE(3);
    const resizeSeq = rawDamage.readUInt32LE(11);
    this.options.terminal.emitRelayedFrame({
      type: 'terminal-damage', payload, processId,
      frameKind, frameSeq, resizeSeq
    });
  }

  private receiveFrame(hostId: string, raw: unknown): void {
    const peer = this.hosts.peer(hostId);
    const parsed = frameEvent.safeParse(raw);
    if (!peer || !parsed.success) return;
    const processId = `${peer.name}:${parsed.data.process_id}`;
    const payload = renameDamageFrame(Buffer.from(parsed.data.payload, 'base64'), processId);
    if (!payload) return;
    this.options.terminal.emitRelayedFrame({
      type: 'terminal-damage', payload, processId,
      frameKind: parsed.data.frame_kind, frameSeq: parsed.data.frame_seq, resizeSeq: parsed.data.resize_seq
    });
  }

  private receiveLifecycle(hostId: string, raw: unknown): void {
    const peer = this.hosts.peer(hostId);
    if (!peer || !raw || typeof raw !== 'object') return;
    const frame = raw as TerminalFrame;
    if (frame.type !== 'terminal-lifecycle' || typeof frame.processId !== 'string') return;
    this.options.terminal.emitRelayedFrame({ ...frame, processId: `${peer.name}:${frame.processId}` });
  }

  private receiveClientRequest(hostId: string, raw: unknown): void {
    const peer = this.hosts.peer(hostId);
    const parsed = clientRequest.safeParse(raw);
    if (!peer || !parsed.success) return;
    this.clientRequests?.emit({ ...parsed.data, processId: `${peer.name}:${parsed.data.processId}` } as TerminalClientRequest);
  }

  private receiveConversation(hostId: string, raw: unknown): void {
    const peer = this.hosts.peer(hostId);
    const payload = raw as { process_id?: unknown; event?: unknown } | null;
    if (!peer || typeof payload?.process_id !== 'string') return;
    const listeners = this.conversationListeners.get(`${peer.name}:${payload.process_id}`);
    if (!listeners) return;
    const event = this.qualify(payload.event, peer, 0) as IntegratedConversationEvent;
    for (const listener of listeners) listener(event);
  }

  private async refreshNotifications(hostId: string, reset = false): Promise<void> {
    if (!this.options.notifications) return;
    if (reset) this.resetNotificationsPending.add(hostId);
    const running = this.fetchingNotifications.get(hostId);
    if (running) {
      this.refetchNotificationsPending.add(hostId);
      return running;
    }
    const generation = this.notificationsGeneration.get(hostId) ?? 0;
    const shouldReset = this.resetNotificationsPending.delete(hostId);
    const task = (async () => {
      try {
        const response = await this.peers.request(hostId, 'notifications.state').catch(() => null) as { unread?: unknown } | null;
        if (!this.disposed && this.peers.connected(hostId)
          && (this.notificationsGeneration.get(hostId) ?? 0) === generation
          && response && Array.isArray(response.unread)) {
          const next = response.unread as NotificationUnread[];
          const previous = this.peerUnreads.get(hostId) ?? [];
          if (next.length) this.peerUnreads.set(hostId, next);
          else this.peerUnreads.delete(hostId);
          const peer = this.hosts.peer(hostId);
          if (peer?.show_agents) {
            if (shouldReset) this.options.notifications?.onChange({ type: 'reset' });
            else if (JSON.stringify(previous) !== JSON.stringify(next)) this.options.notifications?.onChange({ type: 'counts' });
          }
        }
      } finally {
        this.fetchingNotifications.delete(hostId);
      }
      if (this.refetchNotificationsPending.delete(hostId) && !this.disposed && this.peers.connected(hostId)) {
        void this.refreshNotifications(hostId);
      }
    })();
    this.fetchingNotifications.set(hostId, task);
    return task;
  }

  private receiveNotificationChange(hostId: string, raw: unknown): void {
    if (!this.options.notifications) return;
    const peer = this.hosts.peer(hostId);
    if (!peer || !raw || typeof raw !== 'object') return;
    const change = raw as Partial<NotificationChange>;
    if (change.type === 'raised' || change.type === 'updated') {
      const notification = (change as { notification?: NotificationRecord }).notification;
      if (!notification || typeof notification !== 'object' || typeof notification.id !== 'string') return;
      if (peer.show_agents) {
        const record = this.qualifyNotification(notification, peer);
        this.cacheRemoteNotification(hostId, record);
        this.options.notifications.onChange({ type: change.type, notification: record });
      }
      void this.refreshNotifications(hostId);
    } else if (change.type === 'read' || change.type === 'resolved') {
      const ids = Array.isArray((change as { ids?: unknown }).ids)
        ? (change as { ids: unknown[] }).ids.filter((id): id is string => typeof id === 'string').map((id) => this.qualifyId(id, peer))
        : [];
      if (ids.length) {
        this.markCachedNotifications(ids, change.type);
        if (peer.show_agents) this.options.notifications.onChange({ type: change.type, ids });
      }
      void this.refreshNotifications(hostId);
    } else if (change.type === 'counts') {
      void this.refreshNotifications(hostId);
    }
  }

  private cacheRemoteNotification(hostId: string, record: NotificationRecord): void {
    this.remoteNotifications.delete(record.id);
    this.remoteNotifications.set(record.id, { hostId, record });
    while (this.remoteNotifications.size > REMOTE_NOTIFICATION_CACHE_LIMIT) {
      const oldest = this.remoteNotifications.keys().next().value;
      if (oldest !== undefined) this.remoteNotifications.delete(oldest);
      else break;
    }
  }

  private markCachedNotifications(ids: readonly string[], kind: 'read' | 'resolved'): void {
    const at = new Date().toISOString();
    for (const id of ids) {
      const entry = this.remoteNotifications.get(id);
      if (!entry) continue;
      entry.record = {
        ...entry.record,
        read_at: entry.record.read_at ?? at,
        ...(kind === 'resolved' ? { resolved_at: entry.record.resolved_at ?? at } : {})
      };
    }
  }

  private splitPeerPrefix(value: string): { peer: PeerHost; id: string } | null {
    const separator = value.indexOf(':');
    if (separator <= 0) return null;
    const hostName = value.slice(0, separator);
    const peer = this.hosts.peers().find((candidate) => candidate.name === hostName);
    return peer ? { peer, id: value.slice(separator + 1) } : null;
  }

  private unqualifyProjectId(projectId: string, peer: PeerHost): string {
    if (projectId.startsWith(`${peer.name}:`)) return projectId.slice(peer.name.length + 1);
    const link = this.links.links(peer.host_id).find((candidate) => candidate.project_id === projectId);
    return link ? link.remote_project_id : projectId;
  }

  private qualifyNotification(record: NotificationRecord, peer: PeerHost): NotificationRecord {
    const id = this.qualifyId(record.id, peer);
    const projectId = record.project_id ? (this.links.localProjectFor(peer.host_id, record.project_id) ?? `${peer.name}:${record.project_id}`) : null;
    const processId = record.process_id ? this.qualifyId(record.process_id, peer) : null;
    const sessionId = record.session_id ? this.qualifyId(record.session_id, peer) : null;
    const routedTo = record.routed_to_process_id ? this.qualifyId(record.routed_to_process_id, peer) : null;
    const url = qualifyNotificationUrl(record.url, peer.name, projectId, sessionId, processId);
    return {
      ...record,
      id,
      project_id: projectId,
      process_id: processId,
      session_id: sessionId,
      routed_to_process_id: routedTo,
      url,
      host: peer.name
    };
  }

  private qualifyProject(remote: ProjectWorkbenchDto, peer: PeerHost): ProjectWorkbenchDto {
    const q = (value: string | null) => value === null ? null : this.qualifyId(value, peer);
    return {
      project: { ...remote.project, id: `${peer.name}:${remote.project.id}`, host: peer.name },
      projectSessions: remote.projectSessions.map((session) => ({
        ...session, id: q(session.id)!, parentId: q(session.parentId), processId: q(session.processId),
        worktreeId: q(session.worktreeId), host: peer.name,
        // Bots find their helpers through it, and process IDs collide across hosts.
        ...(session.parentProcessId ? { parentProcessId: q(session.parentProcessId) } : {}),
        // Bot IDs name the host's bots, as remoteBots lists them.
        ...(session.botId ? { botId: `${peer.name}:${session.botId}` } : {}),
        ...(session.ownerBotId ? { ownerBotId: `${peer.name}:${session.ownerBotId}` } : {})
      })),
      processes: remote.processes.map((process) => ({
        ...process, id: q(process.id)!, parentProcessId: q(process.parentProcessId), ptyProcessId: q(process.ptyProcessId),
        worktreeId: q(process.worktreeId), host: peer.name
      })),
      worktrees: remote.worktrees.map((worktree) => ({ ...worktree, id: q(worktree.id)!, host: peer.name })),
      timers: remote.timers.map((timer): TimerRecord => ({
        ...timer, id: q(timer.id)!, ownerProcessId: q(timer.ownerProcessId), watched: timer.watched.map((id) => q(id)!)
      }))
    } as ProjectWorkbenchDto;
  }

  // A paired host's ID as this host knows it. An ID that already names this
  // host is one of this host's own records.
  private qualifyId(value: string, peer: PeerHost): string {
    if (value === OWNER_ALIAS) return value;
    const self = this.hosts.identity().name;
    if (value.startsWith(`${self}:`)) return value.slice(self.length + 1);
    return value.includes(':') ? value : `${peer.name}:${value}`;
  }

  private qualify(value: unknown, peer: PeerHost, depth: number, conversation = false): unknown {
    if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => this.qualify(item, peer, depth + 1, conversation));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && (ID_KEYS.has(key) || (key === 'id' && (conversation || RECORD_ID.test(item))))) out[key] = this.qualifyId(item, peer);
      else if (typeof item === 'string' && (PROJECT_KEYS.has(key) || (key === 'id' && item.startsWith('project_')))) out[key] = this.links.localProjectFor(peer.host_id, item) ?? `${peer.name}:${item}`;
      else if (ID_LIST_KEYS.has(key) && Array.isArray(item)) out[key] = item.map((id) => typeof id === 'string' ? this.qualifyId(id, peer) : id);
      else out[key] = this.qualify(item, peer, depth + 1, CONVERSATION_KEYS.has(key));
    }
    return out;
  }

  // The request as the paired host knows it: its own IDs without the
  // prefix, and a linked project as its own project.
  private unqualify(value: unknown, peer: PeerHost, depth: number): unknown {
    if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => this.unqualify(item, peer, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && PROJECT_KEYS.has(key)) {
        const link = this.links.links(peer.host_id).find((candidate) => candidate.project_id === item);
        out[key] = item.startsWith(`${peer.name}:`) ? item.slice(peer.name.length + 1) : link ? link.remote_project_id : item;
      } else if (typeof item === 'string' && ID_KEYS.has(key)) out[key] = this.unqualifyId(item, peer);
      else if (ID_LIST_KEYS.has(key) && Array.isArray(item)) out[key] = item.map((id) => typeof id === 'string' ? this.unqualifyId(id, peer) : id);
      else out[key] = this.unqualify(item, peer, depth + 1);
    }
    return out;
  }

  // One of this host's IDs as a paired host knows it: its own without the
  // prefix, and this host's qualified with this host's name.
  private unqualifyId(value: string, peer: PeerHost): string {
    if (value === OWNER_ALIAS) return value;
    if (value.startsWith(`${peer.name}:`)) return value.slice(peer.name.length + 1);
    return value.includes(':') ? value : `${this.hosts.identity().name}:${value}`;
  }
}

// The process a UI request acts on in a way that needs control of it:
// opening it, typing or resizing, or an Integrated control tool.
export function controlledProcess(channel: string, raw: unknown): string | undefined {
  const args = (raw ?? {}) as { process_id?: unknown; subscribed?: unknown; tool?: unknown; arguments?: { process_id?: unknown } };
  const processId = channel === 'patterm:mcp:call'
    ? (typeof args.tool === 'string' && INTEGRATED_CONTROL_TOOLS.has(args.tool) ? args.arguments?.process_id : undefined)
    : (CONTROL_OPERATIONS.has(channel.replace('patterm:terminal:', '')) || (channel === 'patterm:terminal:subscribe' && args.subscribed === true) ? args.process_id : undefined);
  return typeof processId === 'string' ? processId : undefined;
}

function stripHost(value: string, name: string): string {
  return value.startsWith(`${name}:`) ? value.slice(name.length + 1) : value;
}

function decodeNotificationCursor(cursor: string | undefined): { updatedAt: string; id: string } | null {
  const split = cursor?.indexOf('|') ?? -1;
  if (!cursor || split < 1) return null;
  return { updatedAt: cursor.slice(0, split), id: cursor.slice(split + 1) };
}

function qualifyNotificationUrl(
  url: string,
  peerName: string,
  projectId: string | null,
  sessionId: string | null,
  processId: string | null
): string {
  let parsed: URL;
  try { parsed = new URL(url, 'http://patterm.local'); } catch { return url; }
  const pathname = parsed.pathname;
  if (pathname === '/routines') {
    const query = new URLSearchParams();
    query.set('host', peerName);
    const report = parsed.searchParams.get('report');
    const run = parsed.searchParams.get('run');
    if (report) query.set('report', report);
    if (run) query.set('run', processId ?? (run.includes(':') ? run : `${peerName}:${run}`));
    return `/routines?${query.toString()}`;
  }
  const botMatch = /^\/bots\/([^/]+)$/.exec(pathname);
  if (botMatch) {
    const botId = decodeURIComponent(botMatch[1]!);
    return `/bots/${encodeURIComponent(botId.includes(':') ? botId : `${peerName}:${botId}`)}`;
  }
  const agentMatch = /^\/projects\/([^/]+)\/agents\/([^/]+)$/.exec(pathname);
  if (agentMatch) {
    const rawProject = decodeURIComponent(agentMatch[1]!);
    const rawSession = decodeURIComponent(agentMatch[2]!);
    return `/projects/${encodeURIComponent(projectId ?? `${peerName}:${rawProject}`)}/agents/${encodeURIComponent(sessionId ?? `${peerName}:${rawSession}`)}`;
  }
  const processMatch = /^\/projects\/([^/]+)\/processes\/([^/]+)$/.exec(pathname);
  if (processMatch) {
    const rawProject = decodeURIComponent(processMatch[1]!);
    const rawProcess = decodeURIComponent(processMatch[2]!);
    return `/projects/${encodeURIComponent(projectId ?? `${peerName}:${rawProject}`)}/processes/${encodeURIComponent(processId ?? `${peerName}:${rawProcess}`)}`;
  }
  const projectMatch = /^\/projects\/([^/]+)$/.exec(pathname);
  if (projectMatch) {
    const rawProject = decodeURIComponent(projectMatch[1]!);
    return `/projects/${encodeURIComponent(projectId ?? `${peerName}:${rawProject}`)}`;
  }
  return url;
}

function collectPrefixes(value: unknown, names: Set<string>, depth: number): void {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && (ID_KEYS.has(key) || PROJECT_KEYS.has(key))) {
      const separator = item.indexOf(':');
      if (separator > 0) names.add(item.slice(0, separator));
    } else {
      collectPrefixes(item, names, depth + 1);
    }
  }
}

function encodeBinaryDamageFrame(processId: string, payload: Uint8Array): Buffer | null {
  const idBytes = Buffer.from(processId, 'utf8');
  if (idBytes.byteLength === 0 || idBytes.byteLength > 0xffff) return null;
  const out = Buffer.allocUnsafe(5 + idBytes.byteLength + payload.byteLength);
  out[0] = BINARY_TERMINAL_MAGIC_0;
  out[1] = BINARY_TERMINAL_MAGIC_1;
  out[2] = BINARY_TERMINAL_FRAME_DAMAGE;
  out.writeUInt16BE(idBytes.byteLength, 3);
  idBytes.copy(out, 5);
  Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(out, 5 + idBytes.byteLength);
  return out;
}

function withSharesHistory(project: ProjectWorkbenchDto): ProjectWorkbenchDto {
  return { ...project, project: { ...project.project, sharesHistory: true } };
}

function parseWorkbenchSince(raw: unknown): WorkbenchSince | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as { epoch?: unknown; version?: unknown };
  if (typeof candidate.epoch !== 'string' || typeof candidate.version !== 'number' || !Number.isInteger(candidate.version)) return null;
  return { epoch: candidate.epoch, version: candidate.version };
}

function formatRemoteWorkbenchRead(
  sync: Pick<WorkbenchSyncService, 'read'>,
  since: WorkbenchSince | null,
  withBots: boolean
): RemoteWorkbenchRead {
  const read: WorkbenchRead = sync.read(since);
  if ('current' in read) {
    return { epoch: read.epoch, version: read.version, current: true };
  }
  if ('patches' in read) {
    let hiddenIds: Set<string> | null = null;
    let listedOrder: string[] | null = null;
    if (!withBots) {
      const current = sync.read(null);
      if ('projects' in current) {
        hiddenIds = new Set(current.projects.filter((entry) => !listedProject(entry)).map((entry) => entry.project.id));
        listedOrder = current.projects.filter(listedProject).map((entry) => entry.project.id);
      }
    }
    let anyChanged = false;
    const patches: WorkbenchPatch[] = read.patches.map((patch) => {
      const filtered = filterRemoteProjectChanges(patch.changes, withBots, hiddenIds, listedOrder);
      if (filtered) anyChanged = true;
      return { epoch: patch.epoch, from: patch.from, to: patch.to, changes: filtered ?? {} };
    });
    if (!anyChanged) return { epoch: read.epoch, version: read.version, current: true };
    return { epoch: read.epoch, version: read.version, patches };
  }
  return {
    epoch: read.epoch,
    version: read.version,
    projects: read.projects.filter((project) => withBots || listedProject(project)).map(withSharesHistory)
  };
}

function filterRemoteProjectChanges(
  changes: WorkbenchChanges,
  withBots: boolean,
  hiddenIds: Set<string> | null,
  listedOrder: string[] | null
): WorkbenchChanges | null {
  const projects = changes.projects;
  if (!projects) return null;
  const remove = projects.remove?.filter((id) => !hiddenIds?.has(id));
  const add = projects.add
    ?.filter(({ item }) => withBots || listedProject(item))
    .map(({ item, after }) => {
      let resolvedAfter = after;
      if (!withBots && resolvedAfter && hiddenIds?.has(resolvedAfter) && listedOrder) {
        const index = listedOrder.indexOf(item.project.id);
        resolvedAfter = index > 0 ? listedOrder[index - 1]! : null;
      }
      return { item: withSharesHistory(item), after: resolvedAfter };
    });
  const change = projects.change
    ?.filter((patch) => {
      if (withBots) return true;
      if (hiddenIds?.has(patch.id)) return false;
      if (patch.project && (patch.project.kind === 'bots' || patch.project.kind === 'assistant')) return false;
      return true;
    })
    .map((patch): ProjectPatch => patch.project ? { ...patch, project: { ...patch.project, sharesHistory: true } } : patch);
  const order = projects.order?.filter((id) => !hiddenIds?.has(id));
  const next: NonNullable<WorkbenchChanges['projects']> = {
    ...(remove?.length ? { remove } : {}),
    ...(add?.length ? { add } : {}),
    ...(change?.length ? { change } : {}),
    ...(order ? { order } : {})
  };
  return Object.keys(next).length ? { projects: next } : null;
}

const REMOTE_PROJECT_LISTS = ['projectSessions', 'processes', 'worktrees', 'timers'] as const;

function applyRemoteKeyed<T>(items: readonly T[], patch: KeyedPatch<T> | undefined, key: (item: T) => string): T[] {
  if (!patch) return items as T[];
  if (patch.replace) return patch.replace;
  const removed = new Set(patch.remove ?? []);
  let next = removed.size ? items.filter((item) => !removed.has(key(item))) : [...items];
  const upserts = patch.upsert ?? [];
  if (upserts.length) {
    const positions = new Map<string, number>();
    for (let index = 0; index < next.length; index++) positions.set(key(next[index]!), index);
    for (let upsertIndex = 0; upsertIndex < upserts.length; upsertIndex++) {
      const { item, after } = upserts[upsertIndex]!;
      const itemKey = key(item);
      const index = positions.get(itemKey);
      if (index === undefined) {
        const afterIndex = after === null ? -1 : (positions.get(after) ?? -1);
        const insertAt = afterIndex + 1;
        if (insertAt === next.length) {
          next.push(item);
          positions.set(itemKey, insertAt);
        } else {
          next.splice(insertAt, 0, item);
          if (upsertIndex + 1 < upserts.length) {
            for (let position = insertAt; position < next.length; position++) positions.set(key(next[position]!), position);
          }
        }
      } else {
        next[index] = item;
      }
    }
  }
  if (patch.order) {
    const byKey = new Map(next.map((item) => [key(item), item]));
    next = patch.order.map((id) => byKey.get(id)).filter((item): item is T => item !== undefined);
  }
  return next;
}

function applyRemoteProjectChanges(current: ProjectWorkbenchDto[], changes: WorkbenchChanges): ProjectWorkbenchDto[] {
  const projectChanges = changes.projects;
  if (!projectChanges) return current;
  const byId = (item: { id: string }) => item.id;
  const byProjectId = (item: ProjectWorkbenchDto) => item.project.id;
  const removed = new Set(projectChanges.remove ?? []);
  const patches = new Map((projectChanges.change ?? []).map((patch) => [patch.id, patch]));
  let projects = current
    .filter((entry) => !removed.has(entry.project.id))
    .map((entry) => {
      const patch = patches.get(entry.project.id);
      if (!patch) return entry;
      const next: ProjectWorkbenchDto = { ...entry, project: patch.project ?? entry.project };
      for (const list of REMOTE_PROJECT_LISTS) {
        (next as unknown as Record<string, unknown>)[list] = applyRemoteKeyed(
          entry[list] as Array<{ id: string }>,
          patch[list] as KeyedPatch<{ id: string }> | undefined,
          byId
        );
      }
      return next;
    });
  for (const { item, after } of projectChanges.add ?? []) {
    const index = after === null ? -1 : projects.findIndex((candidate) => byProjectId(candidate) === after);
    projects.splice(index + 1, 0, item);
  }
  if (projectChanges.order) {
    const byKey = new Map(projects.map((item) => [byProjectId(item), item]));
    projects = projectChanges.order.map((id) => byKey.get(id)).filter((item): item is ProjectWorkbenchDto => item !== undefined);
  }
  return projects;
}
