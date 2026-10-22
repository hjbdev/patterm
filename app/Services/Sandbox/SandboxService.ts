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
  synced_tree: string | null;
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
  tree: string;
  changed: boolean;
}

// Reads a sandbox's commit, branch, the commits the caller lacks (it passes
// its own commit) and its uncommitted files as a patch against that commit,
// all from one moment. Prints four header lines, then the bundle and patch.
const SNAPSHOT_REF = 'refs/patterm/snapshot';
const SNAPSHOT_SCRIPT = [
  'set -e',
  'tmp=$(mktemp -d); trap \'rm -rf "$tmp"; git update-ref -d refs/patterm/snapshot 2>/dev/null || true\' EXIT',
  'head=$(git rev-parse HEAD); branch=$(git symbolic-ref -q --short HEAD || true); here=$1',
  'GIT_INDEX_FILE="$tmp/index" git read-tree "$head"',
  'GIT_INDEX_FILE="$tmp/index" git add -A',
  'GIT_INDEX_FILE="$tmp/index" git -c core.quotePath=false diff --cached --binary --no-color --no-ext-diff "$head" > "$tmp/patch"',
  ': > "$tmp/bundle"',
  // Nothing to send when the caller already has the commit.
  'if [ "$head" != "$here" ] && ! { git cat-file -e "$here^{commit}" 2>/dev/null && git merge-base --is-ancestor "$head" "$here"; }; then',
  '  git update-ref refs/patterm/snapshot "$head"',
  '  if git cat-file -e "$here^{commit}" 2>/dev/null; then git bundle create -q "$tmp/bundle" refs/patterm/snapshot "^$here"; else git bundle create -q "$tmp/bundle" refs/patterm/snapshot; fi',
  'fi',
  'printf \'%s\\n%s\\n%s\\n%s\\n\' "$head" "$branch" "$(wc -c < "$tmp/bundle" | tr -d \' \')" "$(wc -c < "$tmp/patch" | tr -d \' \')"',
  'cat "$tmp/bundle" "$tmp/patch"'
].join('\n');

function parseSnapshot(output: Buffer): { head: string; branch: string; bundle: Buffer; patch: Buffer } {
  const lines: string[] = [];
  let offset = 0;
  for (let index = 0; index < 4; index += 1) {
    const end = output.indexOf(10, offset);
    if (end === -1) throw new Error('The sandbox sent an incomplete snapshot');
    lines.push(output.subarray(offset, end).toString('utf8'));
    offset = end + 1;
  }
  const [head = '', branch = '', bundleBytes = '', patchBytes = ''] = lines;
  const bundleLength = Number(bundleBytes);
  const patchLength = Number(patchBytes);
  if (!/^[0-9a-f]{40,64}$/.test(head)) throw new Error('The sandbox has no commit checked out');
  if (!Number.isInteger(bundleLength) || !Number.isInteger(patchLength) || offset + bundleLength + patchLength !== output.length) {
    throw new Error('The sandbox sent an incomplete snapshot');
  }
  return { head, branch, bundle: output.subarray(offset, offset + bundleLength), patch: output.subarray(offset + bundleLength) };
}

// Where a sync parks the sandbox's commit until a branch or HEAD holds it.
function syncRef(id: string): string {
  return `refs/patterm/sandbox/${id.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

// Keeps the last synced tree from being pruned.
function stateRef(id: string): string {
  return `refs/patterm/sandbox-state/${id.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

// Whether something on disk that the last sync did not write (`synced`)
// stands where git would put a new path: the path itself, a file where it
// needs a directory, or a directory where it needs a file.
function obstructs(root: string, entry: string, synced: Set<string>): boolean {
  const parts = entry.split('/');
  for (let depth = 1; depth <= parts.length; depth += 1) {
    const relative = parts.slice(0, depth).join('/');
    let stat: fs.Stats;
    try { stat = fs.lstatSync(path.join(root, relative)); } catch { return false; }
    if (stat.isDirectory()) {
      if (depth === parts.length) return !onlySynced(root, relative, synced);
      continue;
    }
    return !synced.has(relative);
  }
  return false;
}

// Whether a directory holds nothing but files the last sync wrote.
function onlySynced(root: string, directory: string, synced: Set<string>, budget = { left: 10_000 }): boolean {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(path.join(root, directory), { withFileTypes: true }); } catch { return false; }
  for (const entry of entries) {
    if ((budget.left -= 1) < 0) return false;
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory() ? !onlySynced(root, relative, synced, budget) : !synced.has(relative)) return false;
  }
  return true;
}

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
  private disposed = false;

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
      await this.local(row.path, ['update-ref', '-d', stateRef(row.id)], { allowFailure: true }).catch(() => undefined);
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

  // Stops new syncs and lets running ones finish, so none outlives the
  // database it records into.
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const id of [...this.holds.keys()]) this.stopHold(id);
    await Promise.allSettled([...this.syncs.values()]);
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
      await this.keepTree({ id, path: input.path }, baseline.tree);
      this.database.connection.prepare(`update sandboxes set status = 'ready', error = null, synced_head = ?, synced_tree = ?, updated_at = ? where id = ?`)
        .run(baseline.head, baseline.tree, new Date().toISOString(), id);
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
  private async copyWorktree(backend: SandboxBackend, name: string, worktreePath: string): Promise<{ head: string; tree: string }> {
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
    return { head, tree: await this.stateTree(worktreePath) };
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
    if (this.disposed) return Promise.reject(new Error('Patterm is shutting down'));
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
      this.database.connection.prepare('update sandboxes set synced_head = ?, synced_tree = ?, synced_at = ?, sync_error = null, updated_at = ? where id = ?')
        .run(result.head, result.tree, new Date().toISOString(), new Date().toISOString(), row.id);
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
    await this.assertUnchanged(row, localHead);

    // One remote call reads a consistent snapshot: the commit, its branch,
    // the commits this machine lacks, and the files as a patch against that
    // commit.
    const snapshot = await this.must(this.exec(row, ['bash', '-c', SNAPSHOT_SCRIPT, 'bash', localHead], { cwd: row.path, timeoutMs: 5 * 60_000 }), 'read the sandbox\'s work');
    const { head, branch, bundle, patch } = parseSnapshot(snapshot.stdout);
    if (branch) await this.local(row.path, ['check-ref-format', '--branch', branch]);
    if (bundle.length) {
      await this.withFile(bundle, (file) => this.local(row.path, ['fetch', '-q', '--no-write-fetch-head', file, `${SNAPSHOT_REF}:${syncRef(row.id)}`]));
    }
    await this.local(row.path, ['cat-file', '-e', `${head}^{commit}`]).catch(() => { throw new Error('The sandbox\'s commit did not arrive'); });

    // The result is built as a tree first, so a patch that does not apply
    // fails before anything here changes.
    const target = await this.withIndex(row.path, async (env) => {
      await this.local(row.path, ['read-tree', head], { env });
      if (patch.length) await this.local(row.path, ['apply', '--cached', '--binary', '-'], { env, stdin: patch });
      return (await this.local(row.path, ['write-tree'], { env })).stdout.toString().trim();
    });
    const localBranch = (await this.local(row.path, ['symbolic-ref', '-q', '--short', 'HEAD'], { allowFailure: true })).stdout.toString().trim();
    if (head === localHead && branch === localBranch && target === row.synced_tree) {
      await this.local(row.path, ['update-ref', '-d', syncRef(row.id)], { allowFailure: true });
      await this.keepTree(row, target);
      return { head, branch: branch || null, tree: target, changed: false };
    }
    // This worktree's own branch follows the sandbox. Another branch that
    // exists here only moves forward to the sandbox's commit, never losing
    // a commit, and never while another worktree has it checked out.
    let branchTip: string | null = null;
    if (branch && branch !== localBranch) {
      const existing = await this.local(row.path, ['rev-parse', '-q', '--verify', `refs/heads/${branch}^{commit}`], { allowFailure: true });
      if (existing.code === 0) {
        branchTip = existing.stdout.toString().trim();
        const used = (await this.local(row.path, ['worktree', 'list', '--porcelain'])).stdout.toString('utf8').split('\n').includes(`branch refs/heads/${branch}`);
        const forward = (await this.local(row.path, ['merge-base', '--is-ancestor', branchTip, head], { allowFailure: true })).code === 0;
        if (used || !forward) throw new Error(`The sandbox is on ${branch}, which already exists here ${used ? 'and is checked out in another worktree' : 'with commits the sandbox does not have'}; rename the branch in the sandbox, then sync again`);
      }
    }

    // The worktree's index lock keeps git here from staging or committing
    // while the files, refs and index change.
    return this.withIndexLock(row.path, async (lockPath, replaceIndex) => {
      const currentHead = await this.localHead(row.path);
      await this.assertUnchanged(row, currentHead);
      // Paths the sync adds were absent last time. One on disk now, or a
      // file where it needs a directory, is ignored or new here, and git
      // would replace it without asking.
      const added = (await this.local(row.path, ['diff-tree', '-r', '-z', '--name-only', '--diff-filter=A', row.synced_tree!, target])).stdout.toString('utf8').split('\0').filter(Boolean);
      // Files the last sync wrote may give way, as the checks above showed
      // them unchanged; anything else on disk belongs to this machine.
      const synced = added.length ? new Set((await this.local(row.path, ['ls-tree', '-r', '-z', '--name-only', row.synced_tree!])).stdout.toString('utf8').split('\0').filter(Boolean)) : new Set<string>();
      const obstructed = added.filter((entry) => obstructs(row.path, entry, synced));
      if (obstructed.length) throw new Error(`Local files would be overwritten, so nothing was synced: ${obstructed.slice(0, 5).join(', ')}${obstructed.length > 5 ? ', …' : ''}`);
      // Git writes the files only where they still match the last sync.
      const move = (from: string, to: string) => this.withIndex(row.path, async (env) => {
        await this.local(row.path, ['read-tree', from], { env });
        await this.local(row.path, ['update-index', '-q', '--refresh'], { env, allowFailure: true });
        return this.local(row.path, ['read-tree', '-m', '-u', from, to], { env, allowFailure: true });
      });
      const written = await move(row.synced_tree!, target);
      if (written.code !== 0) throw new Error(`Local files would be overwritten, so nothing was synced: ${written.stderr.toString('utf8').trim().slice(-1_000)}`);
      try {
        if (branch) {
          const old = branch === localBranch ? currentHead : branchTip ?? '0'.repeat(head.length);
          await this.local(row.path, ['update-ref', '-m', 'patterm: sync from sandbox', `refs/heads/${branch}`, head, old]);
          await this.local(row.path, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
        } else {
          await this.local(row.path, ['update-ref', '--no-deref', '-m', 'patterm: sync from sandbox', 'HEAD', head, currentHead]);
        }
      } catch (error) {
        await move(target, row.synced_tree!);
        throw error;
      }
      // Uncommitted work stays uncommitted here, and new files untracked.
      // The new index is written into the lock and takes its place.
      await this.local(row.path, ['update-ref', '-d', syncRef(row.id)], { allowFailure: true });
      await this.keepTree(row, target);
      await this.local(row.path, ['read-tree', head], { env: { GIT_INDEX_FILE: lockPath } });
      await this.local(row.path, ['update-index', '-q', '--refresh'], { env: { GIT_INDEX_FILE: lockPath }, allowFailure: true });
      replaceIndex();
      return { head, branch: branch || null, tree: target, changed: true };
    });
  }

  // Holds a worktree's index lock as git does, creating it exclusively. The
  // callback may rename it into place as the new index, which releases it:
  // after that the path may be another git command's lock, so it is left.
  private async withIndexLock<T>(worktreePath: string, run: (lockPath: string, replaceIndex: () => void) => Promise<T>): Promise<T> {
    const indexPath = path.resolve(worktreePath, (await this.local(worktreePath, ['rev-parse', '--git-path', 'index'])).stdout.toString().trim());
    const lockPath = `${indexPath}.lock`;
    try {
      fs.closeSync(fs.openSync(lockPath, 'wx'));
    } catch {
      throw new Error('Git is busy in the local worktree, so nothing was synced; sync again in a moment');
    }
    let held = true;
    try {
      return await run(lockPath, () => {
        fs.renameSync(lockPath, indexPath);
        held = false;
      });
    } finally {
      if (held) fs.rmSync(lockPath, { force: true });
    }
  }

  // The synced tree is only in Patterm's database; a ref keeps git from
  // pruning it. It points at a tree, never a commit.
  private async keepTree(row: Pick<SandboxRow, 'id' | 'path'>, tree: string): Promise<void> {
    await this.local(row.path, ['update-ref', stateRef(row.id), tree]);
  }

  // The local worktree must be exactly what the last sync left: the same
  // commit, an index matching it, and the same files.
  private async assertUnchanged(row: SandboxRow, localHead: string): Promise<void> {
    const staged = await this.local(row.path, ['diff', '--cached', '--quiet', 'HEAD', '--'], { allowFailure: true });
    if (localHead !== row.synced_head || staged.code !== 0 || !await this.sameFiles(row.path, row.synced_tree!)) {
      throw new Error('The local worktree has changed since the last sync. Commit or discard those changes in the sandbox instead, then sync again');
    }
  }

  // Whether the worktree's files are the tree a sync wrote. A file this
  // checkout's own ignore rules hide (a global excludes file, say) drops out
  // of a reading here; it still matches while it is on disk unchanged.
  private async sameFiles(worktreePath: string, written: string): Promise<boolean> {
    const current = await this.stateTree(worktreePath);
    if (current === written) return true;
    const fields = (await this.local(worktreePath, ['diff-tree', '-r', '-z', '--name-status', written, current])).stdout.toString('utf8').split('\0').filter(Boolean);
    for (let index = 0; index < fields.length; index += 2) {
      const [status, entry] = [fields[index], fields[index + 1] ?? ''];
      if (status !== 'D' || isSymlink(path.join(worktreePath, entry)) || !fs.existsSync(path.join(worktreePath, entry))) return false;
      const [onDisk, expected] = await Promise.all([
        this.local(worktreePath, ['hash-object', '--', entry]).then((result) => result.stdout.toString().trim()),
        this.local(worktreePath, ['rev-parse', `${written}:${entry}`]).then((result) => result.stdout.toString().trim())
      ]);
      if (onDisk !== expected) return false;
    }
    return true;
  }

  // A worktree's commit plus every uncommitted change, untracked files
  // included and ignored ones not, as a tree. A throwaway index leaves the
  // real one alone.
  private stateTree(worktreePath: string): Promise<string> {
    return this.withIndex(worktreePath, async (env) => {
      await this.local(worktreePath, ['read-tree', 'HEAD'], { env });
      await this.local(worktreePath, ['add', '-A'], { env });
      return (await this.local(worktreePath, ['write-tree'], { env })).stdout.toString().trim();
    });
  }

  private async withIndex<T>(worktreePath: string, run: (env: Record<string, string>) => Promise<T>): Promise<T> {
    fs.mkdirSync(this.options.runtimeDir, { recursive: true, mode: 0o700 });
    const env = { GIT_INDEX_FILE: path.join(this.options.runtimeDir, `sandbox-index-${randomUUID()}`) };
    try {
      return await run(env);
    } finally {
      fs.rmSync(env.GIT_INDEX_FILE, { force: true });
    }
  }

  private async withFile<T>(bytes: Buffer, run: (file: string) => Promise<T>): Promise<T> {
    fs.mkdirSync(this.options.runtimeDir, { recursive: true, mode: 0o700 });
    const file = path.join(this.options.runtimeDir, `sandbox-sync-${randomUUID()}.bundle`);
    try {
      fs.writeFileSync(file, bytes, { mode: 0o600 });
      return await run(file);
    } finally {
      fs.rmSync(file, { force: true });
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

function isSymlink(target: string): boolean {
  try { return fs.lstatSync(target).isSymbolicLink(); } catch { return false; }
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
