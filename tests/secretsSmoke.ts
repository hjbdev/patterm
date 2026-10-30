import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { registerSecretTools, SECRET_CONTROL_TOOLS, SECRET_VIEW_TOOLS, SecretActions } from '../app/Actions/SecretActions';
import { BROWSER_TOOLS, INTEGRATED_CONTROL_TOOLS } from '../app/Http/BrowserTools';
import { McpSocketServer } from '../app/MCP/McpSocketServer';
import { McpToolRegistry } from '../app/MCP/ToolRegistry';
import { SecretRedactor } from '../app/Services/AgentHistory/SecretRedactor';
import type { BrowserService } from '../app/Services/Browser/BrowserService';
import { DatabaseService } from '../app/Services/DatabaseService';
import { SessionContextService } from '../app/Services/SessionContextService';
import { SecretProxyService } from '../app/Services/Secrets/SecretProxyService';
import { hostAllowed, normaliseHost, SecretService, type SecretRecord } from '../app/Services/Secrets/SecretService';
import { SecretVault } from '../app/Services/Secrets/SecretVault';
import type { TimelineService } from '../app/Services/TimelineService';
import { Masker, maskSet, secretCli } from '../mcp/secretCli';

// Windows has no POSIX modes, and agents there don't get patterm-secret.
const posix = process.platform !== 'win32';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-secrets-'));

function vaultChecks(): void {
  const keyPath = path.join(root, 'vault', 'secrets.key');
  const vault = new SecretVault(keyPath);
  const sealed = vault.seal('secret_a', 'hunter22');
  assert.equal(new SecretVault(keyPath).open('secret_a', sealed), 'hunter22', 'a new vault reads the saved key');
  if (posix) assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
  assert.throws(() => vault.open('secret_b', sealed), /unreadable/, 'a ciphertext moved to another record fails');
  assert.equal(vault.protectedByKeyring, false);

  // A keyring wraps the data key; the file never holds it in the clear.
  const wrappedPath = path.join(root, 'vault', 'wrapped.key');
  const wrapper = { available: () => true, wrap: (key: Buffer) => Buffer.from(key.map((byte) => byte ^ 0x5a)), unwrap: (sealed: Buffer) => Buffer.from(sealed.map((byte) => byte ^ 0x5a)) };
  const wrapped = new SecretVault(wrappedPath, wrapper);
  const value = wrapped.seal('secret_a', 'pw');
  assert.equal(new SecretVault(wrappedPath, wrapper).open('secret_a', value), 'pw');
  assert.equal(JSON.parse(fs.readFileSync(wrappedPath, 'utf8')).wrapped, true);
  assert.throws(() => new SecretVault(wrappedPath, null).open('secret_a', value), /keyring/);
}

function hostChecks(): void {
  assert.equal(normaliseHost(' API.Stripe.com. '), 'api.stripe.com');
  assert.throws(() => normaliseHost('https://api.stripe.com'), /Not a hostname/);
  assert.throws(() => normaliseHost('evil.com/@api.stripe.com'), /Not a hostname/);
  assert.ok(hostAllowed(['api.stripe.com'], 'api.stripe.com:443'), 'a portless entry allows any port');
  assert.ok(!hostAllowed(['api.stripe.com'], 'api.stripe.com.evil.com'));
  assert.ok(hostAllowed(['*.example.com'], 'a.b.example.com'));
  assert.ok(!hostAllowed(['*.example.com'], 'example.com'));
  assert.ok(!hostAllowed(['*.example.com'], 'badexample.com'));
  assert.ok(hostAllowed(['localhost:8000'], 'localhost:8000'));
  assert.ok(!hostAllowed(['localhost:8000'], 'localhost:9000'));
}

function maskerChecks(): void {
  const chunks: Buffer[] = [];
  const sink = new Writable({ write(chunk: Buffer, _encoding, done) { chunks.push(chunk); done(); } });
  const masker = new Masker(maskSet(['s3cr3t-value'], ['token']), sink);
  // Split across writes, and base64-encoded.
  masker.write(Buffer.from('key=s3cr3t-'));
  masker.write(Buffer.from(`value and ${Buffer.from('s3cr3t-value').toString('base64')} done`));
  masker.end();
  const text = Buffer.concat(chunks).toString();
  assert.equal(text, 'key=[secret:token] and [secret:token] done');
}

async function cliChecks(): Promise<void> {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const previous = process.cwd();
  process.chdir(repo);
  try {
    const asked: string[][] = [];
    const fetchValues = async (refs: string[]) => { asked.push(refs); return refs.map((ref) => (ref === 'api' ? 'abc 123"x' : 'plain')); };
    fs.writeFileSync('.env.local', 'KEEP=1\nAPI_KEY=old\n');
    assert.equal(await secretCli(['write', '.env.local', 'API_KEY=api', 'OTHER=other'], fetchValues), 0);
    assert.deepEqual(asked, [['api', 'other']]);
    assert.equal(fs.readFileSync('.env.local', 'utf8'), 'KEEP=1\nAPI_KEY="abc 123\\"x"\nOTHER=plain\n');
    if (posix) assert.equal(fs.statSync('.env.local').mode & 0o777, 0o600);
    assert.match(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\/\.env\.local$/m);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }), '', 'git ignores the written file');
    await assert.rejects(secretCli(['run', '--env', '1BAD=api', '--', 'true'], fetchValues), /expected NAME=secret/);
  } finally {
    process.chdir(previous);
  }
}

// The built shim fetches values as the agent and masks them in output. It
// runs sh, so only where agents get patterm-secret.
async function shimChecks(socketPath: string): Promise<void> {
  const shim = path.resolve(__dirname, '../../mcp/patterm-mcp.js');
  // Async, so this process's socket server can answer the shim.
  const run = (identity: string, args: string[]) => new Promise<{ stdout: string; stderr: string; status: number | null }>((resolve) => {
    const child = spawn(process.execPath, [shim, '--secret', ...args], { env: { ...process.env, PATTERM_MCP_SOCKET: socketPath, PATTERM_MCP_IDENTITY: identity } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ stdout, stderr, status }));
  });
  const echoed = await run('identity_a', ['run', '--env', 'KEY=stripe_test', '--', 'sh', '-c', 'echo "got $KEY"; echo "len ${#KEY}" >&2; exit 3']);
  assert.equal(echoed.stdout, 'got [secret:stripe_test]\n');
  assert.equal(echoed.stderr, 'len 18\n', 'the child receives the real value');
  assert.equal(echoed.status, 3, 'the exit code passes through');
  const stranger = await run('identity_x', ['run', '--env', 'KEY=stripe_test', '--', 'true']);
  assert.notEqual(stranger.status, 0);
  assert.match(stranger.stderr, /running Patterm agent/);
  const login = await run('identity_a', ['run', '--env', 'P=github_login.password', '--', 'true']);
  assert.match(login.stderr, /did not allow "github_login" in commands/);
}

async function serviceChecks(): Promise<void> {
  const database = new DatabaseService(path.join(root, 'db'));
  database.initialize();
  const db = database.connection;
  const now = new Date().toISOString();
  db.prepare('insert into projects (id,name,path,created_at,updated_at) values (?,?,?,?,?)').run('project_a', 'A', root, now, now);
  db.prepare("insert into processes(id,project_id,kind,name,status,activity,cwd,argv,created_at,updated_at) values('process_a','project_a','agent','A','running','working',?,'[]',?,?)").run(root, now, now);
  db.prepare(`insert into sessions(id,project_id,process_id,harness,interface_mode,resume_id,started_at,session_role,resume_status,created_by_actor,mcp_identity)
    values('session_a','project_a','process_a','claude','tui','native_a',?,'orchestrator','found','user','identity_a')`).run(now);

  const events: string[] = [];
  const messages: string[] = [];
  let proxy: SecretProxyService | null = null;
  const secrets = new SecretService(database, new SecretVault(path.join(root, 'db', 'secrets.key')), {
    requested: (processId, secret) => events.push(`requested ${processId} ${secret.name}`),
    settled: (processId) => events.push(`settled ${processId}`),
    messageAgent: async (_processId, text) => { messages.push(text); },
    proxyUrls: (secret) => proxy?.urls(secret) ?? {},
    changed: () => events.push('changed')
  });
  let filled: { selector: string; value: string; allowed: (host: string) => boolean } | null = null;
  const browsers = { fillSecret: async (_session: string, input: typeof filled & object) => { filled = input; return { target_id: 't', host: 'github.com' }; } } as unknown as BrowserService;
  const actions = new SecretActions(secrets, browsers);
  const agent = { identity: 'identity_a' };

  // Requests never carry a value, and listing never shows one.
  const requested = actions.request({ name: 'stripe_test', purpose: 'Test charges', hosts: ['127.0.0.1'] }, agent) as { secret: { status: string; uses: string[] } };
  assert.equal(requested.secret.status, 'requested');
  assert.deepEqual(requested.secret.uses, ['proxy'], 'an API key with hosts defaults to the proxy');
  assert.deepEqual(events.splice(0), ['requested process_a stripe_test', 'changed']);
  assert.throws(() => actions.request({ name: 'Bad Name', purpose: 'x' }, agent));
  assert.throws(() => actions.request({ name: 'x', purpose: 'x' }, { identity: 'someone_else' }), /running Patterm agent/);
  assert.throws(() => actions.request({ name: 'x', purpose: 'x' }, { identity: 'identity_a', remote: true } as never), /own host/);

  const id = secrets.list('session_a')[0]!.id;
  await assert.rejects(actions.save({ process_id: 'process_a', secret_id: id, name: 'stripe_test', kind: 'api_key', values: { value: 'sk_test_1234567890' }, allowed_hosts: [], uses: ['proxy'] }), /at least one allowed host/);
  await actions.save({ process_id: 'process_a', secret_id: id, name: 'stripe_test', kind: 'api_key', values: { value: 'sk_test_1234567890' }, allowed_hosts: ['127.0.0.1'], uses: ['proxy'] });
  assert.ok(events.includes('settled process_a'));
  assert.match(messages.at(-1)!, /provided the secret "stripe_test"/);
  assert.doesNotMatch(messages.at(-1)!, /sk_test/);
  assert.doesNotMatch(JSON.stringify(actions.list(agent)), /sk_test/);
  assert.doesNotMatch(JSON.stringify(actions.sessionList({ process_id: 'process_a' })), /sk_test/);
  const stored = db.prepare('select ciphertext from session_secrets where id = ?').get(id) as { ciphertext: Uint8Array };
  assert.ok(!Buffer.from(stored.ciphertext).includes('sk_test_1234567890'), 'the database holds ciphertext');

  // Uses gate every path out.
  assert.throws(() => secrets.reveal('session_a', 'stripe_test', 'env'), /did not allow/);
  assert.equal(secrets.reveal('session_a', 'stripe_test', 'proxy').value, 'sk_test_1234567890');

  // History and summaries mask stored values, in text and in tool metadata.
  SecretRedactor.useKnownValues(secrets.knownValues());
  assert.equal(new SecretRedactor().redact('saw sk_test_1234567890 here').text, 'saw [REDACTED] here');
  assert.deepEqual(new SecretRedactor().maskKnown({ toolMetadata: { output: ['key sk_test_1234567890'], exit: 0 } }), { toolMetadata: { output: ['key [REDACTED]'], exit: 0 } });

  // A header can't carry line breaks; saving says so instead of crashing the proxy later.
  await assert.rejects(actions.save({ process_id: 'process_a', secret_id: null, name: 'bad_header', kind: 'api_key', values: { value: 'abc\r\nX-Evil: 1' }, allowed_hosts: ['127.0.0.1'], uses: ['proxy'] }), /can't go in an HTTP header/);
  await assert.rejects(actions.save({ process_id: 'process_a', secret_id: null, name: 'bad_prefix', kind: 'api_key', values: { value: 'fine-value' }, allowed_hosts: ['127.0.0.1'], uses: ['proxy'], injection: { in: 'header', name: 'X-Key', prefix: 'a\n' } }), /can't go in an HTTP header/);
  await actions.save({ process_id: 'process_a', secret_id: null, name: 'query_key', kind: 'api_key', values: { value: 'line\nbreak-ok' }, allowed_hosts: ['127.0.0.1'], uses: ['proxy'], injection: { in: 'query', name: 'key', prefix: '' } });
  await actions.remove({ process_id: 'process_a', secret_id: secrets.list('session_a').find((secret) => secret.name === 'query_key')!.id });

  // The proxy adds the credential only for allowed hosts and live sessions.
  const seen: Array<{ url: string; authorization: string | undefined; host: string | undefined }> = [];
  const upstream = http.createServer((request, response) => {
    seen.push({ url: request.url!, authorization: request.headers.authorization, host: request.headers.host });
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as { port: number }).port;
  proxy = new SecretProxyService(path.join(root, 'db', 'secret-proxy.json'), secrets);
  await proxy.start();
  try {
    const secret = secrets.get(id);
    const base = proxy.urls(secret)['127.0.0.1']!;
    assert.match(base, /^http:\/\/127\.0\.0\.1:\d+\/secret_[^/]+\.[^/]+\/127\.0\.0\.1\/$/);
    const target = base.replace('/127.0.0.1/', `/127.0.0.1:${upstreamPort}/`);
    const response = await fetch(`${target}v1/charges?limit=1`, { method: 'POST', headers: { Authorization: 'Bearer agent-made-up' }, body: 'amount=1' });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(seen.at(-1), { url: '/v1/charges?limit=1', authorization: 'Bearer sk_test_1234567890', host: `127.0.0.1:${upstreamPort}` });

    assert.equal((await fetch(target.replace(/\.[^./]+\/127/, '.forged/127'))).status, 401, 'a forged signature fails');
    assert.equal((await fetch(target.replace(`/127.0.0.1:${upstreamPort}/`, `/localhost:${upstreamPort}/`))).status, 403, 'other hosts are refused');
    assert.equal((await fetch(target, { headers: { origin: 'https://evil.example' } })).status, 403, 'browser pages are refused');
    // Agents' tool results hide proxy URLs, so another agent reading this
    // one's conversation or terminal can't use them; secret_list keeps them.
    const registry = new McpToolRegistry();
    registerSecretTools(registry, actions);
    registry.register({ name: 'get_conversation_output', namespace: 'test', description: 'test', inputSchema: { type: 'object' } }, () => ({ messages: [{ text: `use ${base} now` }] }));
    const read = JSON.stringify(await registry.callPublic('get_conversation_output', {}, agent));
    assert.doesNotMatch(read, /secret_[0-9a-f-]{36}\./, 'a conversation read hides the URL');
    assert.match(read, /proxy URL hidden/);
    assert.match(JSON.stringify(await registry.callPublic('secret_list', {}, agent)), new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'secret_list gives the owner its URL');
    // Query injection.
    await actions.save({ process_id: 'process_a', secret_id: id, name: 'stripe_test', kind: 'api_key', values: null, allowed_hosts: ['127.0.0.1'], uses: ['proxy', 'env'], injection: { in: 'query', name: 'key', prefix: '' } });
    await fetch(`${target}q?a=1`);
    assert.equal(seen.at(-1)!.url, '/q?a=1&key=sk_test_1234567890');
    assert.equal(seen.at(-1)!.authorization, undefined);
    assert.equal(secrets.reveal('session_a', 'stripe_test', 'env').value, 'sk_test_1234567890', 'saving without values keeps the stored one');

    // An exited session's URLs stop working.
    db.prepare('update sessions set exited_at = ? where id = ?').run(now, 'session_a');
    assert.equal((await fetch(target)).status, 403);
    db.prepare('update sessions set exited_at = null where id = ?').run('session_a');
  } finally {
    await proxy.stop();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }

  // Logins fill the browser only on allowed sites.
  await actions.save({ process_id: 'process_a', secret_id: null, name: 'github_login', kind: 'login', values: { username: 'me', password: 'pa55word!' }, allowed_hosts: ['github.com'], uses: ['browser'] });
  await actions.fill({ secret: 'github_login', selector: '#password' }, agent);
  assert.equal(filled!.value, 'pa55word!');
  assert.ok(filled!.allowed('github.com') && !filled!.allowed('github.com.evil.io'));
  await actions.fill({ secret: 'github_login', field: 'username', selector: '#login' }, agent);
  assert.equal(filled!.value, 'me');
  await assert.rejects(actions.fill({ secret: 'stripe_test', selector: '#x' }, agent), /did not allow/);

  // The shim fetches values as the agent and masks them in output.
  const socketPath = path.join(root, 'db', 'mcp.sock');
  const socket = new McpSocketServer(socketPath, {} as McpToolRegistry, undefined, undefined, undefined, undefined, {
    env: (identity, refs) => secrets.envValues(identity, refs)
  });
  await socket.start();
  try {
    if (posix) await shimChecks(socketPath);
  } finally {
    socket.stop();
  }

  // A resumed conversation keeps its secrets.
  db.prepare("update sessions set exited_at = ? where id = 'session_a'").run(now);
  db.prepare("insert into processes(id,project_id,kind,name,status,activity,cwd,argv,created_at,updated_at) values('process_b','project_a','agent','A','running','working',?,'[]',?,?)").run(root, now, now);
  db.prepare(`insert into sessions(id,project_id,process_id,harness,interface_mode,resume_id,started_at,session_role,resume_status,created_by_actor,mcp_identity)
    values('session_b','project_a','process_b','claude','tui','native_a',?,'orchestrator','found','user','identity_b')`).run(new Date(Date.now() + 1000).toISOString());
  new SessionContextService(database).inherit('session_b', 'project_a', 'claude', 'native_a', { record: () => undefined } as unknown as TimelineService);
  assert.deepEqual(secrets.list('session_b').map((secret: SecretRecord) => secret.name).sort(), ['github_login', 'stripe_test']);
  assert.equal(secrets.list('session_a').length, 0);

  // Declining or forgetting deletes the record and tells the agent.
  await assert.rejects(actions.remove({ process_id: 'process_a', secret_id: secrets.list('session_b')[0]!.id }), /another session/);
  await actions.remove({ process_id: 'process_b', secret_id: secrets.list('session_b')[0]!.id });
  assert.equal(secrets.list('session_b').length, 1);
  assert.match(messages.at(-1)!, /removed the secret/);
  database.dispose();
}

function allowlistChecks(): void {
  for (const tool of SECRET_VIEW_TOOLS) assert.ok(BROWSER_TOOLS.has(tool), tool);
  for (const tool of SECRET_CONTROL_TOOLS) {
    assert.ok(INTEGRATED_CONTROL_TOOLS.has(tool), `${tool} needs control`);
    assert.ok(!BROWSER_TOOLS.has(tool), `${tool} is socket-only for browsers`);
  }
}

async function main(): Promise<void> {
  try {
    vaultChecks();
    hostChecks();
    maskerChecks();
    await cliChecks();
    await serviceChecks();
    allowlistChecks();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('secrets smoke passed');
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
