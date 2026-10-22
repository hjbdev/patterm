import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { DatabaseService } from '../DatabaseService';
import type { SettingsService } from '../SettingsService';
import { resolveService } from '../../Platform/ServiceProcess';
import type { SandboxBackend, SandboxExecOptions, SandboxExecResult, SandboxTunnel } from './SandboxBackend';
import { SpritesBackend, shellQuote } from './SpritesBackend';

const execFileAsync = promisify(execFile);
const CODEX_EXEC_SERVICE = 'patterm-codex-exec';
const CODEX_EXEC_PORT = 7777;
// A busy agent holds its sandbox awake for this long, renewed well before it
// lapses; a crashed Patterm lets the hold expire.
const HOLD_SECONDS = 600;
const HOLD_RENEW_MS = 4 * 60_000;

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
  created_at: string;
  agents: number;
}

export interface WorkingFile {
  kind: 'missing' | 'file' | 'symlink' | 'directory' | 'other';
  bytes?: Buffer;
  target?: string;
}

type BackendFactory = (token: string) => SandboxBackend;

// Remote sandboxes for worktrees. A sandbox holds a copy of one worktree at
// the same absolute path; agents launched on that worktree keep running here,
// with their own logins, and run their file and shell tools in the sandbox.
export class SandboxService {
  private readonly tunnels = new Map<string, Promise<SandboxTunnel>>();
  private readonly holds = new Map<string, { keys: Set<string>; timer: NodeJS.Timeout }>();
  private readonly provisioning = new Map<string, Promise<SandboxRow>>();
  // Sandboxes whose Codex exec-server was defined since Patterm started; the
  // provider keeps it running and restarts it, so later turns skip the call.
  private readonly execServers = new Map<string, Promise<void>>();

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
  state(): { backend: string; configured: boolean; share_github: boolean; sandboxes: SandboxSummary[] } {
    const settings = this.settings.sandboxSettings();
    return { backend: settings.backend, configured: Boolean(settings.token), share_github: settings.shareGitHub, sandboxes: this.list() };
  }

  async saveSettings(input: { token?: string | null | undefined; share_github?: boolean | undefined }): Promise<ReturnType<SandboxService['state']>> {
    const current = this.settings.sandboxSettings();
    const token = input.token === undefined ? current.token : input.token?.trim() || null;
    if (token && token !== current.token) await this.factory(token).verify();
    this.settings.saveSandboxSettings({ ...current, token, shareGitHub: input.share_github ?? current.shareGitHub });
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
      path: row.path, status: row.status, error: row.error, created_at: row.created_at, agents: row.agents
    }));
  }

  get(id: string): SandboxRow | null {
    return (this.database.connection.prepare('select * from sandboxes where id = ? and deleted_at is null').get(id) as SandboxRow | undefined) ?? null;
  }

  forWorktree(worktreeId: string | null | undefined): SandboxRow | null {
    if (!worktreeId) return null;
    return (this.database.connection.prepare('select * from sandboxes where worktree_id = ? and deleted_at is null').get(worktreeId) as SandboxRow | undefined) ?? null;
  }

  // The sandbox whose copy contains this local path, if any.
  forPath(target: string): SandboxRow | null {
    const rows = this.database.connection.prepare(`select * from sandboxes where deleted_at is null and status = 'ready'`).all() as unknown as SandboxRow[];
    return rows.find((row) => target === row.path || target.startsWith(row.path + path.sep)) ?? null;
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
  // starts from the worktree's commit plus its uncommitted tracked changes.
  provision(input: { project_id: string; worktree_id: string; path: string }): Promise<SandboxRow> {
    const existing = this.forWorktree(input.worktree_id);
    if (existing?.status === 'ready') return Promise.resolve(existing);
    const running = this.provisioning.get(input.worktree_id);
    if (running) return running;
    const promise = this.create(input, existing).finally(() => this.provisioning.delete(input.worktree_id));
    this.provisioning.set(input.worktree_id, promise);
    return promise;
  }

  async delete(id: string): Promise<void> {
    const row = this.get(id);
    if (!row) return;
    const live = this.database.connection.prepare('select count(*) as count from sessions where worktree_id = ? and exited_at is null').get(row.worktree_id) as { count: number };
    if (live.count > 0) throw new Error('Stop the agents using this sandbox before deleting it');
    await this.closeTunnel(row.id);
    this.stopHold(row.id);
    this.execServers.delete(row.id);
    await this.backend().destroy(row.remote_name);
    const now = new Date().toISOString();
    this.database.connection.prepare('update sandboxes set deleted_at = ?, updated_at = ? where id = ?').run(now, now, row.id);
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

  // Codex runs its commands and patches through its own exec-server, started
  // in the sandbox and reached through a loopback tunnel that needs a token.
  async codexEnvironment(row: SandboxRow): Promise<{ environmentId: string; execServerUrl: string; authBearerToken: string }> {
    let token = row.exec_token;
    if (!token) {
      token = randomBytes(32).toString('hex');
      this.database.connection.prepare('update sandboxes set exec_token = ?, updated_at = ? where id = ?').run(token, new Date().toISOString(), row.id);
    }
    const digest = createHash('sha256').update(token).digest('hex');
    let service = this.execServers.get(row.id);
    if (!service) {
      service = this.backend(row.backend).ensureService(row.remote_name, CODEX_EXEC_SERVICE, {
        command: 'codex',
        args: ['exec-server', '--listen', `ws://127.0.0.1:${CODEX_EXEC_PORT}`, '--ws-auth', 'capability-token', '--ws-token-sha256', digest],
        dir: row.path
      });
      service.catch(() => this.execServers.delete(row.id));
      this.execServers.set(row.id, service);
    }
    await service;
    const tunnel = await this.tunnel(row);
    return { environmentId: `patterm-sandbox-${row.id}`, execServerUrl: `ws://127.0.0.1:${tunnel.port}`, authBearerToken: token };
  }

  // A sandboxed Codex agent's environment for its next turn, with the
  // working directory its session runs in.
  async codexEnvironmentFor(processId: string): Promise<{ environmentId: string; execServerUrl: string; authBearerToken: string; cwd: string } | null> {
    const row = this.forProcess(processId);
    if (row?.status !== 'ready') return null;
    const session = this.database.connection.prepare('select cwd from sessions where process_id = ? order by started_at desc limit 1').get(processId) as { cwd: string | null } | undefined;
    return { ...await this.codexEnvironment(row), cwd: session?.cwd ?? row.path };
  }

  // Keeps the sandbox from pausing while any of its agents is working, so
  // commands they left running keep their state.
  setBusy(row: SandboxRow, key: string, busy: boolean): void {
    let hold = this.holds.get(row.id);
    if (busy) {
      if (hold) { hold.keys.add(key); return; }
      const renew = () => { void this.backend(row.backend).hold(row.remote_name, 'patterm', HOLD_SECONDS).catch((error: unknown) => this.log('hold.failed', row, error)); };
      hold = { keys: new Set([key]), timer: setInterval(renew, HOLD_RENEW_MS) };
      hold.timer.unref?.();
      this.holds.set(row.id, hold);
      renew();
      return;
    }
    if (!hold) return;
    hold.keys.delete(key);
    if (hold.keys.size) return;
    this.stopHold(row.id);
    void this.backend(row.backend).release(row.remote_name, 'patterm').catch((error: unknown) => this.log('release.failed', row, error));
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
      await this.copyWorktree(backend, name, input.path);
      if (this.settings.sandboxSettings().shareGitHub) await this.shareGitHub(backend, name);
      this.database.connection.prepare(`update sandboxes set status = 'ready', error = null, updated_at = ? where id = ?`).run(new Date().toISOString(), id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.database.connection.prepare(`update sandboxes set status = 'failed', error = ?, updated_at = ? where id = ?`).run(message, new Date().toISOString(), id);
      this.options.onChanged?.();
      throw new Error(`Could not set up the sandbox: ${message}`);
    }
    this.options.onChanged?.();
    return this.get(id)!;
  }

  // Sends the worktree's branch as a git bundle and clones it at the same
  // path, then applies uncommitted tracked changes. Untracked files stay here.
  private async copyWorktree(backend: SandboxBackend, name: string, worktreePath: string): Promise<void> {
    const git = (args: string[], encoding: 'utf8' | 'buffer' = 'utf8') => {
      const command = resolveService('git', args);
      return execFileAsync(command.command, command.args, { cwd: worktreePath, encoding, maxBuffer: 2 * 1024 * 1024 * 1024, windowsHide: true, env: this.options.env ?? process.env });
    };
    const branch = (await git(['branch', '--show-current'])).stdout.toString().trim();
    const head = (await git(['rev-parse', 'HEAD'])).stdout.toString().trim();
    const origin = await git(['remote', 'get-url', 'origin']).then((result) => result.stdout.toString().trim()).catch(() => '');
    const userName = await git(['config', '--get', 'user.name']).then((result) => result.stdout.toString().trim()).catch(() => '');
    const userEmail = await git(['config', '--get', 'user.email']).then((result) => result.stdout.toString().trim()).catch(() => '');
    const changes = (await git(['diff', '--binary', 'HEAD'], 'buffer')).stdout as Buffer;
    fs.mkdirSync(this.options.runtimeDir, { recursive: true, mode: 0o700 });
    const bundle = path.join(this.options.runtimeDir, `sandbox-${randomUUID()}.bundle`);
    try {
      await git(['bundle', 'create', bundle, 'HEAD', ...(branch ? [branch] : [])]);
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
      `git clone -q --no-checkout /tmp/patterm-worktree.bundle ${target}`,
      `cd ${target}`,
      `git checkout -q ${branch ? `-B ${shellQuote(branch)} ` : ''}${shellQuote(head)}`,
      origin ? `git remote set-url origin ${shellQuote(origin)}` : 'git remote remove origin',
      userName ? `git config --global user.name ${shellQuote(userName)}` : 'true',
      userEmail ? `git config --global user.email ${shellQuote(userEmail)}` : 'true',
      'rm -f /tmp/patterm-worktree.bundle'
    ].join('\n');
    await this.must(backend.exec(name, ['sh', '-c', script], { timeoutMs: 15 * 60_000 }), 'clone the worktree');
    if (changes.length) await this.must(backend.exec(name, ['git', 'apply', '--binary', '-'], { cwd: worktreePath, stdin: changes, timeoutMs: 5 * 60_000 }), 'apply uncommitted changes');
  }

  // The GitHub CLI token goes over the exec stream's stdin, never a command
  // line, on either machine.
  private async shareGitHub(backend: SandboxBackend, name: string): Promise<void> {
    const gh = resolveService('gh', ['auth', 'token']);
    const token = (await execFileAsync(gh.command, gh.args, { encoding: 'utf8', windowsHide: true, env: this.options.env ?? process.env, timeout: 30_000 })).stdout.trim();
    if (!token) throw new Error('The GitHub CLI on this machine is not signed in');
    await this.must(backend.exec(name, ['gh', 'auth', 'login', '--with-token'], { stdin: `${token}\n`, timeoutMs: 60_000 }), 'sign in to GitHub');
    await this.must(backend.exec(name, ['gh', 'auth', 'setup-git'], { timeoutMs: 60_000 }), 'set up GitHub for git');
  }

  private async must(result: Promise<SandboxExecResult>, action: string): Promise<SandboxExecResult> {
    const done = await result;
    if (done.exitCode !== 0) throw new Error(`could not ${action}: ${done.stderr.toString('utf8').trim().slice(-2_000) || `exit ${done.exitCode}`}`);
    return done;
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

