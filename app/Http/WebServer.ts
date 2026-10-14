import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { FIGURE_FRAME_HTML, FIGURE_FRAME_PATH, figureFrameCsp } from '../Services/HtmlFigure';
import { readFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import type { PattermApplication } from '../App';
import { registerApplicationRoutes, type RouteRegistrar } from '../../routes/application';
import { callIntegrated, readIntegrated, relayingRegistrar } from '../../routes/remote';
import { registerCommandRoutes } from '../../routes/commands';
import { BrowserTerminalSessions, type BrowserTerminalClient } from './BrowserTerminalSessions';
import { ClientConversationSubscriptions, updateConversationSubscription } from './ClientConversationSubscriptions';
import { UploadService, MAX_UPLOAD_BYTES } from './UploadService';
import { MCP_OAUTH_CALLBACK_PATH } from '../Services/McpOAuthService';
import { PEER_PAIR_PATH } from '../Actions/HostActions';
import { BROWSER_TOOLS, CONTROL_OPERATIONS, INTEGRATED_CONTROL_TOOLS } from './BrowserTools';
import { PEER_LINK_PATH } from '../Services/PeerLinkService';
import { CompressedFileCache, compress, isCompressibleFile, MIN_COMPRESSED_BYTES, preferredEncoding } from './ResponseCompression';
import { isLoopback, isMachineAddress, loopbackPeerUid, remoteAccessInput, ServerAccess, type ConnectionEnds } from './ServerAccess';
import { machineAddresses, type RemoteAccessPlan } from './RemoteAccessPlan';
import { TailscaleService } from '../Services/TailscaleService';

const rpcInput = z.object({ id: z.number().int().nonnegative(), channel: z.string().max(100), args: z.unknown().optional() });
const MAX_RPC_BYTES = 1024 * 1024;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const passwordInput = z.object({ password: z.string().max(1024) });
const passwordChangeInput = z.object({ current: z.string().max(1024).nullable().default(null), password: z.string().max(1024).nullable() });
// Open without signing in: the sign-in routes, the pairing route (other hosts
// use their own credential), and MCP sign-in redirects (cross-site, so the
// SameSite cookie is not sent).
const OPEN_API_PATHS = new Set(['/api/session', '/api/login', '/api/logout', PEER_PAIR_PATH]);

export interface WebServerOptions {
  port: number;
  publicOrigin: string;
  rendererPath: string;
  appDataPath: string;
  // The tailnet login allowed through Tailscale Serve. Requests to the public
  // origin from anyone else are refused. Loopback requests are unaffected.
  ownerLogin?: string;
  // The uid that owns a loopback client's socket, or null if unknown. Linux
  // reads /proc/net/tcp and tcp6; other platforms skip the check.
  loopbackPeerUid?: (ends: ConnectionEnds) => number | null;
  // Network addresses to listen on besides 127.0.0.1, in network mode.
  listen?: string[];
  // Restarts the server to apply a new Remote access setting. Absent when
  // nothing would start it again, such as outside systemd.
  restart?: () => void;
  tailscale?: Pick<TailscaleService, 'state'>;
  // The Remote access setting as the server applied it at startup.
  remoteAccess?: Pick<RemoteAccessPlan, 'mode' | 'warnings'>;
}

export class WebServer {
  // The loopback listener first, then any network addresses.
  private readonly servers: http.Server[];
  private readonly server: http.Server;
  // Terminal snapshots are mostly repeated cells and shrink 20–90 times at the
  // fastest deflate level. Without context takeover each message is
  // compressed on its own: per-socket memory stays small, and `ws` applies the
  // threshold, so short replies and requests are sent as they are.
  private readonly sockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_RPC_BYTES,
    perMessageDeflate: {
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
      threshold: MIN_COMPRESSED_BYTES,
      zlibDeflateOptions: { level: zlib.constants.Z_BEST_SPEED }
    }
  });
  private readonly compressedFiles = new CompressedFileCache();
  private readonly routes = new Map<string, (raw: unknown) => unknown>();
  private readonly terminals: BrowserTerminalSessions;
  private readonly uploads: UploadService;
  private readonly origin: URL;
  private readonly access: ServerAccess;
  private readonly unsubscribe: Array<() => void> = [];
  private readonly requests = new Set<Promise<unknown>>();
  private readonly queues = new Map<WebSocket, Promise<unknown>>();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private stopping = false;

  constructor(private readonly application: PattermApplication, private readonly options: WebServerOptions) {
    this.origin = new URL(options.publicOrigin);
    if (!['https:', 'http:'].includes(this.origin.protocol) || this.origin.origin !== options.publicOrigin) {
      throw new Error('PATTERM_PUBLIC_ORIGIN must be an HTTP(S) origin without a path');
    }
    this.access = application.serverAccess;
    this.terminals = new BrowserTerminalSessions(application);
    this.uploads = new UploadService(path.join(options.appDataPath, 'uploads'));
    const register = (channel: string, handler: (event: unknown, raw?: unknown) => unknown) => {
      this.routes.set(channel, (raw) => handler(undefined, raw));
    };
    const registrar: RouteRegistrar = { handle: register, on: register };
    registerApplicationRoutes(relayingRegistrar(registrar, application), application);
    registerCommandRoutes(registrar, application);
    this.servers = [null, ...(options.listen ?? [])].map(() => this.createServer());
    this.server = this.servers[0]!;
    this.unsubscribe.push(application.onWorkbenchPatch((patch) => this.broadcast('workbench-patch', patch)));
    this.unsubscribe.push(application.onDataChanged((topics) => this.broadcast('data-changed', { topics })));
    this.unsubscribe.push(application.terminal.onFrame((frame) => {
      if (frame.type === 'terminal-lifecycle') {
        // Browsers use mouse modes, and only for terminals they show. Title
        // spinners would otherwise reach every browser about ten times a second.
        if (frame.event !== 'mouse_mode') return;
        for (const client of this.terminals.clients) {
          if (client.subscriptions.has(frame.processId)) client.sendEvent('terminal-lifecycle', frame);
        }
      } else if (frame.type === 'terminal-damage') {
        for (const client of this.terminals.clients) {
          if (frame.processId && client.subscriptions.has(frame.processId)) client.sendEvent('terminal-frame', frame.payload);
        }
      }
    }));
    this.unsubscribe.push(application.onNotificationsChanged((change) => this.broadcast('notifications-changed', change)));
    this.unsubscribe.push(application.onAssistantEvent((event) => this.broadcast('assistant-event', event)));
    this.unsubscribe.push(application.onTerminalClientRequest((request) => {
      this.terminals.sendToController(request.processId, 'terminal-client-request', request);
    }));
  }

  private createServer(): http.Server {
    const server = http.createServer((request, response) => {
      if (this.requests.size >= 32) { response.writeHead(503); response.end(); return; }
      const handling = this.handleHttp(request, response).catch(async (error) => {
        if (!response.headersSent) await this.json(request, response, 400, { error: errorMessage(error) });
        else response.destroy();
      });
      this.requests.add(handling);
      void handling.finally(() => this.requests.delete(handling));
    });
    // Other accounts on this machine can reach the loopback listener, so only
    // this user and root (tailscaled, for Tailscale Serve) may connect.
    server.on('connection', (socket: Socket) => {
      if (!this.allowedLocalPeer(socket)) socket.destroy();
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    server.on('upgrade', (request, socket, head) => {
      if (request.url === PEER_LINK_PATH) {
        if (this.stopping || !this.allowedPeer(request)) socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        else this.application.peers.handleUpgrade(request, socket, head);
        return;
      }
      if (this.stopping || request.url !== '/api/events' || !this.allowed(request, true) || !this.access.allows(request.headers.cookie) || this.sockets.clients.size >= 32) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      this.sockets.handleUpgrade(request, socket, head, (ws) => this.connect(ws));
    });
    return server;
  }

  async start(): Promise<number> {
    const listen = (server: http.Server, port: number, host: string) => new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    await listen(this.server, this.options.port, '127.0.0.1');
    const port = (this.server.address() as { port: number }).port;
    for (const [index, host] of (this.options.listen ?? []).entries()) await listen(this.servers[index + 1]!, port, host);
    const alive = new WeakSet<WebSocket>();
    this.sockets.on('connection', (socket) => {
      alive.add(socket);
      socket.on('pong', () => alive.add(socket));
    });
    this.heartbeat = setInterval(() => {
      for (const socket of this.sockets.clients) {
        if (!alive.has(socket)) { socket.terminate(); continue; }
        alive.delete(socket);
        socket.ping();
      }
    }, 15_000);
    return (this.server.address() as { port: number }).port;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.heartbeat);
    for (const off of this.unsubscribe) off();
    for (const socket of this.sockets.clients) socket.terminate();
    this.sockets.close();
    this.application.peers.closeInbound();
    for (const server of this.servers) server.closeAllConnections();
    await Promise.all(this.servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await Promise.allSettled([...this.requests, ...this.queues.values()]);
    await Promise.all([...this.terminals.clients].map((client) => this.terminals.disconnect(client)));
  }

  private allowed(request: IncomingMessage, requireOrigin: boolean): boolean {
    return this.allowedHost(request)
      && (!requireOrigin || this.allowedOrigins().includes(request.headers.origin ?? ''))
      && (!request.headers.origin || this.allowedOrigins().includes(request.headers.origin))
      && (request.headers['sec-fetch-site'] !== 'cross-site' || this.isTopLevelNavigation(request));
  }

  // The public origin, and the loopback addresses a browser on this machine uses.
  private allowedOrigins(): string[] {
    const address = this.server.address();
    const port = typeof address === 'object' && address ? address.port : this.options.port;
    return [this.origin.origin, `http://127.0.0.1:${port}`, `http://localhost:${port}`];
  }

  private allowedHost(request: IncomingMessage): boolean {
    const host = request.headers.host ?? '';
    if (!this.allowedOrigins().map((origin) => new URL(origin).host).includes(host)) return false;
    // Tailscale Funnel would reach Patterm from the public internet.
    if (request.headers['tailscale-funnel-request'] !== undefined) return false;
    // Tailscale Serve sets this header for tailnet users and replaces any
    // value the client sent. Tagged devices send none, so only a login that
    // names someone else is refused; the tailnet policy or a password decides
    // the rest.
    const viaPublicOrigin = host === this.origin.host && !['localhost', '127.0.0.1'].includes(this.origin.hostname);
    const login = request.headers['tailscale-user-login'];
    return !this.options.ownerLogin || !viaPublicOrigin || login === undefined || login === this.options.ownerLogin;
  }

  // A local process can connect from any address on this machine, to the
  // loopback listener or a network one, so every connection to the loopback
  // listener and every connection from this machine is checked.
  private allowedLocalPeer(socket: Socket): boolean {
    if (!isLoopback(socket.localAddress) && !isLoopback(socket.remoteAddress) && !isMachineAddress(socket.remoteAddress)) return true;
    const lookup = this.options.loopbackPeerUid ?? (process.platform === 'linux' ? procLoopbackPeerUid : null);
    if (!lookup || !process.getuid) return true;
    const uid = lookup({ clientAddress: socket.remoteAddress ?? '', clientPort: socket.remotePort ?? 0, serverAddress: socket.localAddress ?? '', serverPort: socket.localPort ?? 0 });
    return uid !== null && (uid === process.getuid() || uid === 0);
  }

  // Another Patterm host, not a browser: no Origin and no fetch metadata.
  private allowedPeer(request: IncomingMessage): boolean {
    return this.allowedHost(request) && !request.headers.origin && !request.headers['sec-fetch-site'];
  }

  // Android launches installed PWAs with a cross-site navigation, so allow page loads but nothing else.
  private isTopLevelNavigation(request: IncomingMessage): boolean {
    return (request.method === 'GET' || request.method === 'HEAD')
      && request.headers['sec-fetch-mode'] === 'navigate'
      && !['object', 'embed'].includes(request.headers['sec-fetch-dest'] as string);
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (request.url === PEER_PAIR_PATH && request.method === 'POST') {
      await this.handlePeerPair(request, response);
      return;
    }
    if (!this.allowed(request, request.method !== 'GET' && request.method !== 'HEAD')) {
      await this.json(request, response, 403, { error: 'Request origin is not allowed' });
      return;
    }
    const url = new URL(request.url ?? '/', this.origin);
    if (url.pathname.startsWith('/api/') && !OPEN_API_PATHS.has(url.pathname) && !url.pathname.startsWith('/api/peer/') && !this.access.allows(request.headers.cookie)) {
      await this.json(request, response, 401, { error: 'Sign in to Patterm', signed_in: false });
      return;
    }
    if (url.pathname.startsWith('/api/') && await this.handleAccess(url.pathname, request, response)) return;
    if (url.pathname === '/health' && request.method === 'GET') {
      const ready = !this.stopping && this.application.terminal.isAvailable();
      await this.json(request, response, ready ? 200 : 503, { ready });
      return;
    }
    if (this.stopping) { await this.json(request, response, 503, { error: 'Server is stopping' }); return; }
    if (url.pathname === '/api/rpc' && request.method === 'POST') {
      if (request.headers['content-type'] !== 'application/json') throw new Error('Expected application/json');
      const payload = rpcInput.parse(JSON.parse((await readBody(request, MAX_RPC_BYTES)).toString('utf8')));
      if (payload.channel.startsWith('patterm:terminal:')) throw new Error('Terminal requests require a WebSocket connection');
      const result = await this.dispatch(payload.channel, payload.args);
      if (payload.channel === 'patterm:commands:run' && (result as { rendererAction?: string } | undefined)?.rendererAction === 'quit') {
        this.broadcast('application-stopped', null);
        response.once('finish', () => this.application.requestQuit());
      }
      await this.json(request, response, 200, { result: result ?? null });
      return;
    }
    // MCP server sign-ins redirect here from the service's own site.
    if (url.pathname === MCP_OAUTH_CALLBACK_PATH && request.method === 'GET') {
      const page = await this.application.mcpSignInCallback(url.href);
      response.writeHead(page.status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(page.body);
      return;
    }
    if (url.pathname === '/api/upload' && request.method === 'POST') {
      const name = url.searchParams.get('name') ?? 'attachment';
      const bytes = await readBody(request, MAX_UPLOAD_BYTES);
      // An attachment for a paired host's agent is stored on that host.
      const host = this.application.remote.target({ process_id: url.searchParams.get('process_id') ?? '' });
      const filename = host ? await this.application.remote.upload(host, name, bytes) : await this.uploads.save(name, bytes);
      await this.json(request, response, 200, { path: filename });
      return;
    }
    // Agent pages run in this frame under their own policy; see HtmlFigure.
    if (url.pathname === FIGURE_FRAME_PATH && (request.method === 'GET' || request.method === 'HEAD')) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': figureFrameCsp("'self'"), 'Cache-Control': 'no-store' });
      response.end(FIGURE_FRAME_HTML);
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method ?? '') || url.pathname.startsWith('/api/')) {
      await this.json(request, response, 404, { error: 'Not found' });
      return;
    }
    const pathname = decodeURIComponent(url.pathname);
    const isPage = /^\/(?:settings|usage|routines(?:\/log)?)\/?$/.test(pathname) || /^\/projects(?:\/[^/]+(?:\/(?:worktrees|history|media|(?:todos|scratchpads)(?:\/[^/]+)?|processes\/[^/]+|agents\/[^/]+(?:\/diffs)?))?)?\/?$/.test(pathname);
    const relative = isPage ? 'index.html' : pathname.replace(/^\/+/, '') || 'index.html';
    const filename = path.resolve(this.options.rendererPath, relative);
    if (!filename.startsWith(path.resolve(this.options.rendererPath) + path.sep)) {
      await this.json(request, response, 404, { error: 'Not found' }); return;
    }
    let body: Buffer;
    let stamp: string;
    try {
      const [contents, stat] = await Promise.all([fs.readFile(filename), fs.stat(filename)]);
      body = contents;
      stamp = `${stat.size}:${stat.mtimeMs}`;
    } catch { await this.json(request, response, 404, { error: 'Not found' }); return; }
    // Keep the same relative-asset build usable through Electron's file protocol.
    if (relative === 'index.html') body = Buffer.from(body.toString('utf8').replace(/\b(src|href)="\.\//g, '$1="/'));
    const types: Record<string, string> = {
      '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon',
      '.webmanifest': 'application/manifest+json'
    };
    const extension = path.extname(filename);
    response.setHeader('Content-Type', types[extension] ?? 'application/octet-stream');
    response.setHeader('Cache-Control', relative.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    const encoding = isCompressibleFile(extension) && body.length >= MIN_COMPRESSED_BYTES ? preferredEncoding(request.headers['accept-encoding']) : null;
    if (isCompressibleFile(extension)) response.setHeader('Vary', 'Accept-Encoding');
    if (encoding) {
      body = await this.compressedFiles.get(filename, stamp, body, encoding);
      response.setHeader('Content-Encoding', encoding);
    }
    response.setHeader('Content-Length', body.length);
    response.end(request.method === 'HEAD' ? undefined : body);
  }

  // Another host asks to pair using the one-time code shown here.
  private async handlePeerPair(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.allowedPeer(request)) { await this.json(request, response, 403, { error: 'Request origin is not allowed' }); return; }
    if (this.stopping) { await this.json(request, response, 503, { error: 'Server is stopping' }); return; }
    if (request.headers['content-type'] !== 'application/json') throw new Error('Expected application/json');
    const body = JSON.parse((await readBody(request, 16 * 1024)).toString('utf8'));
    const accepted = this.application.hosts.acceptPairing(body);
    this.application.notifyChanged(['settings']);
    await this.json(request, response, 200, accepted);
  }

  private async dispatch(channel: string, args: unknown): Promise<unknown> {
    if (this.application.isShuttingDown() && channel !== 'patterm:commands:run') throw new Error('Patterm is shutting down');
    const route = this.routes.get(channel);
    if (!route) throw new Error('Unknown operation');
    if (channel === 'patterm:mcp:call') {
      const { tool } = z.object({ tool: z.string() }).parse(args);
      if (!BROWSER_TOOLS.has(tool)) throw new Error('This tool is not available through the browser');
    }
    return route(args);
  }

  private connect(socket: WebSocket): void {
    const send = (payload: string | Uint8Array) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount + Buffer.byteLength(payload) > MAX_BUFFER_BYTES) { socket.terminate(); return; }
      socket.send(payload);
    };
    const client: BrowserTerminalClient = {
      subscriptions: new Set(),
      sendEvent: (event, payload) => send(event === 'terminal-frame' ? payload as Uint8Array : JSON.stringify({ event, payload })),
      conversations: new ClientConversationSubscriptions(
        (processId, listener) => this.application.subscribeConversation(processId, listener),
        (payload) => send(JSON.stringify({ event: 'conversation-event', payload }))
      )
    };
    this.terminals.clients.add(client);
    const presenceId = `browser_${randomUUID()}`;
    let queue: Promise<unknown> = Promise.resolve();
    let queued = 0;
    let queuedBytes = 0;
    socket.on('message', (data, binary) => {
      const byteLength = Array.isArray(data) ? data.reduce((size, chunk) => size + chunk.byteLength, 0) : data.byteLength;
      queuedBytes += byteLength;
      if (binary || ++queued > 128 || queuedBytes > MAX_BUFFER_BYTES) { socket.terminate(); return; }
      queue = queue.then(async () => {
        if (socket.readyState !== WebSocket.OPEN) return;
        let id: number | undefined;
        try {
          const payload = rpcInput.parse(JSON.parse(data.toString()));
          id = payload.id;
          const { channel } = payload;
          let args = payload.args;
          let result: unknown;
          if (channel === 'patterm:terminal:subscribe') result = await this.terminals.subscribe(client, args);
          else if (channel === 'patterm:terminal:take-control') result = await this.terminals.takeControl(client, args);
          else if (channel === 'patterm:conversation:subscribe') {
            result = await updateConversationSubscription(client.conversations!, args, (processId) => readIntegrated(this.application, processId));
          } else if (channel === 'patterm:presence:update') {
            // Presence belongs to this socket and ends when it closes.
            this.application.notifications.updatePresence(presenceId, args);
            result = { ok: true };
          } else if (channel === 'patterm:integrated:call') {
            const call = z.object({ tool: z.string(), arguments: z.object({ process_id: z.string().min(1) }).passthrough() }).parse(args);
            if (!INTEGRATED_CONTROL_TOOLS.has(call.tool)) throw new Error('Unknown Integrated control operation');
            this.terminals.guard(client, call.arguments);
            result = await callIntegrated(this.application, call.tool, call.arguments);
          } else {
            const operation = channel.replace('patterm:terminal:', '');
            if (!channel.startsWith('patterm:terminal:')) throw new Error('Use HTTP for non-terminal operations');
            if (CONTROL_OPERATIONS.has(operation)) args = this.terminals.guard(client, args, operation === 'resize');
            result = await this.dispatch(channel, args);
          }
          send(boundedReply(id, result));
        } catch (error) {
          send(JSON.stringify({ id, error: errorMessage(error) }));
        }
      }).finally(() => { queued--; queuedBytes -= byteLength; });
      this.queues.set(socket, queue);
    });
    socket.on('error', () => socket.terminate());
    socket.on('close', () => {
      this.application.notifications.removePresence(presenceId);
      const cleanup = queue.then(() => this.stopping ? undefined : this.terminals.disconnect(client));
      this.queues.set(socket, cleanup);
      void cleanup.finally(() => this.queues.delete(socket)).catch(() => {});
    });
    this.sockets.emit('connection', socket);
  }

  private broadcast(event: string, payload: unknown): void {
    for (const client of this.terminals.clients) client.sendEvent(event, payload);
  }

  // Sign-in and the password, which Settings › Remote access changes.
  private async handleAccess(pathname: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const secure = this.origin.protocol === 'https:';
    if (pathname === '/api/session' && request.method === 'GET') {
      await this.json(request, response, 200, { password_set: this.access.passwordSet(), signed_in: this.access.allows(request.headers.cookie), tailnet: this.origin.hostname.endsWith('.ts.net') });
      return true;
    }
    if (pathname === '/api/login' && request.method === 'POST') {
      const { password } = passwordInput.parse(JSON.parse((await readBody(request, 4096)).toString('utf8')));
      const token = await this.access.signIn(password);
      if (!token) { await this.json(request, response, 401, { error: 'Wrong password' }); return true; }
      response.setHeader('Set-Cookie', this.access.sessionCookie(token, secure));
      await this.json(request, response, 200, { signed_in: true });
      return true;
    }
    if (pathname === '/api/logout' && request.method === 'POST') {
      response.setHeader('Set-Cookie', this.access.clearedCookie(secure));
      await this.json(request, response, 200, { signed_in: false });
      return true;
    }
    if (pathname === '/api/access/remote' && request.method === 'GET') {
      await this.json(request, response, 200, await this.remoteAccessView());
      return true;
    }
    if (pathname === '/api/access/remote' && request.method === 'POST') {
      const input = remoteAccessInput.parse(JSON.parse((await readBody(request, 4096)).toString('utf8')));
      if (input.mode === 'network' && !machineAddresses().includes(input.bind ?? '')) throw new Error('Choose one of this machine\'s addresses');
      if (input.mode === 'tailscale') {
        const tailscale = await (this.options.tailscale ?? new TailscaleService()).state();
        if (input.owner_login !== null && input.owner_login !== tailscale.ownerLogin) throw new Error('Only this machine\'s own Tailscale login can be the owner');
      }
      this.access.setRemoteAccess(input);
      // The address and origin are fixed at startup, so the server restarts
      // to apply them. Agents and terminals keep running.
      const restarting = Boolean(this.options.restart);
      await this.json(request, response, 200, { ...(await this.remoteAccessView()), restarting });
      if (restarting) response.once('finish', () => setTimeout(() => this.options.restart!(), 250));
      return true;
    }
    if (pathname === '/api/access/password' && request.method === 'POST') {
      const input = passwordChangeInput.parse(JSON.parse((await readBody(request, 4096)).toString('utf8')));
      // The network listener runs until the server restarts, whatever is saved.
      if (input.password === null && this.options.listen?.length) throw new Error('Patterm is open to a network, which needs a password. Switch Remote access to this machine or Tailscale and let it restart first.');
      // Changing the password signs out every browser, so this one gets a new
      // cookie to stay signed in.
      const token = await this.access.setPassword(input.password, input.current);
      response.setHeader('Set-Cookie', token ? this.access.sessionCookie(token, secure) : this.access.clearedCookie(secure));
      // Close live connections that used the old cookie; they reconnect and
      // sign in again.
      for (const socket of this.sockets.clients) socket.close(4001, 'Password changed');
      // A password can lift the block on pairing.
      this.application.peers.refresh();
      this.application.notifyChanged(['settings']);
      await this.json(request, response, 200, { password_set: this.access.passwordSet() });
      return true;
    }
    return false;
  }

  private async remoteAccessView() {
    let tailscale: { hostname: string; owner_login: string | null } | { error: string };
    try {
      const state = await (this.options.tailscale ?? new TailscaleService()).state();
      tailscale = { hostname: state.hostname, owner_login: state.ownerLogin };
    } catch (error) {
      tailscale = { error: errorMessage(error) };
    }
    return {
      saved: this.access.remoteAccess(),
      running: { mode: this.options.remoteAccess?.mode ?? 'local', origin: this.origin.origin, warnings: this.options.remoteAccess?.warnings ?? [] },
      password_set: this.access.passwordSet(),
      addresses: machineAddresses(),
      tailscale,
      can_restart: Boolean(this.options.restart)
    };
  }

  // Compresses larger bodies, such as a full workbench snapshot, off the event
  // loop. Small replies are sent as they are.
  private async json(request: IncomingMessage, response: ServerResponse, status: number, body: unknown): Promise<void> {
    let payload: Buffer = Buffer.from(JSON.stringify(body));
    const headers: http.OutgoingHttpHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' };
    const encoding = payload.length >= MIN_COMPRESSED_BYTES ? preferredEncoding(request.headers['accept-encoding']) : null;
    if (encoding) {
      payload = await compress(payload, encoding, 'fast');
      headers['Content-Encoding'] = encoding;
    }
    headers['Content-Length'] = payload.length;
    response.writeHead(status, headers);
    response.end(payload);
  }
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body is too large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Request failed';
}

// The socket closes when a send would overrun its buffer, and the browser then
// reconnects and asks again, so an oversized reply would loop forever. A
// conversation snapshot is dropped instead, and the browser reads it over HTTP.
// Half the limit leaves room for terminal frames already queued.
export function boundedReply(id: number | undefined, result: unknown): string {
  const reply = JSON.stringify({ id, result: result ?? null });
  if (Buffer.byteLength(reply) <= MAX_BUFFER_BYTES / 2) return reply;
  const row = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  if ('snapshot' in row) {
    const { snapshot: _snapshot, ...rest } = row;
    return JSON.stringify({ id, result: rest });
  }
  return JSON.stringify({ id, error: 'The reply is too large for the live connection' });
}

function procLoopbackPeerUid(ends: ConnectionEnds): number | null {
  const tables = ['/proc/net/tcp', '/proc/net/tcp6'].map((file) => {
    try { return readFileSync(file, 'utf8'); } catch { return ''; }
  });
  return loopbackPeerUid(tables, ends);
}
