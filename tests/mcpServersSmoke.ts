import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { buildSync } from 'esbuild';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { McpServerActions } from '../app/Actions/McpServerActions';
import { harnessProviders } from '../app/Harness/providers';
import { claudeMcpServers, codexMcpOverrides, codexMcpStartupNotice, headersHelperCommand, openCodeMcpConfigs } from '../app/Harness/McpDelivery';
import { McpHelperAccess, MCP_HELPER_CUTOVER_KEY } from '../app/MCP/McpHelperAccess';
import { McpSocketServer } from '../app/MCP/McpSocketServer';
import { McpToolRegistry } from '../app/MCP/ToolRegistry';
import { DatabaseService } from '../app/Services/DatabaseService';
import { McpOAuthService } from '../app/Services/McpOAuthService';
import { McpServerImportService } from '../app/Services/McpServerImportService';
import { McpServerRegistry } from '../app/Services/McpServerRegistry';
import { McpHttpProxyService } from '../app/Services/McpHttpProxyService';
import { NativeOAuthCallbackService } from '../app/Services/NativeOAuthCallbackService';

// A minimal authorization server and MCP server: discovery, dynamic client
// registration, PKCE, rotating refresh tokens, and a tools/list endpoint that
// requires the current access token.
async function startFakeService() {
  const state = { registrations: 0, refreshes: 0, access: 'at-1', refresh: 'rt-1', challenges: new Map<string, string>(), redirects: [] as string[], tokenGate: null as Promise<void> | null };
  let base = '';
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', base);
    const body = await new Promise<string>((resolve) => { let data = ''; request.on('data', (chunk) => { data += chunk; }); request.on('end', () => resolve(data)); });
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      response.end(JSON.stringify(value));
    };
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json(200, {
        issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`,
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none']
      });
    }
    if (url.pathname === '/register' && request.method === 'POST') {
      state.registrations += 1;
      const metadata = JSON.parse(body) as { redirect_uris: string[] };
      state.redirects.push(...metadata.redirect_uris);
      return json(201, { ...metadata, client_id: `client-${state.registrations}` });
    }
    if (url.pathname === '/authorize') {
      const code = `code-${state.challenges.size + 1}`;
      state.challenges.set(code, url.searchParams.get('code_challenge') ?? '');
      const redirect = new URL(url.searchParams.get('redirect_uri')!);
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', url.searchParams.get('state') ?? '');
      response.writeHead(302, { Location: redirect.href });
      response.end();
      return;
    }
    if (url.pathname === '/token' && request.method === 'POST') {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'authorization_code') {
        const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
        if (state.challenges.get(form.get('code') ?? '') !== challenge) return json(400, { error: 'invalid_grant' });
        return json(200, { access_token: state.access, refresh_token: state.refresh, expires_in: 3600, token_type: 'Bearer' });
      }
      if (form.get('grant_type') === 'refresh_token') {
        if (form.get('refresh_token') !== state.refresh) return json(400, { error: 'invalid_grant' });
        await state.tokenGate;
        state.refreshes += 1;
        state.access = `at-${state.refreshes + 1}`;
        state.refresh = `rt-${state.refreshes + 1}`;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return json(200, { access_token: state.access, refresh_token: state.refresh, expires_in: 3600, token_type: 'Bearer' });
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (url.pathname === '/mcp') {
      if (request.headers.authorization !== `Bearer ${state.access}`) {
        return json(401, { error: 'invalid_token' }, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
      }
      if (request.method !== 'POST') { response.writeHead(405).end(); return; }
      const message = JSON.parse(body) as { id?: number; method: string; params?: { protocolVersion?: string } };
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      if (message.method === 'initialize') {
        return json(200, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
      }
      if (message.method === 'tools/list') return json(200, { jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } });
      if (message.method === 'tools/call') return json(200, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(message.params) }] } });
      return json(200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
    }
    json(404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, state, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function authorize(authorizationUrl: string): Promise<string> {
  const response = await fetch(authorizationUrl, { redirect: 'manual' });
  assert.equal(response.status, 302);
  return response.headers.get('location')!;
}

// Optional native compatibility check, without an LLM call or real credentials.
// PATTERM_TEST_CODEX=/path/to/codex node dist/tests/tests/mcpServersSmoke.js
async function nativeCodexTools(executable: string, home: string, overrides: string[], env: NodeJS.ProcessEnv): Promise<Record<string, unknown>[]> {
  const child = spawn(executable, [...overrides.flatMap((entry) => ['-c', entry]), 'app-server', '--listen', 'stdio://'], {
    cwd: home, env: { ...process.env, ...env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe']
  });
  let sequence = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
    const request = message.id === undefined ? undefined : pending.get(message.id);
    if (request) {
      pending.delete(message.id!);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    }
  });
  child.stderr.resume();
  const rejectPending = (error: Error) => { for (const request of pending.values()) request.reject(error); };
  child.on('error', rejectPending);
  child.on('exit', () => rejectPending(new Error('Native Codex exited')));
  const deadline = setTimeout(() => { rejectPending(new Error('Native Codex MCP probe timed out')); child.kill('SIGKILL'); }, 20_000);
  const rpc = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  try {
    await rpc('initialize', { clientInfo: { name: 'patterm-mcp-test', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
    const response = await rpc('mcpServerStatus/list', {}) as { data: Record<string, unknown>[] };
    return response.data;
  } finally {
    clearTimeout(deadline);
    lines.close();
    child.stdin.end();
    child.kill();
  }
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-mcp-servers-'));
  const database = new DatabaseService(dir);
  const service = await startFakeService();
  const cleanups: Array<() => unknown> = [];
  try {
    database.initialize();
    const registry = new McpServerRegistry(database);

    // Registry validation.
    assert.throws(() => registry.save({ name: 'patterm', transport: 'stdio', command: 'x' }), /reserved/);
    assert.throws(() => registry.save({ name: 'bad name', transport: 'stdio', command: 'x' }), /letters/);
    assert.throws(() => registry.save({ name: 'x', transport: 'http', url: 'ftp://example.com' }), /http/);
    const local = registry.save({ name: 'railway', transport: 'stdio', command: 'railway', args: ['mcp'], env: { RAILWAY_TOKEN: 'secret' }, harnesses: ['claude', 'codex'] });
    const remote = registry.save({ name: 'linear-acme', transport: 'http', url: `${service.base}/mcp` });
    const open = registry.save({ name: 'open', transport: 'http', url: 'https://example.com/mcp', auth: 'none' });
    assert.throws(() => registry.save({ name: 'LINEAR-ACME', transport: 'stdio', command: 'x' }), /already exists/);
    assert.deepEqual(registry.forHarness('codex').map((server) => server.name), ['linear-acme', 'open', 'railway']);
    assert.equal(registry.forHarness('codex').find((server) => server.name === 'open')?.transport === 'http' && (registry.forHarness('codex').find((server) => server.name === 'open') as { managedHeaders: boolean }).managedHeaders, false);

    // Delivery: secrets never appear in configs or arguments for remote servers.
    const patterm = { httpProxyUrl: 'http://127.0.0.1:12345', command: '/usr/bin/node', args: ['/opt/patterm/shim.js'], env: { ELECTRON_RUN_AS_NODE: '1', PATTERM_MCP_SOCKET: '/tmp/p.sock', PATTERM_MCP_IDENTITY: 'mcp_1' } };
    const servers = registry.forHarness('codex');
    const claude = claudeMcpServers(servers, patterm) as Record<string, Record<string, unknown>>;
    assert.deepEqual(claude['linear-acme'], {
      command: patterm.command, args: [...patterm.args, '--mcp-bridge', remote.id], env: patterm.env
    });
    assert.deepEqual((claude.open!.args as string[]).slice(-2), ['--mcp-bridge', open.id]);
    assert.deepEqual(claude.railway, { command: 'railway', args: ['mcp'], env: { RAILWAY_TOKEN: 'secret' } });
    const codex = codexMcpOverrides(servers, patterm);
    assert.ok(codex.includes(`mcp_servers.linear-acme.url="${patterm.httpProxyUrl}/${remote.id}"`));
    assert.ok(codex.some((value) => value.startsWith('mcp_servers.linear-acme.http_headers_helper=')));
    assert.ok(codex.includes(`mcp_servers.railway.args=["/opt/patterm/shim.js", "--mcp-exec", "${local.id}"]`), 'Codex runs environments through the exec bridge');
    assert.ok(!codex.join(' ').includes('secret'), 'secrets stay out of Codex arguments');
    assert.ok(codex.includes('mcp_servers.linear-acme.bearer_token_env_var="PATTERM_MCP_PROXY"'));
    assert.ok(codex.join(' ').includes('--mcp-proxy-headers'));
    const linear = servers.find((server) => server.name === 'linear-acme')!;
    for (const error of ['failed to refresh OAuth tokens: invalid_grant', 'requires OAuth reauthentication. Run codex mcp login linear-acme.', 'not logged in']) {
      const notice = codexMcpStartupNotice(linear, error);
      assert.match(notice.body, /Patterm.*MCP server settings/);
      assert.doesNotMatch(notice.body, /codex mcp (login|logout)/);
    }
    const missing = codexMcpStartupNotice(servers.find((server) => server.name === 'railway')!, 'No such file or directory (os error 2)');
    assert.doesNotMatch(missing.body, /saved login/, 'other failures carry no login advice');
    const openCode = openCodeMcpConfigs(registry.forHarness('opencode'), patterm);
    assert.deepEqual(openCode['linear-acme']!.command, ['/usr/bin/node', '/opt/patterm/shim.js', '--mcp-bridge', remote.id]);
    assert.equal(openCode.open!.type, 'remote');

    // Launch plans add the servers and keep Patterm's own server authoritative.
    const runtimeDir = path.join(dir, 'runtime');
    const provider = (id: string) => harnessProviders.find((candidate) => candidate.id === id)!;
    const claudePlan = provider('claude').buildLaunch({ executablePath: 'claude', mcp: patterm, mcpServers: servers, runtimeDir });
    const claudeConfig = JSON.parse(claudePlan.files[0]!.contents) as { mcpServers: Record<string, unknown> };
    assert.deepEqual(Object.keys(claudeConfig.mcpServers), ['linear-acme', 'open', 'railway', 'patterm']);
    const codexPlan = provider('codex').buildLaunch({ executablePath: 'codex', mcp: patterm, mcpServers: servers, runtimeDir });
    assert.ok(codexPlan.args.includes('mcp_servers.linear-acme.enabled=true'));

    // Sign-in through a loopback redirect, completed by paste.
    let clock = Date.parse('2026-09-30T10:00:00.000Z');
    let changes = 0;
    const oauth = new McpOAuthService(database, registry, { now: () => clock, onChanged: () => { changes += 1; } });
    cleanups.push(() => oauth.dispose());
    assert.deepEqual(await oauth.headers(remote.id), {}, 'no token yet: requests go out unauthenticated');
    const start = await oauth.startSignIn(remote.id);
    assert.equal(start.loopback, true);
    assert.match(start.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    assert.equal(oauth.status(remote.id).pending?.redirect_uri, start.redirect_uri);
    const callback = await authorize(start.authorization_url!);
    assert.equal(oauth.matches(callback), true);
    await assert.rejects(oauth.completeSignIn(callback.replace(/state=[^&]+/, 'state=forged')), /does not belong/);
    const done = await oauth.completeSignIn(callback.replace('127.0.0.1', 'localhost'));
    assert.equal(done.name, 'linear-acme');
    assert.ok(changes > 0);
    assert.equal(oauth.status(remote.id).signed_in, true);
    assert.equal(oauth.status(remote.id).pending, null);
    await assert.rejects(oauth.completeSignIn(callback), /does not belong/, 'a code is used once');
    assert.deepEqual(await oauth.headers(remote.id), { Authorization: 'Bearer at-1' });

    // Expired tokens refresh once, however many requests arrive together.
    clock += 3600_000;
    const concurrent = await Promise.all([oauth.headers(remote.id), oauth.headers(remote.id), oauth.headers(remote.id)]);
    assert.equal(service.state.refreshes, 1);
    for (const headers of concurrent) assert.equal(headers.Authorization, 'Bearer at-2');
    // A token the server refused is refreshed even before it expires.
    assert.equal((await oauth.headers(remote.id, 'at-2')).Authorization, 'Bearer at-3');
    assert.equal((await oauth.headers(remote.id, 'stale-token')).Authorization, 'Bearer at-3', 'an older rejected token does not refresh again');
    assert.equal(service.state.refreshes, 2);

    // A second sign-in reuses the loopback registration; the desktop listener
    // completes the redirect with no paste.
    const again = await oauth.startSignIn(remote.id);
    assert.equal(again.redirect_uri, start.redirect_uri, 'the loopback port is reused');
    assert.equal(service.state.registrations, 1, 'the registration for this redirect is reused');
    const page = await fetch(await authorize(again.authorization_url!));
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Signed in to linear-acme/);
    assert.equal(oauth.status(remote.id).signed_in, true);

    // The browser server redirects to its own origin instead.
    const originOAuth = new McpOAuthService(database, registry, { publicOrigin: 'https://box.example.ts.net', now: () => clock });
    cleanups.push(() => originOAuth.dispose());
    const viaOrigin = await originOAuth.startSignIn(remote.id);
    assert.equal(viaOrigin.redirect_uri, 'https://box.example.ts.net/oauth/mcp/callback');
    assert.equal(viaOrigin.loopback, false);
    assert.equal(service.state.registrations, 2, 'a new redirect registers again');
    const originCallback = await authorize(viaOrigin.authorization_url!);
    const failed = await originOAuth.callbackPage(originCallback.replace(/code=[^&]+/, 'code=wrong'));
    assert.equal(failed.status, 400);
    const fallback = await originOAuth.startSignIn(remote.id, 'loopback');
    assert.equal(fallback.loopback, true, 'the paste fallback uses a loopback redirect');
    const denied = new URL(fallback.redirect_uri);
    denied.searchParams.set('error', 'access_denied');
    denied.searchParams.set('state', new URL(fallback.authorization_url!).searchParams.get('state')!);
    await assert.rejects(originOAuth.completeSignIn(denied.href), /did not complete the sign-in: access_denied/);

    // Changing the endpoint forgets the tokens.
    registry.save({ id: remote.id, name: 'linear-acme', transport: 'http', url: `${service.base}/mcp?v=2` });
    assert.equal(oauth.status(remote.id).signed_in, false);
    registry.save({ id: remote.id, name: 'linear-acme', transport: 'http', url: `${service.base}/mcp` });
    await oauth.completeSignIn(await authorize((await oauth.startSignIn(remote.id)).authorization_url!));

    // Native sign-ins: replay only callbacks for authorize URLs seen by the
    // xdg-open shim, to the port and path they named.
    const received: string[] = [];
    const listener = http.createServer((request, response) => { received.push(`${request.headers.host} ${request.url}`); response.end('ok'); });
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => listener.close());
    const port = (listener.address() as AddressInfo).port;
    let now = 0;
    const native = new NativeOAuthCallbackService(() => now);
    native.observe(`https://auth.example.com/authorize?response_type=code&state=abc&redirect_uri=${encodeURIComponent(`http://localhost:${port}/callback`)}`);
    native.observe(`https://example.com/?state=zzz&redirect_uri=${encodeURIComponent('http://localhost:1/callback')}`);
    assert.equal(native.matches(`http://localhost:${port}/callback?code=c&state=abc`), true);
    assert.equal(native.matches(`http://localhost:${port + 1}/callback?code=c&state=abc`), false, 'other ports are refused');
    assert.equal(native.matches(`http://localhost:${port}/other?code=c&state=abc`), false, 'other paths are refused');
    assert.equal(native.matches('http://localhost:1/callback?code=c&state=zzz'), false, 'only authorization-code URLs are recorded');
    assert.equal(native.matches(`http://localhost:${port}/callback?state=abc`), false, 'a callback carries a code or an error');
    await native.replay(`http://localhost:${port}/callback?code=c&state=abc`);
    assert.deepEqual(received, [`localhost:${port} /callback?code=c&state=abc`]);
    await assert.rejects(native.replay(`http://localhost:${port}/callback?code=c&state=abc`), /does not belong/, 'a callback is replayed once');
    native.observe(`https://auth.example.com/authorize?response_type=code&state=late&redirect_uri=${encodeURIComponent(`http://127.0.0.1:${port}/cb`)}`);
    now += 11 * 60_000;
    assert.equal(native.matches(`http://127.0.0.1:${port}/cb?code=c&state=late`), false, 'recorded sign-ins expire');

    // Import from each harness's own configuration.
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
      mcpServers: { railway: { command: 'railway', args: ['mcp'] }, posthog: { type: 'http', url: 'https://mcp.posthog.com/mcp' }, legacy: { type: 'sse', url: 'https://example.com/sse' } },
      projects: { '/work/app': { mcpServers: { cloudflare: { type: 'http', url: 'https://cf.example.com/mcp' } } } }
    }));
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), [
      '[mcp_servers.posthog]', 'url = "https://mcp.posthog.com/mcp"', '',
      '[mcp_servers.clickhouse]', 'url = "https://mcp.clickhouse.cloud/mcp"', 'bearer_token_env_var = "CLICKHOUSE_TOKEN"', '',
      '[mcp_servers.tool]', 'command = "npx"', 'args = ["-y", "tool"]', 'env_vars = ["TOOL_KEY"]', ''
    ].join('\n'));
    fs.writeFileSync(path.join(home, '.config', 'opencode', 'opencode.json'), `{
      // OpenCode 2 nests servers; the legacy form is still read.
      "mcp": { "servers": { "posthog": { "type": "remote", "url": "https://other.example.com/mcp" } }, "local": { "type": "local", "command": ["run", "it"], "environment": { "A": "1" } } }
    }`);
    const importer = new McpServerImportService(registry, { home, env: { CLICKHOUSE_TOKEN: 'ch-token', TOOL_KEY: 'k' } });
    const imported = importer.import();
    assert.deepEqual(imported.added.map((entry) => entry.name).sort(), ['clickhouse', 'local', 'posthog', 'tool']);
    assert.deepEqual(imported.added.find((entry) => entry.name === 'posthog')?.from, ['claude', 'codex']);
    const reasons = Object.fromEntries(imported.skipped.map((entry) => [`${entry.harness}:${entry.name}`, entry.reason]));
    assert.match(reasons['claude:cloudflare']!, /Only configured for \/work\/app/);
    assert.match(reasons['claude:legacy']!, /SSE/);
    assert.match(reasons['opencode:posthog']!, /Differs from the claude definition/);
    assert.match(reasons['null:railway']!, /Already in Patterm/);
    const clickhouse = registry.findByName('clickhouse');
    assert.ok(clickhouse?.transport === 'http' && clickhouse.auth === 'none' && clickhouse.headers.Authorization === 'Bearer ch-token');
    const tool = registry.findByName('tool');
    assert.ok(tool?.transport === 'stdio' && tool.env.TOOL_KEY === 'k');
    assert.deepEqual(importer.import().added, [], 'importing again adds nothing');

    // Settings actions: test connections and complete pasted callbacks.
    const actions = new McpServerActions(registry, oauth, importer, native, { redirectsToOrigin: false });
    const tested = await actions.test({ id: remote.id });
    assert.equal(tested.error, null);
    assert.deepEqual(tested.tools, ['echo']);
    const unreachable = registry.save({ name: 'missing', transport: 'stdio', command: path.join(dir, 'no-such-command') });
    assert.equal((await actions.test({ id: unreachable.id })).ok, false);
    assert.deepEqual(await actions.pasteCallback({ url: 'https://example.com/' }), { handled: false });
    // Helpers get only enabled servers assigned to their agent's harness.
    const stamp = new Date().toISOString();
    database.connection.prepare(`insert into projects (id, name, path, created_at, updated_at) values ('project_1', 'p', ?, ?, ?)`).run(dir, stamp, stamp);
    const agent = (identity: string, harness: string, startedAt = stamp, exitedAt: string | null = null) => database.connection.prepare(
      `insert into sessions (id, project_id, mcp_identity, harness, session_role, resume_status, started_at, exited_at) values (?, 'project_1', ?, ?, 'orchestrator', 'unknown', ?, ?)`
    ).run(`session_${identity}`, identity, harness, startedAt, exitedAt);
    agent('mcp_claude', 'claude');
    agent('mcp_codex', 'codex');
    agent('mcp_opencode', 'opencode');
    agent('mcp_gone', 'claude', stamp, stamp);
    const access = new McpHelperAccess(database, (token) => token === 'bridge-token');
    const handlers = actions.socketHandlers(access);
    const proxyState = path.join(dir, 'mcp-proxy.json');
    let proxy = new McpHttpProxyService(proxyState, handlers);
    await proxy.start();
    cleanups.push(() => proxy.stop());
    handlers.proxyHeaders = (server, caller) => proxy.headers(server, caller);
    const as = (identity: string | null, opencodeBridge?: unknown) => ({ identity, opencodeBridge });
    assert.deepEqual(handlers.exec(local.id, as('mcp_claude')), { command: 'railway', args: ['mcp'], env: { RAILWAY_TOKEN: 'secret' } });
    assert.throws(() => handlers.exec(local.id, as('mcp_opencode')), /not enabled for this agent/, 'servers not assigned to the harness are refused');
    assert.throws(() => handlers.exec(local.id, as('mcp_gone')), /Unknown or inactive agent identity/, 'exited agents are refused');
    assert.throws(() => handlers.exec(local.id, as('mcp_unknown')), /Unknown or inactive agent identity/);
    assert.throws(() => handlers.exec(local.id, as(null, 'bridge-token')), /not enabled for this agent/, 'OpenCode helpers act for the opencode harness');
    assert.throws(() => handlers.exec(local.id, as(null, 'forged')), /Invalid OpenCode bridge identity/);
    // Helpers without an identity work only while agents from before the cutover run.
    const cutover = (database.connection.prepare(`select value from settings where key = ?`).get(MCP_HELPER_CUTOVER_KEY) as { value: string }).value;
    assert.throws(() => handlers.exec(local.id, as(null)), /no Patterm agent identity/);
    agent('mcp_earlier', 'codex', new Date(Date.parse(cutover) - 60_000).toISOString());
    assert.equal(handlers.exec(local.id, as(null)).command, 'railway', 'earlier agents keep their helpers until they exit');
    database.connection.prepare(`update sessions set exited_at = ? where mcp_identity = 'mcp_earlier'`).run(stamp);
    assert.throws(() => handlers.exec(local.id, as(null)), /no Patterm agent identity/);
    const railway = { id: local.id, name: 'railway', transport: 'stdio', command: 'railway', args: ['mcp'], env: { RAILWAY_TOKEN: 'secret' }, harnesses: ['claude', 'codex'] };
    registry.save({ ...railway, enabled: false });
    assert.throws(() => handlers.exec(local.id, as('mcp_claude')), /not enabled for this agent/, 'disabled servers are refused');
    registry.save({ ...railway, enabled: true });

    // The shim's header helper and stdio bridge, end to end.
    const shim = path.join(dir, 'shim.cjs');
    buildSync({ entryPoints: ['mcp/shim.ts'], outfile: shim, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
    const socketPath = path.join(dir, 'mcp.sock');
    const socket = new McpSocketServer(socketPath, new McpToolRegistry(), undefined, undefined, undefined, handlers);
    await socket.start();
    cleanups.push(() => socket.stop());
    const env = { ...process.env, PATTERM_MCP_SOCKET: socketPath, PATTERM_MCP_IDENTITY: 'mcp_claude' } as Record<string, string>;
    // Asynchronous: the socket server answering the helper runs in this process.
    const { execFile } = await import('node:child_process');
    const output = await new Promise<string>((resolve, reject) => execFile(process.execPath, [shim, '--mcp-headers', remote.id], { env, encoding: 'utf8', timeout: 10_000 },
      (error, stdout) => error ? reject(error) : resolve(stdout)));
    const helper = JSON.parse(output) as Record<string, string>;
    assert.equal(helper.Authorization, `Bearer ${service.state.access}`);
    const proxyOutput = await new Promise<string>((resolve, reject) => execFile(process.execPath, [shim, '--mcp-proxy-headers', remote.id], { env, encoding: 'utf8', timeout: 10_000 },
      (error, stdout) => error ? reject(error) : resolve(stdout)));
    const proxyHeaders = JSON.parse(proxyOutput) as Record<string, string>;
    assert.ok(proxyHeaders['X-Patterm-Mcp-Authorization']);
    assert.ok(!proxyOutput.includes(service.state.access), 'the helper supplies only proxy credentials');
    // A slow authorization server never holds up the helper, which Codex
    // allows 10 seconds, and a token inside its expiry margin is still used.
    let releaseToken!: () => void;
    service.state.tokenGate = new Promise<void>((resolve) => { releaseToken = resolve; });
    const stored = JSON.parse(String((database.connection.prepare('select tokens from mcp_server_credentials where server_id = ?').get(remote.id) as { tokens: string }).tokens)) as { access_token: string; expires_at: number };
    clock = stored.expires_at + 1;
    await new Promise<string>((resolve, reject) => execFile(process.execPath, [shim, '--mcp-proxy-headers', remote.id], { env, encoding: 'utf8', timeout: 5_000 },
      (error, stdout) => error ? reject(error) : resolve(stdout)));
    clock = stored.expires_at - 30_000;
    const refreshesBefore = service.state.refreshes;
    assert.deepEqual(await oauth.headers(remote.id), { Authorization: `Bearer ${stored.access_token}` }, 'a token about to expire is used while it refreshes');
    releaseToken();
    service.state.tokenGate = null;
    assert.equal((await oauth.headers(remote.id, stored.access_token)).Authorization, `Bearer ${service.state.access}`);
    assert.equal(service.state.refreshes, refreshesBefore + 1, 'the background refresh is shared');
    const proxyUrl = `${proxy.url}/${remote.id}`;
    assert.equal((await fetch(proxyUrl, { method: 'POST', headers: { Connection: 'close' } })).status, 401);
    assert.equal((await fetch(proxyUrl, { headers: { ...proxyHeaders, Connection: 'close', Origin: 'https://example.com' } })).status, 403);
    const rebound = await new Promise<number>((resolve, reject) => {
      const request = http.get(proxyUrl, { headers: { ...proxyHeaders, Host: 'attacker.example' } }, (response) => {
        response.resume();
        resolve(response.statusCode!);
      });
      request.on('error', reject);
    });
    assert.equal(rebound, 403);
    assert.equal((await fetch(`${proxy.url}/${open.id}`, { headers: { ...proxyHeaders, Connection: 'close' } })).status, 403, 'credentials are scoped to one server');
    // Persisted agents keep their endpoint and proxy credentials across restart.
    await proxy.stop();
    proxy = new McpHttpProxyService(proxyState, handlers);
    await proxy.start();
    assert.equal(`${proxy.url}/${remote.id}`, proxyUrl);
    const proxied = new Client({ name: 'proxy-test', version: '1' });
    await proxied.connect(new StreamableHTTPClientTransport(new URL(proxyUrl), { requestInit: { headers: {
      ...proxyHeaders, Authorization: 'Bearer unrelated-native-login'
    } } }));
    service.state.access = 'at-revoked-by-proxy';
    service.state.refresh = (JSON.parse(String((database.connection.prepare('select tokens from mcp_server_credentials where server_id = ?').get(remote.id) as { tokens: string }).tokens)) as { refresh_token: string }).refresh_token;
    assert.deepEqual((await proxied.listTools()).tools.map((entry) => entry.name), ['echo'], 'Patterm refreshes upstream credentials through the proxy');
    assert.deepEqual((await proxied.callTool({ name: 'echo', arguments: { text: 'through Patterm' } })).content,
      [{ type: 'text', text: JSON.stringify({ name: 'echo', arguments: { text: 'through Patterm' } }) }]);
    if (process.env.PATTERM_TEST_CODEX) {
      const nativeHome = path.join(dir, 'native-codex');
      fs.mkdirSync(nativeHome);
      const nativeConfig = `mcp_oauth_credentials_store="file"\n[mcp_servers.linear-acme]\nurl="${service.base}/mcp"\n`;
      fs.writeFileSync(path.join(nativeHome, 'config.toml'), nativeConfig);
      const key = `linear-acme|${createHash('sha256').update(JSON.stringify({ headers: {}, type: 'http', url: `${service.base}/mcp` })).digest('hex').slice(0, 16)}`;
      const credentials = JSON.stringify({ [key]: { server_name: 'linear-acme', server_url: `${service.base}/mcp`, issuer: service.base, client_id: 'native-client', access_token: 'invalid-native-token', refresh_token: 'invalid-native-refresh', expires_at: 1, scopes: [] } });
      fs.writeFileSync(path.join(nativeHome, '.credentials.json'), credentials, { mode: 0o600 });
      const nativePlan = { command: process.execPath, args: [shim], env: { PATTERM_MCP_SOCKET: socketPath, PATTERM_MCP_IDENTITY: 'mcp_codex' }, httpProxyUrl: proxy.url };
      const before = await nativeCodexTools(process.env.PATTERM_TEST_CODEX, nativeHome, [
        `mcp_servers.linear-acme.http_headers_helper=${JSON.stringify(headersHelperCommand(nativePlan, remote.id))}`
      ], {});
      assert.ok(!(before[0]?.tools as Record<string, unknown>)?.echo, 'the old helper delivery fails with a stale native OAuth login');
      assert.match(JSON.stringify(before), /auth|refresh|invalid_grant/i);
      fs.writeFileSync(path.join(nativeHome, '.credentials.json'), credentials, { mode: 0o600 });
      fs.writeFileSync(path.join(nativeHome, 'config.toml'), `${nativeConfig}bearer_token_env_var="MISSING_NATIVE_TOKEN"\n`);
      const remoteLaunch = registry.forHarness('codex').filter((entry) => entry.id === remote.id);
      const status = await nativeCodexTools(process.env.PATTERM_TEST_CODEX, nativeHome, codexMcpOverrides(remoteLaunch, nativePlan), { PATTERM_MCP_PROXY: 'patterm-managed' });
      assert.ok((status[0]?.tools as Record<string, unknown>)?.echo, 'native Codex discovers tools despite conflicting native bearer and saved OAuth settings');
      assert.equal(fs.readFileSync(path.join(nativeHome, '.credentials.json'), 'utf8'), credentials, 'native credentials remain untouched');
    }
    registry.save({ id: remote.id, name: remote.name, transport: 'http', url: `${service.base}/mcp`, enabled: false });
    assert.equal((await fetch(proxyUrl, { headers: proxyHeaders })).status, 502, 'each request rechecks server permissions');
    registry.save({ id: remote.id, name: remote.name, transport: 'http', url: `${service.base}/mcp`, enabled: true });
    await proxied.close();
    if (process.platform === 'win32') {
      // Run the delivered helper the way each CLI does on Windows, without the
      // shim's environment: Claude Code `cmd.exe /d /s /c "<helper>"`, Codex
      // `%ComSpec% /Q /D /C "<helper>"`. The shim sits in a directory whose
      // name cmd.exe would otherwise split or expand.
      const awkward = path.join(dir, 'odd & (dir) %PATH%');
      fs.mkdirSync(awkward);
      fs.copyFileSync(shim, path.join(awkward, 'shim.cjs'));
      const command = headersHelperCommand({ command: process.execPath, args: [path.join(awkward, 'shim.cjs')], env: { ELECTRON_RUN_AS_NODE: '1', PATTERM_MCP_SOCKET: socketPath, PATTERM_MCP_IDENTITY: 'mcp_claude' } }, remote.id);
      const bare = { SystemRoot: process.env.SystemRoot!, PATH: process.env.PATH! };
      const run = (file: string, args: string[], shell: boolean) => new Promise<string>((resolve, reject) => execFile(file, args,
        { env: bare, encoding: 'utf8', timeout: 10_000, shell, windowsVerbatimArguments: !shell }, (error, stdout) => error ? reject(error) : resolve(stdout)));
      for (const stdout of [await run(command, [], true), await run(process.env.ComSpec ?? 'cmd.exe', ['/Q', '/D', '/C', `"${command}"`], false)]) {
        assert.equal((JSON.parse(stdout) as Record<string, string>).Authorization, `Bearer ${service.state.access}`, 'cmd.exe runs the Windows header helper');
      }
    }
    const bridged = new Client({ name: 'bridge-test', version: '1' });
    await bridged.connect(new StdioClientTransport({ command: process.execPath, args: [shim, '--mcp-bridge', remote.id], env }));
    // The server revokes the token; the bridge asks Patterm for a new one.
    service.state.access = 'at-revoked';
    service.state.refresh = (JSON.parse(String((database.connection.prepare('select tokens from mcp_server_credentials where server_id = ?').get(remote.id) as { tokens: string }).tokens)) as { refresh_token: string }).refresh_token;
    const listedByBridge = await bridged.listTools();
    assert.deepEqual(listedByBridge.tools.map((entry) => entry.name), ['echo']);
    assert.deepEqual((await bridged.callTool({ name: 'echo', arguments: { text: 'through the bridge' } })).content,
      [{ type: 'text', text: JSON.stringify({ name: 'echo', arguments: { text: 'through the bridge' } }) }]);
    await bridged.close();

    console.log('mcp servers smoke passed');
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await service.close();
    database.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const deadline = setTimeout(() => { console.error('mcp servers smoke timed out'); process.exit(1); }, 60_000);
deadline.unref();
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
