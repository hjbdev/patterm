import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseService } from '../DatabaseService';
import type { SettingsService } from '../SettingsService';
import { resolveService } from '../../Platform/ServiceProcess';
import type { SandboxBackend, SandboxExecOptions, SandboxExecResult, SandboxTunnel } from './SandboxBackend';
import { SpritesBackend, shellQuote } from './SpritesBackend';

const CODEX_EXEC_SERVICE = 'patterm-codex-exec';
const CODEX_EXEC_PORT = 7777;
// A busy agent holds its sandbox awake for this long, renewed well before it
// lapses; a crashed Patterm lets the hold expire.
const HOLD_SECONDS = 600;
const HOLD_RENEW_MS = 4 * 60_000;
const SETUP_TIMEOUT_MS = 30 * 60_000;
// A repository's own setup script, run once in each new sandbox.
const SETUP_SCRIPT = '.agents/setup';

export interface SandboxRow {
  id: string;
  project_id: string;
  worktree_id: string | null;
  backend: string;
  remote_name: string;
  path: string;
  status: 'creating' | 'ready' | 'failed';
  error: string | null;
  exec_token: string | null;
  exec_port: number | null;
  synced_head: string | null;
  synced_patch: string | null;
  synced_at: string | null;
  sync_error: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface SandboxSummary {
  id: string;
  project_id: string;
  worktree_id: string | null;
  backend: string;
  name: string;
  path: string;
  status: string;
  error: string | null;
  synced_at: string | null;
  sync_error: string | null;
  created_at: string;
  agents: number;
}

export interface WorkingFile {
  kind: 'missing' | 'file' | 'symlink' | 'directory' | 'other';
  bytes?: Buffer;
  target?: string;
}

export interface WorkingFileStat {
  kind: 'missing' | 'file' | 'symlink' | 'other';
  size: number;
  lines: number;
  binary: boolean;
  version: string;
}

export interface SyncResult {
  head: string;
  branch: string | null;
  patch: string;
  changed: boolean;
}

// A worktree's uncommitted changes, untracked files included, as one patch
// from a throwaway index; the same command runs here and in a sandbox.
const PATCH_ARGS = ['-c', 'core.quotePath=false', 'diff', '--cached', '--binary', '--no-color', '--no-ext-diff', 'HEAD'];
const WORKING_PATCH_SCRIPT = [
  'set -e',
  'index=$(mktemp); trap \'rm -f "$index"\' EXIT',
  'export GIT_INDEX_FILE="$index"',
  'git read-tree HEAD',
  'git add -A',
  `git ${PATCH_ARGS.join(' ')}`
].join('\n');

type BackendFactory = (token: string) => SandboxBackend;

// Remote sandboxes for worktrees. A sandbox holds a copy of one worktree at
// the same absolute path; agents launched on that worktree keep running here,
// with their own logins, and run their file and shell tools in the sandbox.
export class SandboxService {
  private readonly tunnels = new Map<string, Promise<SandboxTunnel>>();
  private readonly holds = new Map<string, { keys: Set<string>; timer: NodeJS.Timeout }>();
  private readonly provisioning = new Map<string, Promise<SandboxRow>>();
  // Launches between choosing a sandbox and registering their session.
  private readonly launching = new Map<string, number>();
  // Sandboxes being deleted; no launch may choose them.
  private readonly deleting = new Set<string>();
  // Sandboxes whose Codex exec-server was defined since Patterm started, with
  // its token; the provider keeps it running, so later turns skip the call.
  private readonly execServers = new Map<string, Promise<string>>();
  // One sync at a time per sandbox; a sync asked for while one runs follows it.
  private readonly syncs = new Map<string, Promise<SyncResult>>();

  constructor(
    private readonly database: DatabaseService,
    private readonly settings: Pick<SettingsService, 'sandboxSettings' | 'saveSandboxSettings'>,
    private readonly options: {
      runtimeDir: string;
      env?: NodeJS.ProcessEnv;
      backend?: BackendFactory;
      onChanged?: () => void;
      log?: (event: string, data: Record<string, unknown>) => void;
    }
  ) {}

  // Settings as clients see them: whether a token is saved, never the token.
  state(): { backend: string; configured: boolean; sandboxes: SandboxSummary[] } {
    const settings = this.settings.sandboxSettings();
    return { backend: settings.backend, configured: Boolean(settings.token), sandboxes: this.list() };
  }

  async saveSettings(input: { token?: string | null | undefined }): Promise<ReturnType<SandboxService['state']>> {
    const current = this.settings.sandboxSettings();
    const token = input.token === undefined ? current.token : input.token?.trim() || null;
    if (token && token !== current.token) await this.factory(token).verify();
    this.settings.saveSandboxSettings({ ...current, token });
    // Another token may reach another account, so nothing opened with the
    // old one is reused.
    if (token !== current.token) {
      for (const id of [...this.holds.keys()]) this.stopHold(id);
      this.execServers.clear();
      await Promise.all([...this.tunnels.keys()].map((id) => this.closeTunnel(id)));
    }
    this.options.onChanged?.();
    return this.state();
  }

  configured(): boolean {
    return Boolean(this.settings.sandboxSettings().token);
  }

  list(projectId?: string): SandboxSummary[] {
    const rows = this.database.connection.prepare(`
      select sandboxes.*, (
        select count(*) from sessions
        where sessions.worktree_id = sandboxes.worktree_id and sessions.exited_at is null
      ) as agents
      from sandboxes
      where sandboxes.deleted_at is null and (? is null or sandboxes.project_id = ?)
      order by sandboxes.created_at desc
    `).all(projectId ?? null, projectId ?? null) as Array<SandboxRow & { agents: number }>;
    return rows.map((row) => ({
      id: row.id, project_id: row.project_id, worktree_id: row.worktree_id, backend: row.backend, name: row.remote_name,
      path: row.path, status: row.status, error: row.error, synced_at: row.synced_at, sync_error: row.sync_error, created_at: row.created_at, agents: row.agents
    }));
  }

  get(id: string): SandboxRow | null {
    return (this.database.connection.prepare('select * from sandboxes where id = ? and deleted_at is null').get(id) as SandboxRow | undefined) ?? null;
  }

  forWorktree(worktreeId: string | null | undefined): SandboxRow | null {
    if (!worktreeId) return null;
    return (this.database.connection.prepare('select * from sandboxes where worktree_id = ? and deleted_at is null').get(worktreeId) as SandboxRow | undefined) ?? null;
  }

  // The sandbox whose copy contains this local path, if any. Worktree
  // registration keeps other projects out of a sandbox's path.
  forPath(target: string, statuses: SandboxRow['status'][] = ['ready']): SandboxRow | null {
    const rows = this.database.connection.prepare('select * from sandboxes where deleted_at is null').all() as unknown as SandboxRow[];
    return rows.find((row) => statuses.includes(row.status) && (target === row.path || target.startsWith(row.path + path.sep))) ?? null;
  }

  // The project owning a sandbox that covers this path, so another project
  // cannot register it. Symlinks are resolved on both sides, so an alias of
  // the path is caught too.
  ownerOfPath(target: string): string | null {
    const candidates = new Set([target, canonicalPath(target)]);
    const rows = this.database.connection.prepare('select * from sandboxes where deleted_at is null').all() as unknown as SandboxRow[];
    for (const row of rows) {
      for (const root of new Set([row.path, canonicalPath(row.path)])) {
        for (const candidate of candidates) {
          if (candidate === root || candidate.startsWith(root + path.sep)) return row.project_id;
        }
      }
    }
    return null;
  }

  // The sandbox an agent's tools run in, from its MCP identity.
  forIdentity(identity: string | null | undefined): SandboxRow | null {
    if (!identity) return null;
    return (this.database.connection.prepare(`
      select sandboxes.* from sessions
      join sandboxes on sandboxes.worktree_id = sessions.worktree_id and sandboxes.deleted_at is null
      where sessions.mcp_identity = ? and sessions.exited_at is null
    `).get(identity) as SandboxRow | undefined) ?? null;
  }

  forProcess(processId: string): SandboxRow | null {
    return (this.database.connection.prepare(`
      select sandboxes.* from sessions
      join sandboxes on sandboxes.worktree_id = sessions.worktree_id and sandboxes.deleted_at is null
      where sessions.process_id = ? order by sessions.started_at desc limit 1
    `).get(processId) as SandboxRow | undefined) ?? null;
  }

  // Creates the sandbox for a worktree, or returns the one it has. The copy
  // starts from the worktree's commit; nothing uncommitted goes with it.
  provision(input: { project_id: string; worktree_id: string; path: string }): Promise<SandboxRow> {
    const existing = this.forWorktree(input.worktree_id);
    if (existing && this.deleting.has(existing.id)) return Promise.reject(new Error('This worktree\'s sandbox is being deleted'));
    if (existing?.status === 'ready') return Promise.resolve(existing);
    const running = this.provisioning.get(input.worktree_id);
    if (running) return running;
    // Git and diff requests for the path go to the sandbox, so it must not
    // also be a worktree of another project.
    const others = this.database.connection.prepare('select worktree_path from worktrees where project_id != ?').all(input.project_id) as Array<{ worktree_path: string }>;
    if (others.some((row) => row.worktree_path === input.path || row.worktree_path.startsWith(input.path + path.sep) || input.path.startsWith(row.worktree_path + path.sep))) {
      return Promise.reject(new Error('Another project registers this worktree, so it cannot have a sandbox'));
    }
    const promise = this.create(input, existing).finally(() => this.provisioning.delete(input.worktree_id));
    this.provisioning.set(input.worktree_id, promise);
    return promise;
  }

  // Marks a launch that has chosen this sandbox but has no session yet, so
  // the sandbox cannot be deleted under it. Call the result when it ends.
  beginLaunch(id: string): () => void {
    if (this.deleting.has(id)) throw new Error('This worktree\'s sandbox is being deleted');
    this.launching.set(id, (this.launching.get(id) ?? 0) + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const count = (this.launching.get(id) ?? 1) - 1;
      if (count > 0) this.launching.set(id, count);
      else this.launching.delete(id);
    };
  }

  // Brings the sandbox's work into the local worktree first, unless asked to
  // discard it.
  async delete(id: string, options: { discard?: boolean } = {}): Promise<void> {
    const row = this.get(id);
    if (!row) return;
    if ((row.worktree_id && this.provisioning.has(row.worktree_id)) || this.launching.has(row.id)) throw new Error('This sandbox is still being set up for an agent; delete it once the agent has started');
    if (this.deleting.has(row.id)) throw new Error('This sandbox is already being deleted');
    const live = this.database.connection.prepare('select count(*) as count from sessions where worktree_id = ? and exited_at is null').get(row.worktree_id) as { count: number };
    if (live.count > 0) throw new Error('Stop the agents using this sandbox before deleting it');
    this.deleting.add(row.id);
    try {
      if (row.status === 'ready' && !options.discard) {
        await this.sync(row.id).catch((error: unknown) => {
          throw new Error(`Could not bring the sandbox's work back, so it was not deleted: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      await this.closeTunnel(row.id);
      this.stopHold(row.id);
      this.execServers.delete(row.id);
      await this.backend().destroy(row.remote_name);
      const now = new Date().toISOString();
      this.database.connection.prepare('update sandboxes set deleted_at = ?, updated_at = ? where id = ?').run(now, now, row.id);
    } finally {
      this.deleting.delete(row.id);
    }
    this.options.onChanged?.();
  }

  exec(row: SandboxRow, argv: string[], options: SandboxExecOptions = {}): Promise<SandboxExecResult> {
    return this.backend(row.backend).exec(row.remote_name, argv, options);
  }

  // Reads one working-tree file for diff review without following a
  // symlink, and refuses paths that resolve outside the worktree.
  async readWorkingFile(row: SandboxRow, root: string, relative: string, maxBytes: number): Promise<WorkingFile> {
    const script = [
      'root=$(realpath -- "$1") || exit 3',
      'target="$root/$2"',
      'parent=$(realpath -m -- "$(dirname -- "$target")")',
      'case "$parent/" in "$root"/*) ;; *) echo outside >&2; exit 4 ;; esac',
      'file="$parent/$(basename -- "$target")"',
      'if [ -L "$file" ]; then printf L; readlink -- "$file"; exit 0; fi',
      'if [ -d "$file" ]; then printf D; exit 0; fi',
      'if [ ! -e "$file" ]; then printf M; exit 0; fi',
      'if [ ! -f "$file" ]; then printf O; exit 0; fi',
      'printf F; head -c "$3" -- "$file"'
    ].join('\n');
    const result = await this.exec(row, ['sh', '-c', script, 'sh', root, relative, String(maxBytes)], { timeoutMs: 60_000 });
    if (result.exitCode === 4) throw new Error(`${relative} resolves outside the worktree`);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString('utf8').trim() || `could not read ${relative} in the sandbox`);
    const kind = result.stdout.subarray(0, 1).toString('utf8');
    const rest = result.stdout.subarray(1);
    if (kind === 'L') return { kind: 'symlink', target: rest.toString('utf8') };
    if (kind === 'D') return { kind: 'directory' };
    if (kind === 'M') return { kind: 'missing' };
    if (kind === 'F') return { kind: 'file', bytes: rest };
    return { kind: 'other' };
  }

  // Sizes, line counts and content versions of working-tree files for a diff
  // summary, in one call. Paths go over stdin; lines of a file over maxBytes
  // are not counted.
  async statWorkingFiles(row: SandboxRow, root: string, paths: string[], maxBytes: number): Promise<Map<string, WorkingFileStat>> {
    const stats = new Map<string, WorkingFileStat>();
    if (!paths.length) return stats;
    const script = [
      'cd -- "$1" || exit 3',
      'while IFS= read -r -d \'\' f; do',
      '  if [ -L "$f" ]; then printf \'L\\t0\\t1\\t0\\t%s\\0\' "$(readlink -- "$f" | cksum)"',
      '  elif [ -f "$f" ]; then',
      '    size=$(wc -c < "$f" | tr -d \' \'); nul=$(head -c 8000 -- "$f" | tr -dc \'\\000\' | wc -c | tr -d \' \'); lines=0',
      '    if [ "$size" -le "$2" ] && [ "$nul" = 0 ]; then lines=$(wc -l < "$f" | tr -d \' \'); [ -n "$(tail -c1 -- "$f" | tr -d \'\\000\')" ] && lines=$((lines + 1)); fi',
      '    printf \'F\\t%s\\t%s\\t%s\\t%s\\0\' "$size" "$lines" "$nul" "$(cksum < "$f")"',
      '  elif [ -e "$f" ]; then printf \'O\\t0\\t0\\t0\\t-\\0\'',
      '  else printf \'M\\t0\\t0\\t0\\t-\\0\'; fi',
      'done'
    ].join('\n');
    const result = await this.exec(row, ['bash', '-c', script, 'bash', root, String(maxBytes)], { stdin: paths.map((entry) => `${entry}\0`).join(''), timeoutMs: 120_000 });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString('utf8').trim() || 'could not read the sandbox\'s working tree');
    const records = result.stdout.toString('utf8').split('\0');
    paths.forEach((entry, index) => {
      const [kind, size, lines, nul, version] = (records[index] ?? '').split('\t');
      stats.set(entry, {
        kind: kind === 'L' ? 'symlink' : kind === 'F' ? 'file' : kind === 'O' ? 'other' : 'missing',
        size: Number(size) || 0, lines: Number(lines) || 0, binary: Number(nul) > 0, version: version?.trim().replace(/\s+/g, ':') || 'missing'
      });
    });
    return stats;
  }

  // Codex runs its commands and patches through its own exec-server, started
  // in the sandbox and reached through a loopback tunnel that needs a token.
  async codexEnvironment(row: SandboxRow): Promise<{ environmentId: string; execServerUrl: string; authBearerToken: string }> {
    let service = this.execServers.get(row.id);
    if (!service) {
      service = this.startExecServer(row);
      service.catch(() => this.execServers.delete(row.id));
      this.execServers.set(row.id, service);
    }
    const token = await service;
    const tunnel = await this.tunnel(row);
    return { environmentId: `patterm-sandbox-${row.id}`, execServerUrl: `ws://127.0.0.1:${tunnel.port}`, authBearerToken: token };
  }

  // A sandboxed Codex agent's environment for its next turn, with the
  // working directory its session runs in.
  async codexEnvironmentFor(processId: string): Promise<{ environmentId: string; execServerUrl: string; authBearerToken: string; cwd: string } | null> {
    const row = this.forProcess(processId);
    if (!row) return null;
    // A sandboxed agent never falls back to running here.
    if (row.status !== 'ready' || this.deleting.has(row.id)) throw new Error('This agent\'s sandbox is not available');
    const session = this.database.connection.prepare('select cwd from sessions where process_id = ? order by started_at desc limit 1').get(processId) as { cwd: string | null } | undefined;
    return { ...await this.codexEnvironment(row), cwd: session?.cwd ?? row.path };
  }

  // Keeps the sandbox from pausing while any of its agents is working, so
  // commands they left running keep their state.
  // Keys are process IDs; each renewal drops agents that stopped or went
  // idle without an activity change reaching here.
  setBusy(row: SandboxRow, key: string, busy: boolean): void {
    let hold = this.holds.get(row.id);
    if (busy) {
      if (hold) { hold.keys.add(key); return; }
      const renew = () => {
        const current = this.holds.get(row.id);
        if (!current) return;
        for (const processId of current.keys) if (!this.working(processId)) current.keys.delete(processId);
        if (!current.keys.size) { this.endHold(row); return; }
        this.call(row, 'hold.failed', (backend) => backend.hold(row.remote_name, 'patterm', HOLD_SECONDS));
      };
      hold = { keys: new Set([key]), timer: setInterval(renew, HOLD_RENEW_MS) };
      hold.timer.unref?.();
      this.holds.set(row.id, hold);
      this.call(row, 'hold.failed', (backend) => backend.hold(row.remote_name, 'patterm', HOLD_SECONDS));
      return;
    }
    if (!hold) return;
    hold.keys.delete(key);
    if (!hold.keys.size) this.endHold(row);
  }

  // After a restart, holds sandboxes awake for agents that are still working
  // and reopens the tunnels of Codex agents whose app-server kept running.
  restore(): void {
    const rows = this.database.connection.prepare(`
      select sandboxes.*, sessions.process_id as session_process_id, sessions.harness as session_harness from sessions
      join sandboxes on sandboxes.worktree_id = sessions.worktree_id and sandboxes.deleted_at is null and sandboxes.status = 'ready'
      where sessions.exited_at is null and sessions.process_id is not null
    `).all() as Array<SandboxRow & { session_process_id: string; session_harness: string }>;
    for (const { session_process_id: processId, session_harness: harness, ...row } of rows) {
      if (this.working(processId)) this.setBusy(row, processId, true);
      if (harness === 'codex' && row.exec_token) {
        this.execServers.set(row.id, Promise.resolve(row.exec_token));
        void Promise.resolve().then(() => this.tunnel(row)).catch((error: unknown) => this.log('tunnel.failed', row, error));
      }
    }
  }

  async dispose(): Promise<void> {
    for (const id of [...this.holds.keys()]) this.stopHold(id);
    await Promise.all([...this.tunnels.keys()].map((id) => this.closeTunnel(id)));
  }

  private async create(input: { project_id: string; worktree_id: string; path: string }, existing: SandboxRow | null): Promise<SandboxRow> {
    const backend = this.backend();
    const now = new Date().toISOString();
    const id = existing?.id ?? `sandbox_${randomUUID()}`;
    const name = existing?.remote_name ?? `patterm-${randomBytes(5).toString('hex')}`;
    if (existing) {
      this.database.connection.prepare(`update sandboxes set status = 'creating', error = null, updated_at = ? where id = ?`).run(now, id);
    } else {
      this.database.connection.prepare(`
        insert into sandboxes (id, project_id, worktree_id, backend, remote_name, path, status, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, 'creating', ?, ?)
      `).run(id, input.project_id, input.worktree_id, backend.id, name, input.path, now, now);
    }
    this.options.onChanged?.();
    try {
      if (await backend.status(name) === null) await backend.create(name);
      const baseline = await this.copyWorktree(backend, name, input.path);
      await this.runSetup(backend, name, input.path);
      this.database.connection.prepare(`update sandboxes set status = 'ready', error = null, synced_head = ?, synced_patch = ?, updated_at = ? where id = ?`)
        .run(baseline.head, baseline.patch, new Date().toISOString(), id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.database.connection.prepare(`update sandboxes set status = 'failed', error = ?, updated_at = ? where id = ?`).run(message, new Date().toISOString(), id);
      this.options.onChanged?.();
      throw new Error(`Could not set up the sandbox: ${message}`);
    }
    this.options.onChanged?.();
    const row = this.get(id);
    if (!row) throw new Error('The sandbox was deleted while it was being set up');
    return row;
  }

  // Sends the worktree's branch as a git bundle and clones it at the same
  // path. Only commits go; the local worktree's state at that moment is the
  // baseline the first sync expects.
  private async copyWorktree(backend: SandboxBackend, name: string, worktreePath: string): Promise<{ head: string; patch: string }> {
    const git = (args: string[]) => this.local(worktreePath, args);
    const branch = (await git(['branch', '--show-current'])).stdout.toString().trim();
    const head = (await git(['rev-parse', 'HEAD'])).stdout.toString().trim();
    const origin = withoutCredentials(await git(['remote', 'get-url', 'origin']).then((result) => result.stdout.toString().trim()).catch(() => ''));
    // Diff review compares a branch with the default branch, so its refs go
    // too, and origin/HEAD keeps naming it.
    const originHead = await git(['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']).then((result) => result.stdout.toString().trim()).catch(() => '');
    const defaults = [...new Set([originHead.replace(/^refs\/remotes\/origin\//, ''), 'main', 'master'].filter(Boolean))];
    const listed = await git(['for-each-ref', '--format=%(refname)', ...defaults.flatMap((name) => [`refs/heads/${name}`, `refs/remotes/origin/${name}`])])
      .then((result) => result.stdout.toString().split('\n').filter(Boolean)).catch(() => [] as string[]);
    const userName = await git(['config', '--get', 'user.name']).then((result) => result.stdout.toString().trim()).catch(() => '');
    const userEmail = await git(['config', '--get', 'user.email']).then((result) => result.stdout.toString().trim()).catch(() => '');
    fs.mkdirSync(this.options.runtimeDir, { recursive: true, mode: 0o700 });
    const bundle = path.join(this.options.runtimeDir, `sandbox-${randomUUID()}.bundle`);
    try {
      await git(['bundle', 'create', bundle, 'HEAD', ...new Set([...(branch ? [`refs/heads/${branch}`] : []), ...listed])]);
      await this.must(backend.exec(name, ['sh', '-c', 'cat > /tmp/patterm-worktree.bundle'], { stdin: fs.readFileSync(bundle), timeoutMs: 15 * 60_000 }), 'upload the worktree');
    } finally {
      fs.rmSync(bundle, { force: true });
    }
    const target = shellQuote(worktreePath);
    const script = [
      'set -e',
      `sudo mkdir -p ${shellQuote(path.dirname(worktreePath))}`,
      `sudo chown "$(id -u):$(id -g)" ${shellQuote(path.dirname(worktreePath))}`,
      `rm -rf ${target}`,
      `git init -q ${target}`,
      `cd ${target}`,
      `git fetch -q --update-head-ok /tmp/patterm-worktree.bundle 'refs/heads/*:refs/heads/*' 'refs/remotes/origin/*:refs/remotes/origin/*'`,
      // A detached HEAD has no branch ref to fetch.
      'git fetch -q /tmp/patterm-worktree.bundle HEAD',
      `git checkout -q ${branch ? `-B ${shellQuote(branch)}` : '--detach'} ${shellQuote(head)}`,
      origin ? `git remote add origin ${shellQuote(origin)}` : 'true',
      originHead && listed.includes(originHead) ? `git symbolic-ref refs/remotes/origin/HEAD ${shellQuote(originHead)}` : 'true',
      userName ? `git config --global user.name ${shellQuote(userName)}` : 'true',
      userEmail ? `git config --global user.email ${shellQuote(userEmail)}` : 'true',
      'rm -f /tmp/patterm-worktree.bundle'
    ].join('\n');
    // The script names the remote and the git user, so it goes over stdin
    // rather than into a command line.
    await this.must(backend.exec(name, ['sh'], { stdin: script, timeoutMs: 15 * 60_000 }), 'clone the worktree');
    return { head, patch: digest(await this.workingPatch(worktreePath)) };
  }

  // Runs the repository's setup script once, in the new sandbox, so agents
  // start with dependencies installed.
  private async runSetup(backend: SandboxBackend, name: string, worktreePath: string): Promise<void> {
    const script = [
      `[ -f ${SETUP_SCRIPT} ] || exit 0`,
      `if [ -x ${SETUP_SCRIPT} ]; then ./${SETUP_SCRIPT}; else bash ${SETUP_SCRIPT}; fi > /tmp/patterm-setup.log 2>&1 && exit 0`,
      'status=$?; tail -c 2000 /tmp/patterm-setup.log >&2; exit $status'
    ].join('\n');
    await this.must(backend.exec(name, ['bash', '-lc', script], { cwd: worktreePath, timeoutMs: SETUP_TIMEOUT_MS }), `run ${SETUP_SCRIPT}`);
  }

  // The commit a sandbox for a new conversation starts from: the remote's
  // default branch, freshly fetched, else this checkout's HEAD.
  async baseRef(repoPath: string): Promise<string> {
    await this.local(repoPath, ['fetch', '-q', 'origin'], { timeoutMs: 60_000 }).catch(() => undefined);
    const originHead = (await this.local(repoPath, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']).catch(() => null))?.stdout.toString().trim();
    return originHead ? (await this.local(repoPath, ['rev-parse', originHead])).stdout.toString().trim() : this.localHead(repoPath);
  }

  async localHead(worktreePath: string): Promise<string> {
    return (await this.local(worktreePath, ['rev-parse', 'HEAD'])).stdout.toString().trim();
  }

  // Makes the local worktree match the sandbox: its branch, commits and
  // uncommitted files (ignored files excepted). Refuses when the local
  // worktree changed since the last sync, so nothing made here is lost.
  sync(id: string): Promise<SyncResult> {
    const next = (this.syncs.get(id) ?? Promise.resolve(null)).catch(() => null).then(() => this.syncNow(id));
    this.syncs.set(id, next);
    void next.catch(() => undefined).finally(() => { if (this.syncs.get(id) === next) this.syncs.delete(id); });
    return next;
  }

  // Syncs, then pushes the branch from this machine, where the owner's git
  // credentials and network reach the remote. The sandbox needs neither.
  async push(row: SandboxRow, options: { forceWithLease?: boolean } = {}): Promise<{ branch: string; exit_code: number; stdout: string; stderr: string }> {
    await this.sync(row.id);
    const branch = (await this.local(row.path, ['symbolic-ref', '-q', '--short', 'HEAD']).catch(() => null))?.stdout.toString().trim();
    if (!branch) throw new Error('The sandbox is not on a branch; check one out before pushing');
    const result = await this.local(row.path, ['push', ...(options.forceWithLease ? ['--force-with-lease'] : []), '-u', 'origin', branch], { timeoutMs: 5 * 60_000, allowFailure: true });
    return { branch, exit_code: result.code, stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8') };
  }

  private async syncNow(id: string): Promise<SyncResult> {
    const row = this.get(id);
    if (!row || row.status !== 'ready') throw new Error('This sandbox is not ready');
    try {
      const result = await this.pullBack(row);
      this.database.connection.prepare('update sandboxes set synced_head = ?, synced_patch = ?, synced_at = ?, sync_error = null, updated_at = ? where id = ?')
        .run(result.head, result.patch, new Date().toISOString(), new Date().toISOString(), row.id);
      this.options.onChanged?.();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.database.connection.prepare('update sandboxes set sync_error = ?, updated_at = ? where id = ?').run(message, new Date().toISOString(), row.id);
      this.options.onChanged?.();
      throw error;
    }
  }

  private async pullBack(row: SandboxRow): Promise<SyncResult> {
    const localHead = await this.localHead(row.path);
    if (localHead !== row.synced_head || digest(await this.workingPatch(row.path)) !== row.synced_patch) {
      throw new Error('The local worktree has changed since the last sync. Commit or discard those changes in the sandbox instead, then sync again');
    }
    const state = await this.must(this.exec(row, ['sh', '-c', 'git rev-parse HEAD && git symbolic-ref -q --short HEAD || true'], { cwd: row.path, timeoutMs: 60_000 }), 'read the sandbox\'s branch');
    const [remoteHead = '', remoteBranch = ''] = state.stdout.toString('utf8').split('\n').map((line) => line.trim());
    if (!/^[0-9a-f]{40,64}$/.test(remoteHead)) throw new Error('The sandbox has no commit checked out');
    if (remoteHead !== localHead) {
      // New commits only, when the sandbox still has the last synced one.
      const bundle = await this.must(this.exec(row, ['sh', '-c', [
        'set -e; file=$(mktemp)',
        'if git cat-file -e "$1^{commit}" 2>/dev/null; then git bundle create -q "$file" HEAD "^$1"; else git bundle create -q "$file" HEAD; fi',
        'cat "$file"; rm -f "$file"'
      ].join('\n'), 'sh', localHead], { cwd: row.path, timeoutMs: 5 * 60_000 }), 'bundle the sandbox\'s commits');
      fs.mkdirSync(this.options.runtimeDir, { recursive: true, mode: 0o700 });
      const file = path.join(this.options.runtimeDir, `sandbox-sync-${randomUUID()}.bundle`);
      try {
        fs.writeFileSync(file, bundle.stdout, { mode: 0o600 });
        await this.local(row.path, ['fetch', '-q', file, 'HEAD']);
      } finally {
        fs.rmSync(file, { force: true });
      }
    }
    const patch = await this.must(this.exec(row, ['bash', '-c', WORKING_PATCH_SCRIPT], { cwd: row.path, timeoutMs: 5 * 60_000 }), 'read the sandbox\'s changes');
    const localBranch = (await this.local(row.path, ['symbolic-ref', '-q', '--short', 'HEAD'], { allowFailure: true })).stdout.toString().trim();
    // Nothing moved: leave the files, and their timestamps, alone.
    if (remoteHead === localHead && remoteBranch === localBranch && digest(patch.stdout) === row.synced_patch) {
      return { head: remoteHead, branch: remoteBranch || null, patch: row.synced_patch, changed: false };
    }
    await this.local(row.path, ['checkout', '-q', '-f', ...(remoteBranch ? ['-B', remoteBranch] : ['--detach']), remoteHead]);
    await this.local(row.path, ['clean', '-q', '-fd']);
    if (patch.stdout.length) await this.local(row.path, ['apply', '--binary', '-'], { stdin: patch.stdout });
    const synced = digest(await this.workingPatch(row.path));
    return { head: remoteHead, branch: remoteBranch || null, patch: synced, changed: remoteHead !== localHead || remoteBranch !== localBranch || synced !== row.synced_patch };
  }

  // Every uncommitted change in a worktree, untracked files included, as one
  // binary patch. A throwaway index leaves the real one alone.
  private async workingPatch(worktreePath: string): Promise<Buffer> {
    fs.mkdirSync(this.options.runtimeDir, { recursive: true, mode: 0o700 });
    const index = { GIT_INDEX_FILE: path.join(this.options.runtimeDir, `sandbox-index-${randomUUID()}`) };
    try {
      await this.local(worktreePath, ['read-tree', 'HEAD'], { env: index });
      await this.local(worktreePath, ['add', '-A'], { env: index });
      return (await this.local(worktreePath, PATCH_ARGS, { env: index })).stdout;
    } finally {
      fs.rmSync(index.GIT_INDEX_FILE, { force: true });
    }
  }

  private local(cwd: string, args: string[], options: { stdin?: Buffer; timeoutMs?: number; allowFailure?: boolean; env?: Record<string, string> } = {}): Promise<{ code: number; stdout: Buffer; stderr: Buffer }> {
    const command = resolveService('git', args);
    return new Promise((resolve, reject) => {
      const child = spawn(command.command, command.args, { cwd, windowsHide: true, env: { ...(this.options.env ?? process.env), GIT_TERMINAL_PROMPT: '0', ...options.env } });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const timer = options.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), options.timeoutMs) : null;
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        const result = { code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err) };
        if (result.code !== 0 && !options.allowFailure) reject(new Error(result.stderr.toString('utf8').trim() || `git ${args[0]} exited with ${result.code}`));
        else resolve(result);
      });
      child.stdin.end(options.stdin);
    });
  }

  private async must(result: Promise<SandboxExecResult>, action: string): Promise<SandboxExecResult> {
    const done = await result;
    if (done.exitCode !== 0) throw new Error(`could not ${action}: ${done.stderr.toString('utf8').trim().slice(-2_000) || `exit ${done.exitCode}`}`);
    return done;
  }

  // Starts Codex's exec-server with a token made once per sandbox. Callers
  // share this promise, so concurrent launches agree on the token.
  private async startExecServer(row: SandboxRow): Promise<string> {
    let token = this.get(row.id)?.exec_token ?? null;
    if (!token) {
      token = randomBytes(32).toString('hex');
      this.database.connection.prepare('update sandboxes set exec_token = ?, updated_at = ? where id = ?').run(token, new Date().toISOString(), row.id);
    }
    const digest = createHash('sha256').update(token).digest('hex');
    await this.backend(row.backend).ensureService(row.remote_name, CODEX_EXEC_SERVICE, {
      command: 'codex',
      args: ['exec-server', '--listen', `ws://127.0.0.1:${CODEX_EXEC_PORT}`, '--ws-auth', 'capability-token', '--ws-token-sha256', digest],
      dir: row.path
    });
    return token;
  }

  private working(processId: string): boolean {
    const row = this.database.connection.prepare(`
      select processes.activity from processes join sessions on sessions.process_id = processes.id
      where processes.id = ? and sessions.exited_at is null and processes.status = 'running'
    `).get(processId) as { activity: string | null } | undefined;
    return row?.activity === 'working' || row?.activity === 'thinking';
  }

  // Once no agent is working, the sandbox's work comes back here and it may
  // pause.
  private endHold(row: SandboxRow): void {
    this.stopHold(row.id);
    this.call(row, 'release.failed', (backend) => backend.release(row.remote_name, 'patterm'));
    this.call(row, 'sync.failed', () => this.sync(row.id));
  }

  // Background provider calls log failures, including a removed token.
  private call(row: SandboxRow, event: string, run: (backend: SandboxBackend) => Promise<unknown>): void {
    void Promise.resolve().then(() => run(this.backend(row.backend))).catch((error: unknown) => this.log(event, row, error));
  }

  private tunnel(row: SandboxRow): Promise<SandboxTunnel> {
    let tunnel = this.tunnels.get(row.id);
    if (!tunnel) {
      // The same port across Patterm restarts lets a Codex app-server that
      // outlived Patterm reconnect to its environment.
      const backend = this.backend(row.backend);
      tunnel = backend.tunnel(row.remote_name, CODEX_EXEC_PORT, row.exec_port ?? 0)
        .catch(() => backend.tunnel(row.remote_name, CODEX_EXEC_PORT, 0))
        .then((opened) => {
          this.database.connection.prepare('update sandboxes set exec_port = ?, updated_at = ? where id = ?').run(opened.port, new Date().toISOString(), row.id);
          return opened;
        });
      tunnel.catch(() => this.tunnels.delete(row.id));
      this.tunnels.set(row.id, tunnel);
    }
    return tunnel;
  }

  private async closeTunnel(id: string): Promise<void> {
    const tunnel = this.tunnels.get(id);
    this.tunnels.delete(id);
    await tunnel?.then((opened) => opened.close()).catch(() => undefined);
  }

  private stopHold(id: string): void {
    const hold = this.holds.get(id);
    if (hold) clearInterval(hold.timer);
    this.holds.delete(id);
  }

  private backend(id = 'sprites'): SandboxBackend {
    if (id !== 'sprites') throw new Error(`Unknown sandbox backend: ${id}`);
    const token = this.settings.sandboxSettings().token;
    if (!token) throw new Error('Add a Sprites token in Settings › Sandboxes first');
    return this.factory(token);
  }

  private factory(token: string): SandboxBackend {
    return this.options.backend?.(token) ?? new SpritesBackend(token);
  }

  private log(event: string, row: SandboxRow, error: unknown): void {
    this.options.log?.(event, { sandbox_id: row.id, error: error instanceof Error ? error.message : String(error) });
  }
}

function digest(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

// Resolves symlinks in the longest existing prefix of a path, which may not
// exist yet itself.
function canonicalPath(target: string): string {
  const resolved = path.resolve(target);
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return resolved;
    existing = parent;
  }
  try {
    return path.join(fs.realpathSync(existing), path.relative(existing, resolved));
  } catch {
    return resolved;
  }
}

// An HTTPS remote can carry a token as its user info; the sandbox gets the
// remote without it.
function withoutCredentials(remote: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) return remote;
  try {
    const url = new URL(remote);
    if (!url.username && !url.password) return remote;
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return '';
  }
}
