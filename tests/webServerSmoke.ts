import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
import zlib from 'node:zlib';
import { WebSocket } from 'ws';
import { createApplication } from '../app/App';
import { WebServer, boundedReply } from '../app/Http/WebServer';
import { browserToolsOnly } from '../routes/application';
import { loopbackPeerUid, ServerAccess } from '../app/Http/ServerAccess';
import { acquireApplicationLock } from '../app/Runtime/ApplicationLock';
import { parseDamageFrame } from '../resources/js/terminal/TerminalRenderer';

const origin = 'http://patterm.test';

class Client {
  readonly frames: Array<ReturnType<typeof parseDamageFrame>> = [];
  readonly events: Array<{ event: string; payload: unknown }> = [];
  readonly controls = new Map<string, boolean>();
  readonly socket: WebSocket;
  private nextId = 0;
  private readonly pending = new Map<number, { resolve(result: unknown): void; reject(error: Error): void }>();

  constructor(url: string) {
    this.socket = new WebSocket(url, { origin });
    this.socket.on('message', (data, binary) => {
      if (binary) { this.frames.push(parseDamageFrame(new Uint8Array(data as Buffer))); return; }
      const message = JSON.parse(data.toString());
      if (message.event) this.events.push({ event: message.event, payload: message.payload });
      if (message.event === 'terminal-control') this.controls.set(message.payload.processId, message.payload.controlling);
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.result);
    });
  }

  request(operation: string, args: unknown): Promise<unknown> {
    return this.call(`patterm:terminal:${operation}`, args);
  }

  call(channel: string, args: unknown): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, channel, args }));
    });
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = once(this.socket, 'close');
    this.socket.close();
    await closed;
  }
}

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function main(): Promise<void> {
  // The desktop window's IPC is limited to the browser's tools.
  const desktopRoutes = new Map<string, (event: unknown, raw?: unknown) => unknown>();
  const desktop = browserToolsOnly({ handle: (channel, handler) => desktopRoutes.set(channel, handler), on: (channel, handler) => desktopRoutes.set(channel, handler) });
  desktop.handle('patterm:mcp:call', (_event, raw) => raw);
  desktop.handle('patterm:workbench:snapshot', () => 'snapshot');
  assert.deepEqual(desktopRoutes.get('patterm:mcp:call')!(null, { tool: 'project_list', arguments: {} }), { tool: 'project_list', arguments: {} });
  assert.throws(() => desktopRoutes.get('patterm:mcp:call')!(null, { tool: 'spawn_agent', arguments: {} }), /not available in the Patterm window/, 'agent-only tools are refused');
  assert.deepEqual(desktopRoutes.get('patterm:mcp:call')!(null, { tool: 'assistant_restart', arguments: { process_id: 'a' } }), { tool: 'assistant_restart', arguments: { process_id: 'a' } }, 'socket-only control tools work in the window');
  assert.equal(desktopRoutes.get('patterm:workbench:snapshot')!(null), 'snapshot', 'other channels are unchanged');
  // An oversized socket reply must not close the socket, or the browser
  // reconnects and asks for it again forever.
  const huge = 'x'.repeat(3 * 1024 * 1024);
  assert.deepEqual(JSON.parse(boundedReply(1, { ok: true, snapshot: { text: huge } })), { id: 1, result: { ok: true } });
  assert.equal(JSON.parse(boundedReply(2, { text: huge })).error, 'The reply is too large for the live connection');
  assert.deepEqual(JSON.parse(boundedReply(3, { ok: true, snapshot: {} })), { id: 3, result: { ok: true, snapshot: {} } });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-web-test-'));
  const lockDir = path.join(temp, 'lock');
  const release = acquireApplicationLock(lockDir);
  assert.throws(() => acquireApplicationLock(lockDir), /already using/);
  release();
  acquireApplicationLock(lockDir)();
  const rendererPath = path.join(temp, 'renderer');
  fs.mkdirSync(rendererPath);
  fs.writeFileSync(path.join(rendererPath, 'index.html'), '<!doctype html><html><head><title>Patterm</title><link href="./assets/app.css" rel="stylesheet"></head><body><script src="./assets/app.js"></script></body></html>');
  const appScript = `console.log(${JSON.stringify('patterm '.repeat(400))});\n`;
  fs.mkdirSync(path.join(rendererPath, 'assets'));
  fs.writeFileSync(path.join(rendererPath, 'assets', 'app.js'), appScript);
  const options = {
    appDataPath: path.join(temp, 'data'),
    sidecarPath: path.resolve('native/terminal-core/target/debug/patterm-terminal-core'),
    mcpShimPath: path.resolve('dist/mcp/patterm-mcp.js'),
    runtime: 'node' as const
  };
  await assert.rejects(createApplication({ ...options, sidecarPath: temp }), /EACCES|permission denied/i);
  acquireApplicationLock(options.appDataPath)();
  const app = await createApplication(options);
  const server = new WebServer(app, { port: 0, publicOrigin: origin, rendererPath, appDataPath: options.appDataPath });
  const clients: Client[] = [];
  try {
    await assert.rejects(createApplication(options), /already using/);
    const port = await server.start();
    const base = `http://127.0.0.1:${port}`;
    const rpc = async (channel: string, args?: unknown, requestOrigin = origin) => {
      return fetch(`${base}/api/rpc`, { method: 'POST', headers: { Origin: requestOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 1, channel, args }) });
    };
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.match(health.headers.get('content-security-policy') ?? '', /script-src 'self' 'wasm-unsafe-eval';/);
    assert.match(await (await fetch(base)).text(), /Patterm/);
    for (const route of ['/settings', '/usage', '/routines', '/routines/log', '/projects', '/projects/example', '/projects/example/agents/session', '/projects/example/processes/process', '/projects/example/worktrees', '/projects/example/agents/session/diffs', '/projects/example/history?conversation=one', '/projects/example/todos', '/projects/example/todos/todo-id', '/projects/example/scratchpads', '/projects/example/scratchpads/scratchpad-id', '/projects/example/media?session=one']) {
      const page = await fetch(`${base}${route}`);
      assert.equal(page.status, 200, route);
      assert.match(page.headers.get('content-type') ?? '', /text\/html/);
      const html = await page.text();
      assert.match(html, /href="\/assets\/app.css"/);
      assert.match(html, /src="\/assets\/app.js"/);
      assert.doesNotMatch(html, /<base\b/);
      assert.match(page.headers.get('content-security-policy') ?? '', /base-uri 'none'/);
      assert.equal((await fetch(`${base}${route}`, { method: 'HEAD' })).status, 200);
    }
    for (const missing of ['/assets/missing.js', '/api/missing', '/missing.css', '/projects/example/unknown']) {
      assert.equal((await fetch(`${base}${missing}`)).status, 404, missing);
    }
    assert.equal((await rpc('patterm:bootstrap', undefined, 'https://evil.example')).status, 403);
    const badHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      http.get(base, { headers: { Host: 'evil.example' } }, (response) => {
        response.resume(); resolve(response.statusCode);
      }).on('error', reject);
    });
    assert.equal(badHostStatus, 403);
    // Node's fetch overwrites Sec-Fetch-Mode, so send these with http.request.
    const crossSite = (method: string, mode: string, dest = 'document') => new Promise<number | undefined>((resolve, reject) => {
      http.request(base, { method, headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': mode, 'Sec-Fetch-Dest': dest } }, (response) => {
        response.resume(); resolve(response.statusCode);
      }).on('error', reject).end();
    });
    assert.equal(await crossSite('GET', 'navigate'), 200, 'Android PWA launches are cross-site navigations');
    assert.equal(await crossSite('GET', 'navigate', 'embed'), 403);
    assert.equal(await crossSite('GET', 'cors', 'empty'), 403);
    assert.equal(await crossSite('POST', 'navigate'), 403);
    // Other hosts pair with Node's fetch, which sends no Origin. Browsers
    // cannot reach the pairing route.
    const pairBody = JSON.stringify({ protocol_version: 1, code: 'ABCD-EFGH', host_id: `host_${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`, name: 'desktop' });
    const peer = await fetch(`${base}/api/peer/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: pairBody });
    assert.equal(peer.status, 400);
    assert.match((await peer.json() as { error: string }).error, /No pairing code is active/);
    assert.equal((await fetch(`${base}/api/peer/pair`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: pairBody })).status, 403);
    assert.equal((await rpc('patterm:mcp:call', { tool: 'hosts_code_create', arguments: {} })).status, 400, 'only a server with a public origin shows pairing codes');
    assert.equal((await rpc('patterm:mcp:call', { tool: 'hosts_get', arguments: {} })).status, 200);
    // Peer links need a credential, and browsers cannot open them.
    const linkStatus = (headers: Record<string, string>) => new Promise<number | undefined>((resolve) => {
      const attempt = new WebSocket(`ws://127.0.0.1:${port}/api/peer/link`, { headers });
      attempt.once('unexpected-response', (_request, response) => { resolve(response.statusCode); response.resume(); attempt.terminate(); });
      attempt.once('open', () => { resolve(101); attempt.terminate(); });
      attempt.once('error', () => undefined);
    });
    assert.equal(await linkStatus({}), 401);
    assert.equal(await linkStatus({ Authorization: 'Bearer ptp_unknown' }), 401);
    assert.equal(await linkStatus({ Origin: origin, Authorization: 'Bearer ptp_unknown' }), 403);
    // With an owner set, tailnet requests from anyone else are refused.
    const tailnet = new WebServer(app, { port: 0, publicOrigin: 'https://workstation.example.ts.net', rendererPath, appDataPath: options.appDataPath, ownerLogin: 'owner@example.com' });
    const tailnetPort = await tailnet.start();
    try {
      const status = (host: string, login?: string) => new Promise<number | undefined>((resolve, reject) => {
        http.get(`http://127.0.0.1:${tailnetPort}/health`, { headers: { Host: host, ...(login ? { 'Tailscale-User-Login': login } : {}) } }, (response) => {
          response.resume(); resolve(response.statusCode);
        }).on('error', reject);
      });
      assert.equal(await status('workstation.example.ts.net', 'owner@example.com'), 200);
      assert.equal(await status('workstation.example.ts.net', 'someone@example.com'), 403);
      assert.equal(await status('workstation.example.ts.net'), 200, 'tagged devices send no login and are left to the tailnet policy');
      const funnel = await new Promise<number | undefined>((resolve, reject) => {
        http.get(`http://127.0.0.1:${tailnetPort}/health`, { headers: { Host: 'workstation.example.ts.net', 'Tailscale-Funnel-Request': '?1' } }, (response) => {
          response.resume(); resolve(response.statusCode);
        }).on('error', reject);
      });
      assert.equal(funnel, 403, 'Funnel requests are always refused');
      assert.equal(await status(`127.0.0.1:${tailnetPort}`), 200, 'loopback requests skip the owner check');
    } finally {
      await tailnet.stop();
    }
    // Other accounts on this machine cannot connect to the loopback listener.
    const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
    const tcp = [header,
      '   0: 0100007F:2253 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0000000000000000 100 0 0 10 0',
      '   1: 0100007F:C350 0100007F:2253 01 00000000:00000000 00:00000000 00000000  1001        0 2 1 0000000000000000 20 4 30 10 -1',
      '   2: 0100007F:2253 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 3 1 0000000000000000 20 4 30 10 -1',
      '   3: 0200007F:C351 0100007F:2253 01 00000000:00000000 00:00000000 00000000  1002        0 4 1 0000000000000000 20 4 30 10 -1'
    ].join('\n');
    const tcp6 = [header,
      '   0: 0000000000000000FFFF00000100007F:C352 0000000000000000FFFF00000100007F:2253 01 00000000:00000000 00:00000000 00000000  1003        0 5 1 0000000000000000 20 4 30 10 -1'
    ].join('\n');
    const ends = (clientAddress: string, clientPort: number) => ({ clientAddress, clientPort, serverAddress: '127.0.0.1', serverPort: 0x2253 });
    assert.equal(loopbackPeerUid([tcp, tcp6], ends('127.0.0.1', 0xC350)), 1001, 'the client end of the connection names its owner');
    assert.equal(loopbackPeerUid([tcp, tcp6], ends('127.0.0.2', 0xC351)), 1002, 'other 127/8 sources are looked up too');
    assert.equal(loopbackPeerUid([tcp, tcp6], ends('::ffff:127.0.0.1', 0xC352)), 1003, 'IPv4-mapped clients are found in tcp6');
    assert.equal(loopbackPeerUid([tcp, tcp6], ends('127.0.0.2', 0xC350)), null, 'the whole address tuple must match');
    const foreign = new WebServer(app, { port: 0, publicOrigin: origin, rendererPath, appDataPath: options.appDataPath, loopbackPeerUid: () => 4242 });
    const foreignPort = await foreign.start();
    try {
      await assert.rejects(fetch(`http://127.0.0.1:${foreignPort}/health`), 'connections from another account are closed');
      const fromOtherLoopback = await new Promise<string>((resolve) => {
        http.get({ host: '127.0.0.1', port: foreignPort, path: '/health', localAddress: '127.0.0.2' }, (response) => { response.resume(); resolve(String(response.statusCode)); })
          .on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'));
      });
      assert.equal(fromOtherLoopback, 'ECONNRESET', 'choosing another loopback source address does not skip the check');
      const assigned = Object.values(os.networkInterfaces()).flat().find((entry) => entry && entry.family === 'IPv4' && !entry.internal)?.address;
      if (assigned) {
        const fromAssigned = await new Promise<string>((resolve) => {
          http.get({ host: '127.0.0.1', port: foreignPort, path: '/health', localAddress: assigned }, (response) => { response.resume(); resolve(String(response.statusCode)); })
            .on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'));
        });
        assert.equal(fromAssigned, 'ECONNRESET', 'a source address assigned to this machine does not skip the check either');
      }
    } finally {
      await foreign.stop();
    }
    // Simultaneous guesses count towards the limit, and a sign-in checked
    // against a password that changed meanwhile gets no cookie.
    const guarded = new ServerAccess(path.join(temp, 'guarded-access.json'));
    await guarded.setPassword('old password', null);
    const guesses = await Promise.allSettled(Array.from({ length: 16 }, () => guarded.signIn('wrong password')));
    assert.ok(guesses.filter((result) => result.status === 'rejected').length >= 6, 'at most ten guesses are checked at once');
    const racing = new ServerAccess(path.join(temp, 'racing-access.json'));
    await racing.setPassword('old password', null);
    const [stale, renewed] = await Promise.all([racing.signIn('old password'), racing.setPassword('new password', 'old password')]);
    assert.ok(renewed && racing.allows(`patterm_session=${renewed}`), 'the changing browser keeps a valid cookie');
    assert.ok(!stale || !racing.allows(`patterm_session=${stale}`), 'an old-password sign-in during a change never yields a valid cookie');

    // The optional password: /api and the live connection need a sign-in
    // cookie; pages and /health stay open.
    const post = (route: string, body: unknown, cookie?: string) => fetch(`${base}${route}`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body)
    });
    const session = async (cookie?: string) => (await fetch(`${base}/api/session`, { headers: cookie ? { Cookie: cookie } : {} })).json() as Promise<{ password_set: boolean; signed_in: boolean }>;
    assert.deepEqual(await session(), { password_set: false, signed_in: true, tailnet: false });
    assert.equal((await post('/api/access/password', { password: 'short' })).status, 400, 'passwords need at least 8 characters');
    const setPassword = await post('/api/access/password', { password: 'correct horse' });
    assert.equal(setPassword.status, 200);
    const firstCookie = (setPassword.headers.get('set-cookie') ?? '').split(';')[0]!;
    assert.match(setPassword.headers.get('set-cookie') ?? '', /^patterm_session=\d+\.[\w-]+; Path=\/; Max-Age=31536000; HttpOnly; SameSite=Strict$/);
    assert.equal(fs.statSync(path.join(options.appDataPath, 'server-access.json')).mode & 0o777, 0o600, 'the password file is private');
    assert.doesNotMatch(fs.readFileSync(path.join(options.appDataPath, 'server-access.json'), 'utf8'), /correct horse/, 'only a hash is stored');
    assert.deepEqual(await session(), { password_set: true, signed_in: false, tailnet: false });
    assert.equal((await rpc('patterm:bootstrap')).status, 401, 'API calls need a sign-in');
    assert.equal((await fetch(`${base}/health`)).status, 200, '/health stays open');
    assert.equal((await fetch(`${base}/settings`)).status, 200, 'pages stay open so the sign-in page can load');
    const unsignedSocket = new WebSocket(`ws://127.0.0.1:${port}/api/events`, { origin });
    unsignedSocket.on('error', () => {});
    assert.equal(await new Promise<number>((resolve) => unsignedSocket.on('unexpected-response', (_request, response) => {
      response.resume(); resolve(response.statusCode ?? 0); unsignedSocket.terminate();
    })), 403, 'the live connection needs a sign-in');
    assert.equal((await post('/api/login', { password: 'wrong password' })).status, 401);
    const signedIn = await post('/api/login', { password: 'correct horse' });
    assert.equal(signedIn.status, 200);
    const cookie = (signedIn.headers.get('set-cookie') ?? '').split(';')[0]!;
    assert.deepEqual(await session(cookie), { password_set: true, signed_in: true, tailnet: false });
    assert.equal((await fetch(`${base}/api/rpc`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ id: 1, channel: 'patterm:bootstrap' }) })).status, 200);
    assert.equal((await post('/api/login', { password: 'correct horse' }, undefined)).status, 200);
    assert.equal((await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'correct horse' }) })).status, 403, 'sign-in needs the page origin');
    assert.equal((await post('/api/access/password', { current: 'wrong password', password: 'another horse' }, cookie)).status, 400, 'changing the password needs the current one');
    // A live connection signed in with the old cookie is closed by a change.
    const liveSocket = new WebSocket(`ws://127.0.0.1:${port}/api/events`, { origin, headers: { Cookie: cookie } });
    await once(liveSocket, 'open');
    const liveClosed = once(liveSocket, 'close');
    const changed = await post('/api/access/password', { current: 'correct horse', password: 'another horse' }, cookie);
    assert.equal(changed.status, 200);
    assert.equal((await liveClosed)[0], 4001, 'connections using the old cookie are closed');
    assert.deepEqual(await session(cookie), { password_set: true, signed_in: false, tailnet: false }, 'a new password signs out every browser');
    assert.deepEqual(await session(firstCookie), { password_set: true, signed_in: false, tailnet: false });
    const changedCookie = (changed.headers.get('set-cookie') ?? '').split(';')[0]!;
    assert.equal((await session(changedCookie)).signed_in, true, 'the browser that changed it stays signed in');
    const removed = await post('/api/access/password', { current: 'another horse', password: null }, changedCookie);
    assert.equal(removed.status, 200);
    assert.match(removed.headers.get('set-cookie') ?? '', /Max-Age=0/);
    assert.deepEqual(await session(), { password_set: false, signed_in: true, tailnet: false });

    assert.equal((await rpc('patterm:terminal:input', { process_id: 'invalid', text: 'bad' })).status, 400);
    assert.equal((await rpc('patterm:mcp:call', { tool: 'patterm.call', arguments: { tool: 'send_input', arguments: {} } })).status, 400);
    assert.equal((await rpc('patterm:mcp:call', { tool: 'patterm.task.create', arguments: {} })).status, 400);
    const hostile = new WebSocket(`ws://127.0.0.1:${port}/api/events`, { origin: 'https://evil.example' });
    hostile.on('error', () => {});
    const [denied] = await new Promise<[number]>((resolve) => hostile.on('unexpected-response', (_request, response) => {
      response.resume(); resolve([response.statusCode ?? 0]); hostile.terminate();
    }));
    assert.equal(denied, 403);
    const connect = async () => {
      const client = new Client(`ws://127.0.0.1:${port}/api/events`);
      clients.push(client);
      await once(client.socket, 'open');
      return client;
    };
    const a = await connect();
    const b = await connect();
    // Larger replies and files are compressed for clients that accept it.
    const compressed = (pathname: string, encoding: string, body?: unknown) => new Promise<{ encoding: string | undefined; vary: string | undefined; body: Buffer }>((resolve, reject) => {
      const request = http.request(`${base}${pathname}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Origin: origin, 'Accept-Encoding': encoding, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({ encoding: response.headers['content-encoding'], vary: response.headers.vary, body: Buffer.concat(chunks) }));
      }).on('error', reject);
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const script = await compressed('/assets/app.js', 'gzip');
    assert.equal(script.encoding, 'gzip');
    assert.equal(script.vary, 'Accept-Encoding');
    assert.equal(zlib.gunzipSync(script.body).toString('utf8'), appScript);
    assert.equal((await compressed('/assets/app.js', 'identity')).body.toString('utf8'), appScript, 'clients that refuse compression get the file as it is');
    const project = await app.mcp.call('project_create', { path: temp }) as { project_id: string };
    for (let index = 0; index < 6; index++) {
      await app.mcp.call('process_create', { project_id: project.project_id, command: 'true', name: `history ${index}` });
    }
    const snapshotReply = await compressed('/api/rpc', 'br, gzip', { id: 1, channel: 'patterm:workbench:snapshot' });
    assert.equal(snapshotReply.encoding, 'br', 'large RPC replies prefer Brotli');
    const versioned = (JSON.parse(zlib.brotliDecompressSync(snapshotReply.body).toString('utf8')) as { result: { epoch: string; version: number; projects: Array<{ project: { id: string } }> } }).result;
    assert.equal(versioned.projects[0]?.project.id, project.project_id);
    // The short-lived processes keep publishing exits for a moment; catch up
    // until the server confirms this client is current.
    const since = { epoch: versioned.epoch, version: versioned.version };
    let currentReply: { current?: boolean; projects?: unknown; patches?: unknown[]; version: number } | undefined;
    for (let attempt = 0; attempt < 50 && !currentReply?.current; attempt++) {
      if (currentReply) await new Promise((resolve) => setTimeout(resolve, 50));
      currentReply = (await (await rpc('patterm:workbench:snapshot', since)).json() as { result: NonNullable<typeof currentReply> }).result;
      assert.equal(currentReply.projects, undefined, 'a client from this server run is never sent the whole snapshot again');
      since.version = currentReply.version;
    }
    assert.equal(currentReply?.current, true, 'a current client is told so instead of receiving data');
    const contextRpc = (tool: string, args: Record<string, unknown>) => rpc('patterm:mcp:call', {
      tool, arguments: { project_id: project.project_id, ...args }
    });
    const todoResponse = await contextRpc('todo_create', { title: 'Browser context' });
    assert.equal(todoResponse.status, 200);
    await until(() => a.events.some((event) => event.event === 'data-changed' && (event.payload as { topics: string[] }).topics.includes('context')), 'context change signal');
    // Patches up to the current version may still be on their way over the
    // socket; only a later one would come from the todo.
    const currentVersion = currentReply!.version;
    assert.ok(!a.events.some((event) => event.event === 'workbench-patch' && (event.payload as { to: number }).to > currentVersion), 'context writes publish no workbench patch');
    assert.ok(!a.events.some((event) => event.event === 'workbench-changed'), 'clients are never told to refetch the whole workbench');
    const browserTodo = (await todoResponse.json() as { result: { id: string; created_by_actor: string } }).result;
    const storedTodo = await app.mcp.call('todo_get', { project_id: project.project_id, todo_id: browserTodo.id }) as { title: string; created_by_actor: string };
    assert.equal(storedTodo.title, 'Browser context');
    assert.equal(storedTodo.created_by_actor, 'user');
    assert.equal((await contextRpc('todo_assign', { todo_id: browserTodo.id, actor_id: 'spoofed' })).status, 400);
    const noteResponse = await contextRpc('scratchpad_create', { title: 'Browser note', body: 'Shared context' });
    assert.equal(noteResponse.status, 200);
    const referenceResponse = await contextRpc('reference_attach', {
      target_type: 'todo', target_id: browserTodo.id, url: 'https://example.test/issues/1'
    });
    assert.equal(referenceResponse.status, 200);
    assert.equal((await contextRpc('reference_list', { target_type: 'todo', target_id: browserTodo.id })).status, 200);
    const launch = async () => app.mcp.call('process_create', {
      project_id: project.project_id, command: "exec /bin/sh -c 'printf \"ready\\n\"; while IFS= read -r line; do printf \"echo:%s\\n\" \"$line\"; done'"
    }) as Promise<{ process_id: string; pty_process_id: string }>;
    const first = await launch();
    const second = await launch();
    await until(() => a.events.some((event) => event.event === 'workbench-patch'
      && JSON.stringify(event.payload).includes(second.process_id)), 'workbench patch for a launched process');
    const launchPatches = a.events.filter((event) => event.event === 'workbench-patch').map((event) => event.payload as { epoch: string; from: number; to: number });
    assert.ok(launchPatches.every((patch, index) => index === 0 || patch.from === launchPatches[index - 1]!.to), 'patches are consecutive');
    assert.equal(launchPatches[0]?.epoch, since.epoch);
    const catchUp = await (await rpc('patterm:workbench:snapshot', since)).json() as { result: { patches?: Array<{ from: number }>; version: number } };
    assert.equal(catchUp.result.patches?.[0]?.from, since.version, 'a client behind by a few changes receives the patches it missed');
    assert.ok(catchUp.result.version >= launchPatches.at(-1)!.to, 'catching up reaches at least the latest published patch');
    const firstId = first.pty_process_id;
    const secondId = second.pty_process_id;
    await a.request('subscribe', { process_id: firstId, subscribed: true });
    await b.request('subscribe', { process_id: secondId, subscribed: true });
    await a.request('refresh', { process_id: firstId });
    await b.request('refresh', { process_id: secondId });
    await until(() => a.frames.length > 0 && b.frames.length > 0, 'independent terminal frames');
    assert(a.frames.every((frame) => frame?.processId === firstId));
    assert(b.frames.every((frame) => frame?.processId === secondId));
    await b.request('subscribe', { process_id: firstId, subscribed: true });
    await assert.rejects(b.request('input', { process_id: firstId, text: 'not-owner\n' }), /Take control/);
    // Restarting the assistant needs control of it, like sending it a message,
    // so plain HTTP calls cannot reach it.
    await assert.rejects(b.call('patterm:integrated:call', { tool: 'assistant_restart', arguments: { process_id: firstId } }), /Take control/);
    await assert.rejects(b.call('patterm:integrated:call', { tool: 'assistant_new', arguments: { process_id: firstId } }), /Take control/);
    assert.match((await (await rpc('patterm:mcp:call', { tool: 'assistant_new', arguments: { process_id: firstId } })).json() as { error: string }).error, /not available through the browser/);
    assert.match((await (await rpc('patterm:mcp:call', { tool: 'assistant_restart', arguments: { process_id: firstId } })).json() as { error: string }).error, /not available through the browser/);
    await assert.rejects(a.request('resize', { process_id: firstId, cols: 1e9, rows: 20 }), /1000/);
    await a.request('resize', { process_id: firstId, cols: 90, rows: 30, resize_seq: 50 });
    await b.request('take-control', { process_id: firstId });
    await assert.rejects(a.request('input', { process_id: firstId, text: 'lost-owner\n' }), /Take control/);
    await b.request('resize', { process_id: firstId, cols: 80, rows: 24, resize_seq: 1 });
    await b.request('input', { process_id: firstId, text: 'persisted\n' });
    await until(async () => {
      const output = await b.request('output', { process_id: firstId }) as { screen: string };
      return output.screen.includes('echo:persisted');
    }, 'shell input');
    await a.close();
    await b.close();
    const c = await connect();
    await c.request('subscribe', { process_id: firstId, subscribed: true });
    await c.request('take-control', { process_id: firstId });
    await c.request('refresh', { process_id: firstId });
    const output = await c.request('output', { process_id: firstId }) as { status: string; screen: string };
    assert.match(output.screen, /echo:persisted/);
    assert.equal(output.status, 'running');
    await until(() => c.frames.some((frame) => frame?.frameKind === 'snapshot'), 'reconnect snapshot');
    assert(c.frames.some((frame) => frame && frame.resizeSeq > 50), 'resize sequence must survive transfer');

    // A tab switch clears the renderer and sets a new resize target, even when
    // the returning terminal already has the requested dimensions.
    const parentEpoch = [...c.frames].reverse().find((frame) => frame?.processId === firstId)?.epoch;
    await c.request('subscribe', { process_id: firstId, subscribed: false });
    await c.request('subscribe', { process_id: secondId, subscribed: true });
    await c.request('resize', { process_id: secondId, cols: 80, rows: 24, resize_seq: 60 });
    await until(() => c.frames.some((frame) => frame?.processId === secondId && frame.resizeSeq === 60), 'child tab snapshot');
    await c.request('subscribe', { process_id: secondId, subscribed: false });
    await c.request('subscribe', { process_id: firstId, subscribed: true });
    await c.request('refresh', { process_id: firstId });
    await c.request('resize', { process_id: firstId, cols: 80, rows: 24, resize_seq: 61 });
    await until(() => c.frames.some((frame) => frame?.processId === firstId && frame.frameKind === 'snapshot' && frame.resizeSeq === 61), 'returning parent snapshot acknowledges unchanged-size resize');
    const restored = [...c.frames].reverse().find((frame) => frame?.processId === firstId && frame.resizeSeq === 61)!;
    assert.equal(restored.epoch, parentEpoch, 'an unchanged-size resize preserves the terminal grid epoch');
    assert.match(restored.runs.flatMap((run) => run.cells.map((cell) => cell.char)).join(''), /echo:persisted/, 'the returning parent snapshot restores existing output');
    await c.request('input', { process_id: firstId, text: 'after-switch\n' });
    await until(() => c.frames.some((frame) => frame?.processId === firstId && frame.frameKind === 'damage' && frame.resizeSeq === 61), 'parent output continues with the acknowledged resize sequence');
    // A browser that sends its size with the subscription becomes the
    // controller and receives one snapshot already at that size.
    const sized = await connect();
    const sizedReply = await sized.request('subscribe', { process_id: secondId, subscribed: true, cols: 70, rows: 20, resize_seq: 90 }) as { controlling: boolean; resized?: boolean };
    assert.deepEqual([sizedReply.controlling, sizedReply.resized], [true, true]);
    await until(() => sized.frames.some((frame) => frame?.processId === secondId && frame.frameKind === 'snapshot'), 'sized subscription snapshot');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const sizedSnapshots = sized.frames.filter((frame) => frame?.processId === secondId && frame.frameKind === 'snapshot');
    assert.equal(sizedSnapshots.length, 1, 'the size and the subscription produce a single snapshot');
    assert.deepEqual([sizedSnapshots[0]!.cols, sizedSnapshots[0]!.rows], [70, 20]);
    assert.ok(sizedSnapshots[0]!.resizeSeq >= 90, 'the snapshot acknowledges the requested resize sequence');
    const viewer = await connect();
    const viewerReply = await viewer.request('subscribe', { process_id: secondId, subscribed: true, cols: 100, rows: 40, resize_seq: 200 }) as { controlling: boolean; resized?: boolean };
    assert.deepEqual([viewerReply.controlling, viewerReply.resized], [false, undefined], 'a viewer cannot resize through its subscription');
    await until(() => viewer.frames.some((frame) => frame?.processId === secondId && frame.frameKind === 'snapshot'), 'viewer snapshot');
    const viewed = viewer.frames.find((frame) => frame?.processId === secondId && frame.frameKind === 'snapshot')!;
    assert.deepEqual([viewed.cols, viewed.rows], [70, 20], 'the viewer sees the controller size');
    await viewer.close();
    await sized.close();
    const upload = await fetch(`${base}/api/upload?name=../../clip.png`, { method: 'POST', headers: { Origin: origin }, body: 'image-fixture' });
    assert.equal(upload.status, 200);
    const uploaded = await upload.json() as { path: string };
    assert.equal(path.dirname(uploaded.path), path.join(options.appDataPath, 'uploads'));
    assert.equal(fs.readFileSync(uploaded.path, 'utf8'), 'image-fixture');
    assert.equal(fs.statSync(uploaded.path).mode & 0o777, 0o600);
    const overloaded = await connect();
    const overloadClosed = once(overloaded.socket, 'close');
    for (let id = 1; id <= 140; id++) overloaded.socket.send(JSON.stringify({ id, channel: 'patterm:terminal:output', args: { process_id: firstId } }));
    await overloadClosed;
    // Imports go through the app's queue, which runs the Node worker one job at
    // a time; a worker launched beside it would race the startup import.
    const job = await app.mcp.call('history_import', { trigger: 'manual' }) as { job_id: string };
    const importJob = async () => (await app.mcp.call('history_import_status', {}) as { queue: { recent: Array<{ id: string; status: string; error: string | null }> } })
      .queue.recent.find((recent) => recent.id === job.job_id);
    const importDeadline = Date.now() + 20_000;
    while (!await importJob() && Date.now() < importDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
    const imported = await importJob();
    assert.deepEqual([imported?.status, imported?.error], ['succeeded', null], 'the Node history worker imports');
    await app.mcp.call('stop_process', { process_id: first.process_id });
    await app.mcp.call('stop_process', { process_id: second.process_id });
    console.log(`web server smoke passed: two clients, reconnect, control transfer, origin validation, uploads, Node worker (${c.frames.length} reconnect frames)`);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await server.stop();
    await app.dispose();
    acquireApplicationLock(options.appDataPath)();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

const deadline = setTimeout(() => { console.error('web server smoke timed out'); process.exit(1); }, 45_000);
void main().then(() => clearTimeout(deadline)).catch((error) => { console.error(error); process.exit(1); });
