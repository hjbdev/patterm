import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { SECRET_CONTROL_TOOLS, SECRET_VIEW_TOOLS, SecretActions } from '../app/Actions/SecretActions';
import { BROWSER_TOOLS, INTEGRATED_CONTROL_TOOLS } from '../app/Http/BrowserTools';
import { SecretRedactor } from '../app/Services/AgentHistory/SecretRedactor';
import type { BrowserService } from '../app/Services/Browser/BrowserService';
import { DatabaseService } from '../app/Services/DatabaseService';
import { SessionContextService } from '../app/Services/SessionContextService';
import { SecretProxyService } from '../app/Services/Secrets/SecretProxyService';
import { hostAllowed, normaliseHost, SecretService, type SecretRecord } from '../app/Services/Secrets/SecretService';
import { SecretVault } from '../app/Services/Secrets/SecretVault';
import type { TimelineService } from '../app/Services/TimelineService';
import { endRun, Masker, maskSet, SecretRunner } from '../app/Services/Secrets/SecretRunner';

// Windows has no POSIX modes.
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
  const masker = new Masker(maskSet([{ value: 's3cr3t-value', label: 'token' }]));
  // Split across writes, and base64-encoded.
  masker.write(Buffer.from('key=s3cr3t-'));
  masker.write(Buffer.from(`value and ${Buffer.from('s3cr3t-value').toString('base64')} done`));
  assert.deepEqual(masker.end(), { text: 'key=[secret:token] and [secret:token] done', truncated: false });
  // Long output keeps its end, masked before it is cut.
  const long = new Masker(maskSet([{ value: 's3cr3t-value', label: 'token' }]));
  long.write(Buffer.from(`${'x'.repeat(70_000)} s3cr3t-value end`));
  const kept = long.end();
  assert.ok(kept.truncated && kept.text.length === 64 * 1024 && kept.text.endsWith(' [secret:token] end'));
}

// A command for sh and cmd.exe alike: node with single-quoted JavaScript.
function node(script: string): string {
  return `"${process.execPath}" -e "${script}"`;
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
    proxyUrl: (secret, host) => proxy!.url(secret, host),
    changed: () => events.push('changed')
  });
  let filled: { selector: string; value: string; allowed: (host: string) => boolean } | null = null;
  const browsers = { fillSecret: async (_session: string, input: typeof filled & object) => { filled = input; return { target_id: 't', host: 'github.com' }; } } as unknown as BrowserService;
  const runner = new SecretRunner(() => ({ ...process.env, PATTERM_TERMINAL_IDENTITY: 'leak' }));
  const actions = new SecretActions(secrets, browsers, runner);
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
  // Proxy URLs never reach a conversation, where other agents could read them.
  assert.match(messages.at(-1)!, /secret_run with urls \{"STRIPE_TEST_URL": "stripe_test"\}/);
  assert.doesNotMatch(messages.at(-1)! + JSON.stringify(actions.list(agent)), /http:\/\/127\.0\.0\.1|secret_[0-9a-f-]{36}\./);
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
    const target = secrets.proxyUrl('session_a', `stripe_test@127.0.0.1:${upstreamPort}`);
    assert.match(target, new RegExp(`^http://127\\.0\\.0\\.1:\\d+/secret_[^/]+\\.[^/.]+\\.[^/.]+/127\\.0\\.0\\.1:${upstreamPort}/$`));
    assert.notEqual(secrets.proxyUrl('session_a', 'stripe_test'), secrets.proxyUrl('session_a', 'stripe_test'), 'each command gets its own URL');
    assert.throws(() => secrets.proxyUrl('session_a', 'stripe_test@evil.example'), /only for 127\.0\.0\.1/);
    const response = await fetch(`${target}v1/charges?limit=1`, { method: 'POST', headers: { Authorization: 'Bearer agent-made-up' }, body: 'amount=1' });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(seen.at(-1), { url: '/v1/charges?limit=1', authorization: 'Bearer sk_test_1234567890', host: `127.0.0.1:${upstreamPort}` });

    assert.equal((await fetch(target.replace(/\.[^./]+\/127/, '.forged/127'))).status, 401, 'a forged signature fails');
    assert.equal((await fetch(target.replace(/\.([^./]+)\.([^./]+)\/127/, '.othernonce.$2/127'))).status, 401, 'a signature works only with its nonce');
    assert.equal((await fetch(target.replace(`/127.0.0.1:${upstreamPort}/`, `/localhost:${upstreamPort}/`))).status, 403, 'other hosts are refused');
    assert.equal((await fetch(target, { headers: { origin: 'https://evil.example' } })).status, 403, 'browser pages are refused');
    // Query injection.
    await actions.save({ process_id: 'process_a', secret_id: id, name: 'stripe_test', kind: 'api_key', values: null, allowed_hosts: ['127.0.0.1'], uses: ['proxy', 'env'], injection: { in: 'query', name: 'key', prefix: '' } });
    await fetch(`${target}q?a=1`);
    assert.equal(seen.at(-1)!.url, '/q?a=1&key=sk_test_1234567890');
    assert.equal(seen.at(-1)!.authorization, undefined);
    assert.equal(secrets.reveal('session_a', 'stripe_test', 'env').value, 'sk_test_1234567890', 'saving without values keeps the stored one');

    // secret_run: the command gets values and proxy URLs; its output, and so
    // the conversation, gets neither.
    const ran = await actions.run({
      command: node("console.log('got '+process.env.KEY); console.error('len '+process.env.KEY.length+' '+(process.env.PATTERM_TERMINAL_IDENTITY||'none')); process.exit(3)"),
      env: { KEY: 'stripe_test' }
    }, agent);
    assert.deepEqual(ran, { exit_code: 3, signal: null, timed_out: false, stdout: 'got [secret:stripe_test]\n', stderr: 'len 18 none\n', truncated: false });
    const proxied = await actions.run({
      command: node("fetch(process.env.U+'v1/run').then(r=>r.json()).then(j=>console.log('base '+process.env.U+' '+JSON.stringify(j)))"),
      urls: { U: `stripe_test@127.0.0.1:${upstreamPort}` }
    }, agent) as { stdout: string; exit_code: number };
    assert.equal(proxied.exit_code, 0);
    assert.match(proxied.stdout, new RegExp(`^base http://127\\.0\\.0\\.1:\\d+/\\[secret:stripe_test@127\\.0\\.0\\.1:${upstreamPort} url\\]/127\\.0\\.0\\.1:${upstreamPort}/ \\{"ok":true\\}\\n$`));
    assert.equal(seen.at(-1)!.url, '/v1/run?key=sk_test_1234567890', 'the command reached the API through the proxy');
    const slow = await actions.run({ command: node('setTimeout(()=>{},20000)'), env: { KEY: 'stripe_test' }, timeout_seconds: 1 }, agent) as { timed_out: boolean };
    assert.equal(slow.timed_out, true);
    await assert.rejects(actions.run({ command: 'echo hi' }, agent), /at least one secret/);
    if (posix) {
      // Whatever a command leaves running ends with it.
      const left = await actions.run({ command: 'sleep 30 >/dev/null 2>&1 & echo $!', env: { KEY: 'stripe_test' } }, agent) as { stdout: string };
      const pid = Number(left.stdout.trim());
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.throws(() => process.kill(pid, 0), 'the background child was ended');
    }
    // A command whose shell exits while a child it left holds the output
    // open still returns at its timeout.
    const started = Date.now();
    const held = await actions.run({
      command: node("require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},8000)'],{stdio:'inherit'}).unref()"),
      // On Windows the orphan outlives the call, and its working folder can't
      // be removed while it runs, so it runs outside the test's folder.
      env: { KEY: 'stripe_test' }, timeout_seconds: 1, cwd: os.tmpdir()
    }, agent) as { timed_out: boolean };
    assert.equal(held.timed_out, true);
    assert.ok(Date.now() - started < 4000, 'the call returns at its timeout, not when the child ends');
    // The call returns only once the tree has ended, even if the output
    // closes first.
    let settled = false;
    const late = new SecretRunner(() => process.env, async (child) => {
      await endRun(child);
      await new Promise((resolve) => setTimeout(resolve, 600));
      settled = true;
    });
    const lateRun = await late.run({ sessionId: 'late', command: node('setTimeout(()=>{},20000)'), cwd: os.tmpdir(), env: [{ name: 'K', value: 'fake-value', label: 'k', mask: 'fake-value' }], timeoutSeconds: 1 });
    assert.equal(lateRun.timed_out, true);
    assert.equal(settled, true, 'the call waited for the tree to end');
    // A stopped agent's commands end with it.
    const stopping = actions.run({ command: node('setTimeout(()=>{},20000)'), env: { KEY: 'stripe_test' }, timeout_seconds: 30 }, agent) as Promise<{ exit_code: number | null; timed_out: boolean }>;
    await new Promise((resolve) => setTimeout(resolve, 300));
    runner.stop((sessionId) => sessionId !== 'session_a');
    const stopped = await stopping;
    assert.equal(stopped.timed_out, false);
    assert.notEqual(stopped.exit_code, 0);
    await assert.rejects(actions.run({ command: 'echo hi', env: { KEY: 'stripe_test' } }, { identity: 'identity_x' }), /running Patterm agent/);

    // secret_write: a 0600 dotenv file, kept out of git.
    const repo = path.join(root, 'repo');
    fs.mkdirSync(path.join(repo, 'app'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'logs'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    await assert.rejects(actions.save({ process_id: 'process_a', secret_id: null, name: 'nul_key', kind: 'api_key', values: { value: 'fake\u0000value' }, allowed_hosts: [], uses: ['env'] }), /NUL/);
    await actions.save({ process_id: 'process_a', secret_id: null, name: 'odd_key', kind: 'api_key', values: { value: 'abc 123"x' }, allowed_hosts: [], uses: ['env'] });
    fs.writeFileSync(path.join(repo, '.env.local'), 'KEEP=1\nAPI_KEY=old\n');
    const written = await actions.write({ path: 'repo/.env.local', env: { API_KEY: 'odd_key', OTHER: 'stripe_test' } }, agent);
    assert.doesNotMatch(JSON.stringify(written), /abc 123|sk_test/, 'secret_write never returns values');
    assert.equal(fs.readFileSync(path.join(repo, '.env.local'), 'utf8'), 'KEEP=1\nAPI_KEY="abc 123\\"x"\nOTHER=sk_test_1234567890\n');
    if (posix) assert.equal(fs.statSync(path.join(repo, '.env.local')).mode & 0o777, 0o600);
    const exclude = () => fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
    assert.match(exclude(), /^\/\.env\.local$/m);
    // Already ignored in its own folder: nothing to add.
    fs.writeFileSync(path.join(repo, 'logs', '.gitignore'), '.env\n');
    execFileSync('git', ['add', 'logs/.gitignore'], { cwd: repo });
    await actions.write({ path: 'repo/logs/.env', env: { API_KEY: 'odd_key' } }, agent);
    assert.doesNotMatch(exclude(), /logs/);
    await actions.write({ path: path.join(repo, 'app', '.env'), env: { API_KEY: 'odd_key' } }, agent);
    assert.match(exclude(), /^\/app\/\.env$/m, 'a file in a folder is excluded by its path from the top');
    // Pattern characters in a path are literal.
    const bracketed = await actions.write({ path: 'repo/app/[tenant]/.env', env: { API_KEY: 'odd_key' } }, agent) as { excluded_by: string | null; warning?: string };
    assert.deepEqual([bracketed.excluded_by, bracketed.warning], ['.git/info/exclude', undefined]);
    assert.match(exclude(), /^\/app\/\\\[tenant\\\]\/\.env$/m);
    if (posix) {
      // A symlink would hide where the secret really goes.
      fs.writeFileSync(path.join(repo, 'tracked.env'), 'KEY=placeholder\n');
      fs.symlinkSync('tracked.env', path.join(repo, '.env.link'));
      await assert.rejects(actions.write({ path: 'repo/.env.link', env: { API_KEY: 'odd_key' } }, agent), /symlink/);
      assert.equal(fs.readFileSync(path.join(repo, 'tracked.env'), 'utf8'), 'KEY=placeholder\n');
      fs.rmSync(path.join(repo, 'tracked.env'));
      fs.rmSync(path.join(repo, '.env.link'));
    }
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }), 'A  logs/.gitignore\n', 'git ignores the written files');

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

  // A resumed conversation keeps its secrets.
  db.prepare("update sessions set exited_at = ? where id = 'session_a'").run(now);
  db.prepare("insert into processes(id,project_id,kind,name,status,activity,cwd,argv,created_at,updated_at) values('process_b','project_a','agent','A','running','working',?,'[]',?,?)").run(root, now, now);
  db.prepare(`insert into sessions(id,project_id,process_id,harness,interface_mode,resume_id,started_at,session_role,resume_status,created_by_actor,mcp_identity)
    values('session_b','project_a','process_b','claude','tui','native_a',?,'orchestrator','found','user','identity_b')`).run(new Date(Date.now() + 1000).toISOString());
  new SessionContextService(database).inherit('session_b', 'project_a', 'claude', 'native_a', { record: () => undefined } as unknown as TimelineService);
  assert.deepEqual(secrets.list('session_b').map((secret: SecretRecord) => secret.name).sort(), ['github_login', 'odd_key', 'stripe_test']);
  assert.equal(secrets.list('session_a').length, 0);

  // Declining or forgetting deletes the record and tells the agent.
  await assert.rejects(actions.remove({ process_id: 'process_a', secret_id: secrets.list('session_b')[0]!.id }), /another session/);
  await actions.remove({ process_id: 'process_b', secret_id: secrets.list('session_b')[0]!.id });
  assert.equal(secrets.list('session_b').length, 2);
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
    await serviceChecks();
    allowlistChecks();
  } finally {
    // Windows can hold a just-ended process's folder for a moment.
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) {
      // Show which entries can't go, and what they are.
      if (process.platform === 'win32') {
        const stuck: string[] = [];
        const visit = (dir: string) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) visit(full);
            try {
              fs.rmSync(full, { recursive: true, force: true });
            } catch (inner) {
              const stat = fs.lstatSync(full);
              stuck.push(`${path.relative(root, full)} ${(inner as NodeJS.ErrnoException).code} mode=${(stat.mode & 0o777).toString(8)}`);
            }
          }
        };
        try { visit(root); } catch (walk) { stuck.push(`walk failed: ${String(walk)}`); }
        console.error(`entries that could not be removed:\n${stuck.join('\n') || '(none; only the folder itself)'}`);
      }
      throw error;
    }
  }
  console.log('secrets smoke passed');
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
