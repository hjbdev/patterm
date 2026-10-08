import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { PEER_PROTOCOL_VERSION, type HostService } from './HostService';

export const PEER_LINK_PATH = '/api/peer/link';

// Uploads relayed to another host are up to 10 MiB before base64.
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const HELLO_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;
const HEARTBEAT_MS = 15_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

// Close codes a peer sends with its reason.
const CLOSE_PROTOCOL = 4000;
const CLOSE_INCOMPATIBLE = 4001;
const CLOSE_REPLACED = 4002;
const CLOSE_UNPAIRED = 4003;

export type PeerLinkState = 'connected' | 'connecting' | 'offline';

// The other host received a request and refused it. Unlike a closed or slow
// link, repeating the request gets the same answer.
export class PeerRequestError extends Error {}
export interface PeerLinkStatus { state: PeerLinkState; error: string | null; since: string }
export interface PeerIdentity { host_id: string; name: string }
export type PeerHandler = (params: unknown, peer: PeerIdentity) => unknown;
export interface PeerEvent { host_id: string; event: string; payload: unknown }

type Frame =
  | { type: 'hello'; protocol_version: number; host_id: string; name: string }
  | { type: 'request'; id: number; method: string; params?: unknown }
  | { type: 'response'; id: number; result?: unknown; error?: string }
  | { type: 'event'; event: string; payload?: unknown };

interface Link {
  hostId: string;
  // The host that opened the socket. When both hosts dial each other, both
  // keep the link opened by the lower host ID.
  dialedBy: string;
  socket: WebSocket;
  pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>;
  nextId: number;
  alive: boolean;
}

interface Dialer { attempt: number; socket: WebSocket | null; timer: ReturnType<typeof setTimeout> | null; error: string | null; lastRefusal?: string | undefined }

export interface PeerLinkOptions {
  // Why this host may not link to paired hosts, if it may not. Checked each
  // time, since setting a password can lift it.
  blocked?: () => string | null;
  onChange?: () => void;
  // A paired host refused this one: its pairing was revoked, or the hosts run
  // incompatible versions. Retrying cannot fix it.
  onRefused?: (hostId: string, reason: string) => void;
  backoffMs?: readonly number[];
  heartbeatMs?: number;
}

// One WebSocket per paired host. The host that paired dials; the other
// accepts. Once both sides have said hello the link is symmetric: either
// side sends requests, which the other answers with its registered handlers,
// and events. Losing a link never affects local work.
export class PeerLinkService {
  private readonly links = new Map<string, Link>();
  private readonly dialers = new Map<string, Dialer>();
  private readonly status = new Map<string, PeerLinkStatus>();
  private readonly handlers = new Map<string, PeerHandler>();
  private readonly listeners = new Set<(event: PeerEvent) => void>();
  private readonly connectListeners = new Set<(hostId: string) => void>();
  private readonly disconnectListeners = new Set<(hostId: string) => void>();
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  // Every socket another host opened, from acceptance until it closes, even
  // before its hello.
  private readonly inbound = new Set<WebSocket>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(private readonly hosts: HostService, private readonly options: PeerLinkOptions = {}) {
    this.handle('peer.ping', () => ({ ...this.hosts.identity(), at: new Date().toISOString() }));
  }

  start(): void {
    this.heartbeat ??= setInterval(() => this.beat(), this.options.heartbeatMs ?? HEARTBEAT_MS);
    this.heartbeat.unref?.();
    this.refresh();
  }

  // Dials outbound peers that are not dialled yet and drops links to peers
  // that are no longer paired.
  refresh(): void {
    if (this.disposed || this.options.blocked?.()) return;
    const peers = this.hosts.peers();
    for (const [hostId, link] of this.links) {
      if (!peers.some((peer) => peer.host_id === hostId)) link.socket.close(CLOSE_UNPAIRED, 'Unpaired');
    }
    for (const [hostId, dialer] of this.dialers) {
      if (peers.some((peer) => peer.host_id === hostId && peer.direction === 'outbound')) continue;
      if (dialer.timer) clearTimeout(dialer.timer);
      this.dialers.delete(hostId);
      dialer.socket?.terminate();
    }
    for (const hostId of this.status.keys()) if (!peers.some((peer) => peer.host_id === hostId)) this.status.delete(hostId);
    for (const peer of peers) {
      if (peer.direction !== 'outbound' || this.dialers.has(peer.host_id)) continue;
      this.dialers.set(peer.host_id, { attempt: 0, socket: null, timer: null, error: null });
      this.dial(peer.host_id);
    }
    this.changed();
  }

  // The link state of every paired host.
  statuses(): Record<string, PeerLinkStatus> {
    const result: Record<string, PeerLinkStatus> = {};
    for (const peer of this.hosts.peers()) {
      result[peer.host_id] = this.status.get(peer.host_id) ?? { state: 'offline', error: null, since: peer.created_at };
    }
    return result;
  }

  connected(hostId: string): boolean {
    return this.links.has(hostId);
  }

  handle(method: string, handler: PeerHandler): void {
    this.handlers.set(method, handler);
  }

  // Runs each time a link to a host is established.
  onConnected(listener: (hostId: string) => void): () => void {
    this.connectListeners.add(listener);
    return () => this.connectListeners.delete(listener);
  }

  // Runs each time an established link to a host closes.
  onDisconnected(listener: (hostId: string) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  onEvent(listener: (event: PeerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Asks a connected peer to run one of its handlers.
  request(hostId: string, method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const link = this.links.get(hostId);
    if (!link) return Promise.reject(new Error(`${this.hosts.peer(hostId)?.name ?? 'That host'} is not connected.`));
    const id = ++link.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        link.pending.delete(id);
        reject(new Error(`${this.hosts.peer(hostId)?.name ?? 'The host'} did not answer in time.`));
      }, timeoutMs);
      link.pending.set(id, { resolve, reject, timer });
      if (!this.send(link.socket, { type: 'request', id, method, ...(params === undefined ? {} : { params }) })) {
        clearTimeout(timer);
        link.pending.delete(id);
        reject(new Error('The link closed.'));
      }
    });
  }

  emit(hostId: string, event: string, payload?: unknown): boolean {
    const link = this.links.get(hostId);
    return Boolean(link && this.send(link.socket, { type: 'event', event, ...(payload === undefined ? {} : { payload }) }));
  }

  // Accepts a link from an inbound peer. The caller has already checked the
  // request's Host and that it is not from a browser.
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
    const grant = token && !this.disposed && !this.options.blocked?.() ? this.hosts.verifyCredential(token) : null;
    if (!grant) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    this.server.handleUpgrade(request, socket, head, (ws) => {
      this.inbound.add(ws);
      ws.once('close', () => this.inbound.delete(ws));
      if (this.disposed) { ws.terminate(); return; }
      this.attach(grant.host_id, ws, false);
    });
  }

  // Ends links other hosts opened, so a stopping server can close: upgraded
  // sockets keep an HTTP server open. Those hosts reconnect when it returns.
  closeInbound(): void {
    for (const socket of this.inbound) socket.terminate();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const dialer of this.dialers.values()) {
      if (dialer.timer) clearTimeout(dialer.timer);
      dialer.socket?.terminate();
    }
    this.dialers.clear();
    for (const link of this.links.values()) link.socket.terminate();
    for (const socket of this.inbound) socket.terminate();
    this.links.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private dial(hostId: string): void {
    const dialer = this.dialers.get(hostId);
    const target = this.hosts.dialTarget(hostId);
    if (!dialer || !target || this.disposed) return;
    dialer.timer = null;
    if (this.open(hostId)) {
      // The peer dialled this host; check again later in case it stops.
      dialer.timer = setTimeout(() => this.dial(hostId), (this.options.backoffMs ?? BACKOFF_MS).at(-1)!);
      dialer.timer.unref?.();
      return;
    }
    this.setStatus(hostId, 'connecting', dialer.error);
    const url = `${target.url.replace(/^http/, 'ws')}${PEER_LINK_PATH}`;
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${target.credential}` }, maxPayload: MAX_FRAME_BYTES, handshakeTimeout: HELLO_TIMEOUT_MS, followRedirects: false });
    dialer.socket = socket;
    let error: string | null = null;
    let refused = false;
    socket.once('unexpected-response', (_request, response) => {
      refused = response.statusCode === 401;
      error = refused
        ? `${this.hosts.peer(hostId)?.name ?? 'The host'} no longer accepts this host. Pair again.`
        : `The host answered HTTP ${response.statusCode}.`;
      response.resume();
      socket.terminate();
    });
    socket.on('error', (cause) => { error ??= cause.message; });
    socket.once('open', () => this.attach(hostId, socket, true));
    socket.once('close', (code, reason) => {
      if (dialer.socket !== socket) return;
      dialer.socket = null;
      const closed = closeReason(code, reason.toString());
      dialer.error = closed ?? error ?? (this.status.get(hostId)?.state === 'connected' ? null : 'Could not connect.');
      if (dialer.error) this.hosts.recordConnection(hostId, dialer.error);
      if ((refused || code === CLOSE_UNPAIRED || code === CLOSE_INCOMPATIBLE) && dialer.error && dialer.lastRefusal !== dialer.error) {
        dialer.lastRefusal = dialer.error;
        this.options.onRefused?.(hostId, dialer.error);
      }
      this.retry(hostId);
    });
  }

  private retry(hostId: string): void {
    const dialer = this.dialers.get(hostId);
    if (!dialer || this.disposed) return;
    const backoff = this.options.backoffMs ?? BACKOFF_MS;
    const delay = backoff[Math.min(dialer.attempt++, backoff.length - 1)]! * (0.8 + Math.random() * 0.4);
    if (!this.open(hostId)) this.setStatus(hostId, 'connecting', dialer.error);
    dialer.timer = setTimeout(() => this.dial(hostId), delay);
    dialer.timer.unref?.();
  }

  // Exchanges hellos, then serves frames until the socket closes.
  private attach(hostId: string, socket: WebSocket, outbound: boolean): void {
    const self = this.hosts.identity();
    this.send(socket, { type: 'hello', protocol_version: PEER_PROTOCOL_VERSION, host_id: self.host_id, name: self.name });
    let link: Link | null = null;
    const helloTimer = setTimeout(() => socket.close(CLOSE_PROTOCOL, 'No hello'), HELLO_TIMEOUT_MS);
    socket.on('message', (data, binary) => {
      const frame = binary ? null : parseFrame(data);
      if (!frame) { socket.close(CLOSE_PROTOCOL, 'Invalid frame'); return; }
      if (!link) {
        if (frame.type !== 'hello') { socket.close(CLOSE_PROTOCOL, 'Expected hello'); return; }
        clearTimeout(helloTimer);
        if (frame.protocol_version !== PEER_PROTOCOL_VERSION) { socket.close(CLOSE_INCOMPATIBLE, 'Incompatible Patterm version'); return; }
        if (frame.host_id !== hostId || !this.hosts.peer(hostId)) { socket.close(CLOSE_UNPAIRED, 'Not paired'); return; }
        const candidate: Link = { hostId, dialedBy: outbound ? self.host_id : hostId, socket, pending: new Map(), nextId: 0, alive: true };
        const existing = this.links.get(hostId);
        // A host reconnecting replaces its own earlier link. Links opened
        // from both ends keep the one the lower host ID opened.
        if (existing && existing.dialedBy !== candidate.dialedBy && existing.dialedBy < candidate.dialedBy) {
          socket.close(CLOSE_REPLACED, 'Replaced');
          return;
        }
        link = candidate;
        existing?.socket.close(CLOSE_REPLACED, 'Replaced');
        this.links.set(hostId, link);
        this.hosts.updatePeerName(hostId, frame.name);
        this.hosts.recordConnection(hostId, null);
        const dialer = this.dialers.get(hostId);
        if (dialer) { dialer.attempt = 0; dialer.error = null; dialer.lastRefusal = undefined; }
        this.setStatus(hostId, 'connected', null);
        for (const listener of this.connectListeners) listener(hostId);
        return;
      }
      this.receive(link, frame);
    });
    socket.on('pong', () => { if (link) link.alive = true; });
    socket.on('error', () => socket.terminate());
    socket.once('close', () => {
      clearTimeout(helloTimer);
      if (!link || this.links.get(hostId) !== link) return;
      this.links.delete(hostId);
      for (const pending of link.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('The link closed.'));
      }
      if (!this.dialers.has(hostId)) this.setStatus(hostId, 'offline', null);
      for (const listener of this.disconnectListeners) listener(hostId);
    });
  }

  private receive(link: Link, frame: Frame): void {
    if (frame.type === 'request') {
      const peer = this.hosts.peer(link.hostId);
      const handler = this.handlers.get(frame.method);
      void (async () => {
        try {
          if (!handler || !peer) throw new Error(`Unknown peer method: ${frame.method}`);
          this.send(link.socket, { type: 'response', id: frame.id, result: await handler(frame.params, { host_id: peer.host_id, name: peer.name }) ?? null });
        } catch (error) {
          this.send(link.socket, { type: 'response', id: frame.id, error: error instanceof Error ? error.message : String(error) });
        }
      })();
    } else if (frame.type === 'response') {
      const pending = link.pending.get(frame.id);
      if (!pending) return;
      link.pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.error !== undefined) pending.reject(new PeerRequestError(frame.error));
      else pending.resolve(frame.result);
    } else if (frame.type === 'event') {
      for (const listener of this.listeners) listener({ host_id: link.hostId, event: frame.event, payload: frame.payload });
    }
  }

  private open(hostId: string): boolean {
    return this.links.get(hostId)?.socket.readyState === WebSocket.OPEN;
  }

  private beat(): void {
    for (const link of this.links.values()) {
      if (!link.alive) { link.socket.terminate(); continue; }
      link.alive = false;
      link.socket.ping();
    }
  }

  private send(socket: WebSocket, frame: Frame): boolean {
    if (socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > MAX_FRAME_BYTES * 2) { socket.terminate(); return false; }
    socket.send(JSON.stringify(frame));
    return true;
  }

  private setStatus(hostId: string, state: PeerLinkState, error: string | null): void {
    const previous = this.status.get(hostId);
    if (previous?.state === state && previous.error === error) return;
    this.status.set(hostId, { state, error, since: new Date().toISOString() });
    this.changed();
  }

  private changed(): void {
    this.options.onChange?.();
  }
}

function closeReason(code: number, reason: string): string | null {
  if (code === CLOSE_INCOMPATIBLE) return 'The hosts run incompatible Patterm versions. Update both.';
  if (code === CLOSE_UNPAIRED) return 'The other host no longer has this host paired. Pair again.';
  if (code === CLOSE_PROTOCOL) return `The link failed: ${reason || 'protocol error'}.`;
  return null;
}

function parseFrame(data: RawData): Frame | null {
  try {
    const frame = JSON.parse(data.toString()) as Frame;
    if (!frame || typeof frame !== 'object') return null;
    if (frame.type === 'hello') return typeof frame.host_id === 'string' && typeof frame.name === 'string' && typeof frame.protocol_version === 'number' ? frame : null;
    if (frame.type === 'request') return Number.isInteger(frame.id) && typeof frame.method === 'string' ? frame : null;
    if (frame.type === 'response') return Number.isInteger(frame.id) ? frame : null;
    if (frame.type === 'event') return typeof frame.event === 'string' ? frame : null;
    return null;
  } catch {
    return null;
  }
}
