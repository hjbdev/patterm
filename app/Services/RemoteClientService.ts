import { z } from 'zod';
import type { ProjectWorkbenchDto, WorkbenchSnapshotDto } from '../Repositories/WorkbenchRepository';
import type { HostService, PeerHost } from './HostService';
import type { PeerIdentity, PeerLinkService } from './PeerLinkService';
import type { ProjectLinkService } from './ProjectLinkService';
import { renameDamageFrame, type TerminalFrame, type TerminalService } from './TerminalService';
import type { TerminalSubscriptions } from './TerminalSubscriptions';
import type { TimerRecord } from './TimerService';
import { CONTROL_OPERATIONS, INTEGRATED_CONTROL_TOOLS } from '../Http/BrowserTools';
import type { IntegratedConversationEvent } from './IntegratedConversation';
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
  'todo_id', 'scratchpad_id', 'reference_id', 'target_id', 'assignee_id', 'blocker_id', 'timer_id', 'conversation_id'
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

const rpcRequest = z.object({ channel: z.string().max(100), args: z.unknown().optional() }).strict();
const uploadRequest = z.object({ name: z.string().min(1).max(255), data: z.string().max(15 * 1024 * 1024) }).strict();
const clientRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('clipboard'), processId: z.string().min(1).max(200), text: z.string().max(1024 * 1024) }),
  z.object({ kind: z.literal('open-url'), processId: z.string().min(1).max(200), url: z.string().max(8192).refine((value) => /^https?:\/\//i.test(value), 'Only web links open from another host') })
]);
const conversationRequest = z.object({ process_id: z.string().min(1).max(200), subscribed: z.boolean() }).strict();
const frameEvent = z.object({ process_id: z.string().min(1).max(200), payload: z.string(), frame_kind: z.enum(['snapshot', 'damage']).nullable(), frame_seq: z.number().nullable(), resize_seq: z.number().nullable() });

export type RouteHandler = (raw: unknown) => unknown;
type ConversationListener = (event: IntegratedConversationEvent) => void;

export interface RemoteClientOptions {
  // This host's own records, without any paired host's.
  localWorkbench: () => WorkbenchSnapshotDto;
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
  // A paired host's todos or scratchpads changed; refresh those views here
  // without announcing the change back.
  notifyRemoteTopics: (topics: Array<'context'>) => void;
  // Integrated and MCP tools a paired host may call as the owner.
  allowedTools: ReadonlySet<string>;
}

// Shows paired hosts' records in this host's workbench and relays the UI's
// requests for them. A paired host acts as the owner here: that is what
// pairing two of the owner's machines is for. Agents never reach these
// routes, which only the UI calls.
export class RemoteClientService {
  private readonly workbenches = new Map<string, ProjectWorkbenchDto[]>();
  private readonly fetching = new Map<string, Promise<void>>();
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
    peers.handle('workbench.read', () => this.options.localWorkbench().projects);
    peers.handle('client.rpc', (raw, peer) => this.serveRequest(raw, peer));
    peers.handle('client.conversation', (raw, peer) => this.serveConversation(raw, peer));
    peers.handle('client.upload', (raw) => {
      const { name, data } = uploadRequest.parse(raw);
      return this.options.saveUpload(name, Buffer.from(data, 'base64'));
    });
    peers.onConnected((hostId) => void this.refresh(hostId));
    peers.onDisconnected((hostId) => this.dropHost(hostId));
    peers.onEvent((event) => {
      if (event.event === 'workbench.changed') void this.refresh(event.host_id);
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
        const topics = z.array(z.enum(['context'])).safeParse((event.payload as { topics?: unknown } | null)?.topics);
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

  // This host's todos or scratchpads changed: tell paired hosts so their
  // views of them refresh.
  localTopicsChanged(topics: readonly string[]): void {
    const shared = topics.filter((topic) => topic === 'context');
    if (!shared.length || this.disposed) return;
    for (const peer of this.hosts.peers()) this.peers.emit(peer.host_id, 'data.changed', { topics: shared });
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
          local.project = { ...local.project, remotes: [...(local.project.remotes ?? []), { host: peer.name, projectId: qualified.project.id }] };
          local.projectSessions = [...local.projectSessions, ...qualified.projectSessions];
          local.processes = [...local.processes, ...qualified.processes];
          local.worktrees = [...local.worktrees, ...qualified.worktrees];
          local.timers = [...local.timers, ...qualified.timers];
        } else if (!localId) {
          projects.push(qualified);
        }
      }
    }
    return { ...snapshot, projects };
  }

  // The paired host a request names, if any.
  target(raw: unknown): PeerHost | null {
    const names = new Set<string>();
    collectPrefixes(raw, names, 0);
    if (names.size === 0) return null;
    const peers = this.hosts.peers().filter((peer) => names.has(peer.name));
    if (peers.length > 1) throw new Error('A request cannot name records on two hosts.');
    return peers[0] ?? null;
  }

  // Runs a UI request on the paired host it names.
  async relay(host: PeerHost, channel: string, raw: unknown): Promise<unknown> {
    if (!RELAY_CHANNELS.has(channel)) throw new Error('That request cannot reach another host.');
    const args = this.unqualify(raw, host, 0);
    const result = await this.peers.request(host.host_id, 'client.rpc', { channel, args }, RELAY_TIMEOUT_MS);
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
    if (running) return running;
    const task = (async () => {
      try {
        const projects = await this.peers.request(hostId, 'workbench.read') as ProjectWorkbenchDto[];
        if (Array.isArray(projects)) this.workbenches.set(hostId, projects);
      } catch {
        // The next change or reconnect fetches again.
      } finally {
        this.fetching.delete(hostId);
      }
      this.options.invalidate();
    })();
    this.fetching.set(hostId, task);
    return task;
  }

  private dropHost(hostId: string): void {
    this.workbenches.delete(hostId);
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
    for (const [hostId, subscribed] of this.peerTerminals) {
      if (!subscribed.has(frame.processId)) continue;
      if (frame.type === 'terminal-damage') {
        this.peers.emit(hostId, 'terminal.frame', {
          process_id: frame.processId, payload: Buffer.from(frame.payload).toString('base64'),
          frame_kind: frame.frameKind, frame_seq: frame.frameSeq, resize_seq: frame.resizeSeq
        });
      } else if (frame.type === 'terminal-lifecycle') {
        this.peers.emit(hostId, 'terminal.lifecycle', frame);
      }
    }
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

  private qualifyProject(remote: ProjectWorkbenchDto, peer: PeerHost): ProjectWorkbenchDto {
    const q = (value: string | null) => value === null ? null : this.qualifyId(value, peer);
    return {
      project: { ...remote.project, id: `${peer.name}:${remote.project.id}`, host: peer.name },
      projectSessions: remote.projectSessions.map((session) => ({
        ...session, id: q(session.id)!, parentId: q(session.parentId), processId: q(session.processId),
        ptyProcessId: q(session.ptyProcessId), worktreeId: q(session.worktreeId), host: peer.name
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
