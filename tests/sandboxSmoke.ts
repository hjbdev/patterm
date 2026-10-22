import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../app/Services/DatabaseService';
import { SettingsService } from '../app/Services/SettingsService';
import { McpToolRegistry } from '../app/MCP/ToolRegistry';
import { registerSandboxTools, unifiedDiff } from '../app/MCP/sandboxTools';
import { SandboxService } from '../app/Services/Sandbox/SandboxService';
import { SandboxGitService } from '../app/Services/Sandbox/SandboxGitService';
import { SandboxExecTimeout, type SandboxBackend, type SandboxExecOptions, type SandboxExecResult, type SandboxServiceSpec } from '../app/Services/Sandbox/SandboxBackend';
import { buildTranscriptTool } from '../app/Services/TranscriptProjection';
import { removeTree } from './fixtures/TempTree';

// Runs sandbox commands on this machine, so the tools and git routing can be
// checked end to end. Setup scripts that would replace the worktree are only
// recorded.
class LocalBackend implements SandboxBackend {
  readonly id = 'sprites';
  readonly calls: Array<{ argv: string[]; cwd?: string; stdin?: number }> = [];
  readonly services: Array<{ name: string; service: string; spec: SandboxServiceSpec }> = [];
  readonly holds: string[] = [];
  created: string[] = [];
  destroyed: string[] = [];

  async verify(): Promise<void> {}
  async create(name: string): Promise<void> { this.created.push(name); }
  async destroy(name: string): Promise<void> { this.destroyed.push(name); }
  async status(name: string): Promise<string | null> { return this.created.includes(name) ? 'running' : null; }
  async ensureService(name: string, service: string, spec: SandboxServiceSpec): Promise<void> { this.services.push({ name, service, spec }); }
  async hold(_name: string, key: string): Promise<void> { this.holds.push(`hold:${key}`); }
  async release(_name: string, key: string): Promise<void> { this.holds.push(`release:${key}`); }
  async tunnel(): Promise<{ port: number; close(): Promise<void> }> { return { port: 45_678, close: async () => {} }; }

  exec(_name: string, argv: string[], options: SandboxExecOptions = {}): Promise<SandboxExecResult> {
    const input = options.stdin === undefined ? undefined : Buffer.isBuffer(options.stdin) ? options.stdin : Buffer.from(options.stdin);
    this.calls.push({ argv, ...(options.cwd ? { cwd: options.cwd } : {}), ...(input ? { stdin: input.length } : {}) });
    const script = argv[0] === 'sh' && argv[1] === '-c' ? argv[2] ?? '' : '';
    if (script.includes('patterm-worktree.bundle') || argv[0] === 'gh' || (argv[0] === 'git' && argv[1] === 'apply')) {
      return Promise.resolve({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 });
    }
    return new Promise((resolve, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), { cwd: options.cwd, env: { ...process.env, ...options.env } });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
      const timer = options.timeoutMs ? setTimeout(() => { child.kill('SIGKILL'); reject(new SandboxExecTimeout(options.timeoutMs!)); }, options.timeoutMs) : null;
      child.on('error', reject);
      child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err), exitCode: code ?? -1 }); });
      child.stdin.end(input);
    });
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } });
}

function hasCommand(command: string): boolean {
  try { execFileSync(command, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

async function main(): Promise<void> {
  if (process.platform === 'win32') {
    console.log('sandbox smoke skipped on Windows: sandbox commands need a POSIX shell');
    return;
  }
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-sandbox-')));
  const database = new DatabaseService(path.join(dir, 'data'));
  try {
    database.initialize();
    const db = database.connection;
    const now = new Date().toISOString();
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'price.js'), 'export const total = (a, b) => a + b;\n');
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'init']);
    fs.writeFileSync(path.join(repo, 'src', 'price.js'), 'export const total = (a, b) => a * b;\n');
    db.prepare('insert into projects(id,name,path,created_at,updated_at) values(?,?,?,?,?)').run('p', 'Project', repo, now, now);
    db.prepare(`insert into worktrees(id,project_id,repo_path,worktree_path,branch,created_by,created_at) values('w','p',?,?,'main','user',?)`).run(repo, repo, now);

    const settings = new SettingsService(database);
    const backend = new LocalBackend();
    let changes = 0;
    const sandboxes = new SandboxService(database, settings, { runtimeDir: path.join(dir, 'runtime'), backend: () => backend, onChanged: () => { changes += 1; } });

    // The token is stored but never returned.
    assert.equal(sandboxes.configured(), false);
    await assert.rejects(sandboxes.provision({ project_id: 'p', worktree_id: 'w', path: repo }), /Sprites token/);
    db.prepare('delete from sandboxes').run();
    const state = await sandboxes.saveSettings({ token: 'sprite-token-secret', share_github: false });
    assert.equal(state.configured, true);
    assert.ok(!JSON.stringify(state).includes('sprite-token-secret'));
    assert.ok(!JSON.stringify(sandboxes.state()).includes('sprite-token-secret'));

    // Provisioning creates the sprite, uploads a bundle of the branch over
    // stdin, clones it at the same path, and applies uncommitted changes.
    const row = await sandboxes.provision({ project_id: 'p', worktree_id: 'w', path: repo });
    assert.equal(row.status, 'ready');
    assert.equal(backend.created.length, 1);
    assert.match(backend.created[0]!, /^patterm-[0-9a-f]{10}$/);
    const upload = backend.calls.find((call) => call.argv.join(' ').includes('cat > /tmp/patterm-worktree.bundle'));
    assert.ok(upload?.stdin && upload.stdin > 0, 'the bundle goes over stdin');
    const clone = backend.calls.find((call) => call.argv[2]?.includes('git clone'));
    assert.ok(clone?.argv[2]?.includes(repo) && clone.argv[2].includes("-B 'main'"));
    assert.ok(backend.calls.some((call) => call.argv.join(' ') === 'git apply --binary -' && call.cwd === repo && (call.stdin ?? 0) > 0));
    assert.ok(changes > 0);
    assert.equal(await sandboxes.provision({ project_id: 'p', worktree_id: 'w', path: repo }).then((again) => again.id), row.id, 'a worktree keeps its sandbox');
    assert.equal(sandboxes.forPath(path.join(repo, 'src'))?.id, row.id);
    assert.equal(sandboxes.forPath(`${repo}-other`), null);

    // Agents on the worktree run in its sandbox.
    db.prepare(`insert into processes(id,project_id,kind,name,status,cwd,worktree_id,created_at,updated_at) values('proc','p','agent','A','running',?,'w',?,?)`).run(repo, now, now);
    db.prepare(`insert into sessions(id,project_id,process_id,harness,interface_mode,session_role,started_at,cwd,worktree_id,mcp_identity) values('s','p','proc','claude','integrated','orchestrator',?,?,'w','mcp-a')`).run(now, repo);
    assert.equal(sandboxes.forIdentity('mcp-a')?.id, row.id);
    assert.equal(sandboxes.forProcess('proc')?.id, row.id);
    assert.equal(sandboxes.forIdentity('mcp-unknown'), null);

    // Codex gets a token-protected exec-server and a loopback URL.
    const codex = await sandboxes.codexEnvironmentFor('proc');
    assert.equal(codex?.execServerUrl, 'ws://127.0.0.1:45678');
    assert.equal(codex?.cwd, repo);
    assert.match(codex?.authBearerToken ?? '', /^[0-9a-f]{64}$/);
    const service = backend.services.at(-1)!;
    assert.deepEqual(service.spec.args.slice(0, 5), ['exec-server', '--listen', 'ws://127.0.0.1:7777', '--ws-auth', 'capability-token']);
    assert.ok(!service.spec.args.includes(codex!.authBearerToken), 'only the token digest is on the command line');

    // A busy agent holds the sandbox awake until every agent is idle.
    sandboxes.setBusy(row, 'proc', true);
    sandboxes.setBusy(row, 'proc-2', true);
    sandboxes.setBusy(row, 'proc', false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(backend.holds, ['hold:patterm']);
    sandboxes.setBusy(row, 'proc-2', false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(backend.holds, ['hold:patterm', 'release:patterm']);

    // The sandbox tools run in the sandbox for the agent that owns it, and
    // are hidden from other agents.
    const registry = new McpToolRegistry();
    registerSandboxTools(registry, sandboxes, { cwdFor: () => repo, launchingSandbox: (identity) => identity === 'mcp-launching' ? row.id : null });
    const names = (identity: string | null) => registry.publicTools({ identity }).map((tool) => tool.name).filter((name) => name.startsWith('sandbox_'));
    assert.equal(names('mcp-a').length, 6);
    assert.equal(names('mcp-launching').length, 6, 'a launching sandboxed agent lists the tools');
    db.prepare(`insert into sessions(id,project_id,process_id,harness,interface_mode,session_role,started_at,cwd,mcp_identity) values('s2','p',null,'claude','integrated','orchestrator',?,?,'mcp-b')`).run(now, dir);
    assert.equal(names('mcp-b').length, 0);
    assert.equal(names(null).length, 6, 'OpenCode lists them, and denies them by permission outside sandboxes');
    assert.ok(!registry.publicTools({ identity: 'mcp-a' }).some((tool) => tool.name.startsWith('settings_sandboxes')), 'owner settings stay hidden');
    await assert.rejects(registry.callPublic('sandbox_bash', { command: 'true' }, { identity: 'mcp-b' }));

    const call = (tool: string, args: Record<string, unknown>) => registry.callPublic(tool, args, { identity: 'mcp-a' }) as Promise<Record<string, unknown>>;
    const ran = await call('sandbox_bash', { command: 'pwd; echo oops >&2; exit 3' });
    assert.equal(ran.exit_code, 3);
    assert.equal(String(ran.stdout).trim(), repo);
    assert.equal(String(ran.stderr).trim(), 'oops');
    const timedOut = await call('sandbox_bash', { command: 'sleep 5', timeout: 1_000 });
    assert.match(String(timedOut.error), /timed out/);

    const written = await call('sandbox_write', { file_path: 'notes/todo.md', content: 'one\ntwo\n' });
    assert.equal(fs.readFileSync(path.join(repo, 'notes', 'todo.md'), 'utf8'), 'one\ntwo\n');
    assert.match(String(written.diff), /\+\+\+ b\/notes\/todo\.md\n@@ -0,0 \+1,2 @@/);
    const read = await call('sandbox_read', { file_path: path.join(repo, 'notes', 'todo.md'), offset: 2 });
    assert.equal(read.content, '     2\ttwo');
    const edited = await call('sandbox_edit', { file_path: 'notes/todo.md', old_string: 'two', new_string: 'three' });
    assert.equal(fs.readFileSync(path.join(repo, 'notes', 'todo.md'), 'utf8'), 'one\nthree\n');
    assert.match(String(edited.diff), /-two\n\+three/);
    fs.writeFileSync(path.join(repo, 'notes', 'twice.txt'), 'x x\n');
    await assert.rejects(call('sandbox_edit', { file_path: 'notes/twice.txt', old_string: 'x', new_string: 'y' }), /occurs 2 times/);
    await assert.rejects(call('sandbox_edit', { file_path: 'notes/twice.txt', old_string: 'z', new_string: 'y' }), /not found/);
    assert.equal((await call('sandbox_edit', { file_path: 'notes/twice.txt', old_string: 'x', new_string: 'y', replace_all: true })).replacements, 2);
    await assert.rejects(call('sandbox_read', { file_path: 'missing.txt' }), /not a file/);
    if (hasCommand('rg')) {
      assert.match(String((await call('sandbox_grep', { pattern: 'three', output_mode: 'content' })).matches), /todo\.md:2:three/);
      assert.equal((await call('sandbox_grep', { pattern: 'absent-pattern' })).matches, 'No matches');
      assert.match(String((await call('sandbox_glob', { pattern: '*.md' })).files), /notes\/todo\.md/);
    }

    // Git and working-tree reads for a sandboxed worktree go to the sandbox.
    const routed = new SandboxGitService(sandboxes);
    const before = backend.calls.length;
    assert.equal((await routed.run(repo, ['rev-parse', '--show-toplevel'])).stdout.trim(), repo);
    assert.equal(backend.calls.length, before + 1);
    assert.equal(await routed.query(repo, ['rev-parse', '-q', '--verify', 'refs/heads/absent']), null);
    await routed.run(dir, ['--version']);
    assert.equal(backend.calls.length, before + 2, 'paths outside sandboxes run here');
    assert.deepEqual(await sandboxes.readWorkingFile(row, repo, 'notes/todo.md', 100), { kind: 'file', bytes: Buffer.from('one\nthree\n') });
    assert.equal((await sandboxes.readWorkingFile(row, repo, 'absent.txt', 100)).kind, 'missing');
    await assert.rejects(sandboxes.readWorkingFile(row, repo, '../outside.txt', 100), /outside the worktree/);

    // Deleting refuses while agents use it, then removes the sprite.
    await assert.rejects(sandboxes.delete(row.id), /Stop the agents/);
    db.prepare(`update sessions set exited_at = ? where id = 's'`).run(now);
    await sandboxes.delete(row.id);
    assert.deepEqual(backend.destroyed, [row.remote_name]);
    assert.equal(sandboxes.forWorktree('w'), null);
    assert.equal(sandboxes.list().length, 0);
    await sandboxes.dispose();

    // The transcript shows sandbox tools as the tools they stand in for.
    const bash = buildTranscriptTool('mcp__patterm__sandbox_bash', { input: { command: 'npm test' } }, JSON.stringify({ exit_code: 1, stdout: 'fail', stderr: '' }));
    assert.equal(bash.family, 'shell');
    assert.equal(bash.command, 'npm test');
    assert.equal(bash.output, 'fail\nExit code 1');
    const edit = buildTranscriptTool('patterm_0123456789ab_sandbox_edit', { input: { file_path: `${repo}/a.txt`, old_string: 'a', new_string: 'b' } }, JSON.stringify({ file_path: `${repo}/a.txt`, diff: unifiedDiff('a.txt', 'a\n', 'b\n') }));
    assert.equal(edit.family, 'edit');
    assert.deepEqual(edit.changes, { additions: 1, deletions: 1 });
    assert.equal(buildTranscriptTool('mcp__other__sandbox_bash', {}, '{}').family, 'mcp');
    // Claude records the whole MCP result, with the reply as its text part.
    const envelope = { content: [{ type: 'text', text: JSON.stringify({ file_path: `${repo}/a.txt`, diff: unifiedDiff('a.txt', 'a\n', 'b\n') }) }] };
    const recorded = buildTranscriptTool('mcp__patterm__sandbox_write', { input: { file_path: `${repo}/a.txt`, content: 'b\n' }, result: envelope }, JSON.stringify(envelope));
    assert.deepEqual(recorded.changes, { additions: 1, deletions: 1 });
    assert.equal(recorded.output, undefined);

    assert.equal(unifiedDiff('f', 'same\n', 'same\n'), '');
    assert.match(unifiedDiff('f', 'a\nb\nc\nd\ne\nf\ng\nh\n', 'a\nb\nc\nd\nE\nf\ng\nh\n'), /@@ -2,7 \+2,7 @@\n b\n c\n d\n-e\n\+E\n f\n g\n h\n/);
    console.log('sandbox smoke passed');
  } finally {
    database.dispose();
    removeTree(dir);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
