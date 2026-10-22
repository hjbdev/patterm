import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../app/Services/DatabaseService';
import { SettingsService } from '../app/Services/SettingsService';
import { SandboxService } from '../app/Services/Sandbox/SandboxService';
import type { SandboxBackend, SandboxExecOptions, SandboxExecResult } from '../app/Services/Sandbox/SandboxBackend';
import { removeTree } from './fixtures/TempTree';

// A sandbox on this machine whose files live under `remote`: every path
// under the test directory is moved there on the way in and back on the way
// out, so the local worktree and the sandbox's copy are really separate.
class MappedBackend implements SandboxBackend {
  readonly id = 'sprites';
  readonly holds: string[] = [];
  destroyed: string[] = [];
  // Runs before the next command, to change things mid-sync.
  beforeNext: (() => void) | null = null;
  // Holds every command until it settles.
  gate: Promise<void> | null = null;
  private readonly created = new Set<string>();

  constructor(private readonly root: string, private readonly remote: string) {}

  async verify(): Promise<void> {}
  async create(name: string): Promise<void> { this.created.add(name); }
  async destroy(name: string): Promise<void> { this.destroyed.push(name); }
  async status(name: string): Promise<string | null> { return this.created.has(name) ? 'running' : null; }
  async ensureService(): Promise<void> {}
  async hold(_name: string, key: string): Promise<void> { this.holds.push(`hold:${key}`); }
  async release(_name: string, key: string): Promise<void> { this.holds.push(`release:${key}`); }
  async tunnel(): Promise<{ port: number; close(): Promise<void> }> { return { port: 1, close: async () => {} }; }

  remotePath(local: string): string {
    return this.toRemote(local);
  }

  async exec(_name: string, argv: string[], options: SandboxExecOptions = {}): Promise<SandboxExecResult> {
    await this.gate;
    const before = this.beforeNext;
    this.beforeNext = null;
    before?.();
    const stdin = options.stdin === undefined ? undefined : Buffer.isBuffer(options.stdin) ? options.stdin : Buffer.from(options.stdin);
    // Scripts arrive over stdin; their paths move like any other.
    const input = argv.length === 1 && argv[0] === 'sh' && stdin ? Buffer.from(this.toRemote(stdin.toString('utf8')).replace(/sudo /g, '')) : stdin;
    return new Promise((resolve, reject) => {
      // The sandbox has its own, empty git settings.
      const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(this.remote, 'gitconfig'), ...options.env };
      const child = spawn(argv[0]!, argv.slice(1).map((arg) => this.toRemote(arg)), { cwd: options.cwd ? this.toRemote(options.cwd) : this.remote, env });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
      child.on('error', reject);
      child.on('close', (code) => resolve({ stdout: this.toLocal(Buffer.concat(out)), stderr: this.toLocal(Buffer.concat(err)), exitCode: code ?? -1 }));
      child.stdin.end(input);
    });
  }

  private toRemote(text: string): string {
    return text.split('/tmp/patterm-worktree.bundle').join(path.join(this.root, 'upload.bundle')).split(this.root + path.sep).join(this.remote + path.sep);
  }

  private toLocal(bytes: Buffer): Buffer {
    const from = Buffer.from(this.remote + path.sep);
    const to = Buffer.from(this.root + path.sep);
    const parts: Buffer[] = [];
    let start = 0;
    for (let index = bytes.indexOf(from); index !== -1; index = bytes.indexOf(from, start)) {
      parts.push(bytes.subarray(start, index), to);
      start = index + from.length;
    }
    parts.push(bytes.subarray(start));
    return Buffer.concat(parts);
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function main(): Promise<void> {
  if (process.platform === 'win32') {
    console.log('sandbox sync smoke skipped on Windows: sandbox commands need a POSIX shell');
    return;
  }
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-sandbox-sync-')));
  // Git here and in the fake sandbox ignores the machine's own settings.
  fs.writeFileSync(path.join(dir, 'gitconfig'), '');
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: path.join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x'
  });
  const database = new DatabaseService(path.join(dir, 'data'));
  try {
    database.initialize();
    const db = database.connection;
    const now = new Date().toISOString();
    const remote = path.join(dir, 'remote');
    fs.mkdirSync(remote);
    fs.writeFileSync(path.join(remote, 'gitconfig'), '');
    // This machine hides a file the sandbox does not.
    fs.writeFileSync(path.join(dir, 'excludes'), 'hidden-here.txt\nblocked\n');
    fs.writeFileSync(path.join(dir, 'gitconfig'), `[core]\n\texcludesFile = ${path.join(dir, 'excludes')}\n`);

    // A repository with an origin, a setup script and an ignored folder.
    const origin = path.join(dir, 'origin.git');
    git(dir, ['init', '-q', '--bare', '-b', 'main', origin]);
    const repo = path.join(dir, 'repo');
    git(dir, ['clone', '-q', origin, repo]);
    fs.mkdirSync(path.join(repo, '.agents'));
    fs.writeFileSync(path.join(repo, '.agents', 'setup'), 'mkdir -p deps && echo installed > deps/marker\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'deps/\n');
    fs.writeFileSync(path.join(repo, 'keep.txt'), 'keep\n');
    fs.writeFileSync(path.join(repo, 'gone.txt'), 'gone\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'init']);
    git(repo, ['push', '-q', 'origin', 'main']);
    git(repo, ['remote', 'set-head', 'origin', 'main']);
    const worktree = path.join(dir, 'wt');
    git(repo, ['worktree', 'add', '-q', '-b', 'patterm/s1', worktree, 'main']);
    db.prepare('insert into projects(id,name,path,created_at,updated_at) values(?,?,?,?,?)').run('p', 'Project', repo, now, now);
    db.prepare(`insert into worktrees(id,project_id,repo_path,worktree_path,branch,created_by,created_at) values('w','p',?,?,'patterm/s1','user',?)`).run(repo, worktree, now);

    const backend = new MappedBackend(dir, remote);
    const sandboxes = new SandboxService(database, new SettingsService(database), { runtimeDir: path.join(dir, 'runtime'), backend: () => backend });
    await sandboxes.saveSettings({ token: 'token' });

    // A new sandbox starts from the default branch on origin.
    assert.equal(await sandboxes.baseRef(repo), git(repo, ['rev-parse', 'origin/main']));

    // The copy is a clone of the branch with the default branch beside it,
    // and the repository's setup script has run there.
    const row = await sandboxes.provision({ project_id: 'p', worktree_id: 'w', path: worktree });
    const copy = backend.remotePath(worktree);
    assert.equal(git(copy, ['branch', '--show-current']), 'patterm/s1');
    assert.equal(git(copy, ['rev-parse', 'HEAD']), git(worktree, ['rev-parse', 'HEAD']));
    assert.equal(git(copy, ['symbolic-ref', 'refs/remotes/origin/HEAD']), 'refs/remotes/origin/main');
    assert.equal(fs.readFileSync(path.join(copy, 'deps', 'marker'), 'utf8'), 'installed\n');
    assert.equal(fs.readFileSync(path.join(copy, 'keep.txt'), 'utf8'), 'keep\n');
    assert.equal(row.synced_head, git(worktree, ['rev-parse', 'HEAD']));

    // The agent commits, edits, adds and deletes in the sandbox; a sync
    // brings all of it here, except ignored files.
    fs.writeFileSync(path.join(copy, 'feature.txt'), 'feature\n');
    git(copy, ['add', 'feature.txt']);
    git(copy, ['commit', '-qm', 'feature']);
    fs.writeFileSync(path.join(copy, 'keep.txt'), 'edited\n');
    fs.writeFileSync(path.join(copy, 'new.txt'), 'untracked\n');
    fs.rmSync(path.join(copy, 'gone.txt'));
    const first = await sandboxes.sync(row.id);
    assert.equal(first.changed, true);
    assert.equal(git(worktree, ['rev-parse', 'HEAD']), git(copy, ['rev-parse', 'HEAD']));
    assert.equal(git(worktree, ['branch', '--show-current']), 'patterm/s1');
    assert.equal(fs.readFileSync(path.join(worktree, 'keep.txt'), 'utf8'), 'edited\n');
    assert.equal(fs.readFileSync(path.join(worktree, 'new.txt'), 'utf8'), 'untracked\n');
    assert.equal(fs.existsSync(path.join(worktree, 'gone.txt')), false);
    assert.equal(fs.existsSync(path.join(worktree, 'deps')), false, 'ignored files stay in the sandbox');
    assert.equal(git(worktree, ['diff', '--cached', '--name-only']), '', 'the local index is left alone');
    assert.equal((await sandboxes.sync(row.id)).changed, false);

    // A later change replaces the earlier one, including an untracked file
    // the sandbox removed.
    fs.rmSync(path.join(copy, 'new.txt'));
    fs.writeFileSync(path.join(copy, 'keep.txt'), 'edited again\n');
    await sandboxes.sync(row.id);
    assert.equal(fs.existsSync(path.join(worktree, 'new.txt')), false);
    assert.equal(fs.readFileSync(path.join(worktree, 'keep.txt'), 'utf8'), 'edited again\n');

    // A change made here is never overwritten.
    fs.writeFileSync(path.join(worktree, 'keep.txt'), 'made here\n');
    await assert.rejects(sandboxes.sync(row.id), /changed since the last sync/);
    assert.match(sandboxes.get(row.id)?.sync_error ?? '', /changed since the last sync/);
    assert.equal(fs.readFileSync(path.join(worktree, 'keep.txt'), 'utf8'), 'made here\n');
    fs.writeFileSync(path.join(worktree, 'keep.txt'), 'edited again\n');
    await sandboxes.sync(row.id);
    assert.equal(sandboxes.get(row.id)?.sync_error, null);

    // Nothing made here is overwritten, whatever form it takes. Each refusal
    // leaves the worktree as it was, and the next sync works once it is put
    // back.
    const refuses = async (pattern: RegExp, undo: () => void) => {
      const before = git(worktree, ['rev-parse', 'HEAD']);
      await assert.rejects(sandboxes.sync(row.id), pattern);
      assert.equal(git(worktree, ['rev-parse', 'HEAD']), before);
      undo();
      await sandboxes.sync(row.id);
    };
    // An edit and a new file made while the sandbox's work is in transit.
    fs.writeFileSync(path.join(copy, 'transit.txt'), 'remote\n');
    backend.beforeNext = () => {
      fs.writeFileSync(path.join(worktree, 'keep.txt'), 'edited during sync\n');
      fs.writeFileSync(path.join(worktree, 'mine.txt'), 'mine\n');
    };
    await refuses(/changed since the last sync/, () => {
      assert.equal(fs.readFileSync(path.join(worktree, 'keep.txt'), 'utf8'), 'edited during sync\n');
      assert.equal(fs.readFileSync(path.join(worktree, 'mine.txt'), 'utf8'), 'mine\n');
      assert.equal(fs.existsSync(path.join(worktree, 'transit.txt')), false);
      fs.writeFileSync(path.join(worktree, 'keep.txt'), 'edited again\n');
      fs.rmSync(path.join(worktree, 'mine.txt'));
    });
    assert.equal(fs.readFileSync(path.join(worktree, 'transit.txt'), 'utf8'), 'remote\n');
    // Content only in the index.
    fs.writeFileSync(path.join(worktree, 'keep.txt'), 'staged only\n');
    git(worktree, ['add', 'keep.txt']);
    fs.writeFileSync(path.join(worktree, 'keep.txt'), 'edited again\n');
    fs.writeFileSync(path.join(copy, 'transit.txt'), 'remote 2\n');
    await refuses(/changed since the last sync/, () => {
      assert.equal(git(worktree, ['show', ':keep.txt']), 'staged only');
      git(worktree, ['reset', '-q', '--', 'keep.txt']);
    });
    // An ignored file a sandbox commit starts tracking.
    fs.mkdirSync(path.join(worktree, 'deps'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'deps', 'state'), 'local data\n');
    fs.writeFileSync(path.join(copy, 'deps', 'state'), 'remote data\n');
    git(copy, ['add', '-f', 'deps/state']);
    git(copy, ['commit', '-qm', 'track state']);
    await refuses(/would be overwritten/, () => {
      assert.equal(fs.readFileSync(path.join(worktree, 'deps', 'state'), 'utf8'), 'local data\n');
      fs.rmSync(path.join(worktree, 'deps'), { recursive: true });
    });
    assert.equal(fs.readFileSync(path.join(worktree, 'deps', 'state'), 'utf8'), 'remote data\n');
    // A branch of the same name here, with a commit the sandbox lacks, and
    // one checked out in another worktree.
    git(repo, ['checkout', '-q', '-b', 'existing']);
    fs.writeFileSync(path.join(repo, 'unpublished.txt'), 'unpublished\n');
    git(repo, ['add', 'unpublished.txt']);
    git(repo, ['commit', '-qm', 'unpublished']);
    const existing = git(repo, ['rev-parse', 'existing']);
    git(repo, ['checkout', '-q', 'main']);
    git(copy, ['checkout', '-q', '-b', 'existing']);
    await refuses(/already exists here with commits/, () => {
      assert.equal(git(repo, ['rev-parse', 'existing']), existing);
      git(copy, ['branch', '-q', '-m', 'patterm/s1-next']);
    });
    assert.equal(git(worktree, ['branch', '--show-current']), 'patterm/s1-next');
    git(copy, ['branch', '-q', '-M', 'main']);
    await refuses(/checked out in another worktree/, () => git(copy, ['branch', '-q', '-m', 'patterm/s1-next']));
    // Back on its own branch, which moves forward.
    git(copy, ['checkout', '-q', 'patterm/s1']);
    git(copy, ['branch', '-q', '-D', 'patterm/s1-next']);
    await sandboxes.sync(row.id);
    assert.equal(git(worktree, ['branch', '--show-current']), 'patterm/s1');

    // A sandbox that went back to an earlier commit.
    const earlier = git(copy, ['rev-parse', 'HEAD~1']);
    git(copy, ['reset', '-q', '--hard', 'HEAD~1']);
    await sandboxes.sync(row.id);
    assert.equal(git(worktree, ['rev-parse', 'HEAD']), earlier);
    assert.equal(fs.existsSync(path.join(worktree, 'deps', 'state')), false);

    // A file only this machine's ignore rules hide comes back once, and
    // does not count as a local change afterwards.
    fs.writeFileSync(path.join(copy, 'hidden-here.txt'), 'hidden\n');
    assert.equal((await sandboxes.sync(row.id)).changed, true);
    assert.equal(fs.readFileSync(path.join(worktree, 'hidden-here.txt'), 'utf8'), 'hidden\n');
    assert.equal((await sandboxes.sync(row.id)).changed, false);
    // Pruning cannot take the synced tree away.
    git(worktree, ['gc', '-q', '--prune=now']);
    assert.equal((await sandboxes.sync(row.id)).changed, false);

    // Work committed here while the sandbox's work is in transit.
    fs.writeFileSync(path.join(copy, 'transit.txt'), 'remote 3\n');
    const committedFrom = git(worktree, ['rev-parse', 'HEAD']);
    backend.beforeNext = () => {
      git(worktree, ['add', '-A']);
      git(worktree, ['commit', '-qm', 'committed here']);
    };
    await assert.rejects(sandboxes.sync(row.id), /changed since the last sync/);
    assert.equal(git(worktree, ['log', '-1', '--format=%s']), 'committed here');
    git(worktree, ['reset', '-q', committedFrom]);
    await sandboxes.sync(row.id);
    // A local ignored file where the sandbox needs a directory.
    fs.writeFileSync(path.join(worktree, 'blocked'), 'local data\n');
    fs.mkdirSync(path.join(copy, 'blocked'));
    fs.writeFileSync(path.join(copy, 'blocked', 'child'), 'remote\n');
    await refuses(/would be overwritten.*blocked\/child/, () => {
      assert.equal(fs.readFileSync(path.join(worktree, 'blocked'), 'utf8'), 'local data\n');
      fs.rmSync(path.join(worktree, 'blocked'));
    });
    assert.equal(fs.readFileSync(path.join(worktree, 'blocked', 'child'), 'utf8'), 'remote\n');
    // A synced file the sandbox turns into a directory, and back; but not
    // over an ignored local file inside it.
    fs.writeFileSync(path.join(copy, 'shape'), 'file\n');
    git(copy, ['add', 'shape']);
    git(copy, ['commit', '-qm', 'shape file']);
    await sandboxes.sync(row.id);
    git(copy, ['rm', '-q', 'shape']);
    fs.mkdirSync(path.join(copy, 'shape'));
    fs.writeFileSync(path.join(copy, 'shape', 'child'), 'child\n');
    git(copy, ['add', 'shape']);
    git(copy, ['commit', '-qm', 'shape directory']);
    await sandboxes.sync(row.id);
    assert.equal(fs.readFileSync(path.join(worktree, 'shape', 'child'), 'utf8'), 'child\n');
    fs.writeFileSync(path.join(worktree, 'shape', 'blocked'), 'local data\n');
    git(copy, ['rm', '-q', '-r', 'shape']);
    fs.writeFileSync(path.join(copy, 'shape'), 'file again\n');
    git(copy, ['add', 'shape']);
    git(copy, ['commit', '-qm', 'shape file again']);
    await refuses(/would be overwritten.*shape/, () => {
      assert.equal(fs.readFileSync(path.join(worktree, 'shape', 'blocked'), 'utf8'), 'local data\n');
      fs.rmSync(path.join(worktree, 'shape', 'blocked'));
    });
    assert.equal(fs.readFileSync(path.join(worktree, 'shape'), 'utf8'), 'file again\n');
    // Git already busy here.
    const lock = path.join(repo, '.git', 'worktrees', 'wt', 'index.lock');
    fs.writeFileSync(lock, '');
    fs.writeFileSync(path.join(copy, 'transit.txt'), 'remote 4\n');
    await refuses(/Git is busy/, () => fs.rmSync(lock));
    assert.equal(fs.readFileSync(path.join(worktree, 'transit.txt'), 'utf8'), 'remote 4\n');

    // Shutting down waits for a running sync and refuses new ones.
    const closing = new SandboxService(database, new SettingsService(database), { runtimeDir: path.join(dir, 'runtime'), backend: () => backend });
    let release!: () => void;
    backend.gate = new Promise((resolve) => { release = resolve; });
    fs.writeFileSync(path.join(copy, 'transit.txt'), 'remote 5\n');
    let synced = false;
    const running = closing.sync(row.id).then(() => { synced = true; });
    const disposed = closing.dispose();
    await assert.rejects(closing.sync(row.id), /shutting down/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(synced, false);
    backend.gate = null;
    release();
    await disposed;
    assert.equal(synced, true, 'dispose waited for the sync');
    await running;
    assert.equal(fs.readFileSync(path.join(worktree, 'transit.txt'), 'utf8'), 'remote 5\n');

    // Rewritten history in the sandbox still comes back.
    git(copy, ['commit', '-qa', '--amend', '-m', 'feature, amended']);
    await sandboxes.sync(row.id);
    assert.equal(git(worktree, ['log', '-1', '--format=%s']), 'feature, amended');

    // Pushing syncs, then pushes from this machine.
    fs.writeFileSync(path.join(copy, 'more.txt'), 'more\n');
    git(copy, ['add', '-A']);
    git(copy, ['commit', '-qm', 'more']);
    const pushed = await sandboxes.push(sandboxes.get(row.id)!);
    assert.equal(pushed.exit_code, 0, pushed.stderr);
    assert.equal(pushed.branch, 'patterm/s1');
    assert.equal(git(origin, ['rev-parse', 'patterm/s1']), git(copy, ['rev-parse', 'HEAD']));

    // When its last agent goes idle, the sandbox's work comes back.
    fs.writeFileSync(path.join(copy, 'idle.txt'), 'idle\n');
    sandboxes.setBusy(sandboxes.get(row.id)!, 'proc', true);
    sandboxes.setBusy(sandboxes.get(row.id)!, 'proc', false);
    for (let tries = 0; tries < 100 && !fs.existsSync(path.join(worktree, 'idle.txt')); tries += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fs.readFileSync(path.join(worktree, 'idle.txt'), 'utf8'), 'idle\n');
    // A sync asked for now runs after that one finishes.
    await sandboxes.sync(row.id);
    assert.deepEqual(backend.holds, ['hold:patterm', 'release:patterm']);

    // Deleting brings the last changes back first; it refuses to lose a
    // local change unless told to discard.
    fs.writeFileSync(path.join(copy, 'last.txt'), 'last\n');
    const kept = fs.readFileSync(path.join(worktree, 'keep.txt'));
    fs.writeFileSync(path.join(worktree, 'keep.txt'), 'local again\n');
    await assert.rejects(sandboxes.delete(row.id), /not deleted/);
    assert.deepEqual(backend.destroyed, []);
    fs.writeFileSync(path.join(worktree, 'keep.txt'), kept);
    await sandboxes.delete(row.id);
    assert.equal(fs.readFileSync(path.join(worktree, 'last.txt'), 'utf8'), 'last\n');
    assert.equal(backend.destroyed.length, 1);
    await sandboxes.dispose();
    console.log('sandbox sync smoke passed');
  } finally {
    database.dispose();
    removeTree(dir);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
