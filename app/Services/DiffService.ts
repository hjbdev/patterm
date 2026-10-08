import { constants as fsConstants, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { GitService } from './GitService';
import type { WorktreeService } from './WorktreeService';

export const diffScope = z.enum(['branch', 'uncommitted']);
export const diffCurrentInput = z.object({
  worktree_id: z.string().min(1),
  scope: diffScope.default('branch')
});
export const diffFileInput = diffCurrentInput.extend({ path: z.string().min(1).max(4096) });

export type DiffScope = z.infer<typeof diffScope>;
export type DiffCurrentInput = z.input<typeof diffCurrentInput>;
export type DiffFileInput = z.input<typeof diffFileInput>;
export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type_changed';

export interface DiffFile {
  path: string;
  previousPath: string | null;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  untracked: boolean;
  docs: boolean;
  tests: boolean;
  // Changes whenever either side's content may have: the base blob, plus the
  // working-tree file's size and modification time. Clients cache by it.
  version: string;
}

export interface DiffSummary {
  worktree: { id: string; repoPath: string; worktreePath: string; branch: string | null };
  scope: DiffScope;
  // ref is the branch used to find the split point, 'HEAD' when comparing with
  // HEAD, or null before the first commit (commit is then the empty tree).
  base: { ref: string | null; commit: string };
  head: string | null;
  files: DiffFile[];
  totals: { files: number; additions: number; deletions: number };
  truncated: boolean;
}

export interface DiffFileContents {
  path: string;
  previousPath: string | null;
  status: DiffFileStatus;
  binary: boolean;
  tooLarge: boolean;
  oldContents: string | null;
  newContents: string | null;
}

type WorktreeRecord = ReturnType<WorktreeService['get']>;

interface TrackedChange {
  path: string;
  previousPath: string | null;
  status: DiffFileStatus;
  oldMode: string;
  newMode: string;
  oldObject: string;
  newObject: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

interface LoadedDiff {
  summary: DiffSummary;
  root: string;
  tracked: Map<string, TrackedChange>;
}

// The UI polls these reads while agents commit, stage, and edit in the same
// worktree, so they must never take index.lock.
const GIT_READ = ['--no-optional-locks', '-c', 'core.quotepath=off'];
const SUMMARY_TTL_MS = 2_000;
const UNTRACKED_LIMIT = 500;
const UNTRACKED_READ_CONCURRENCY = 16;
const MAX_TEXT_BYTES = 1024 * 1024;
const BINARY_SNIFF_BYTES = 8000;
const GITLINK_MODE = '160000';
const EMPTY_TREES: Record<string, string> = {
  sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321'
};
const STATUSES: Record<string, DiffFileStatus> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'type_changed' };
const RAW_ENTRY = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/;
const NUMSTAT_ENTRY = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/;
const BINARY = Symbol('binary');
const TOO_LARGE = Symbol('tooLarge');
type FileSide = string | null | typeof BINARY | typeof TOO_LARGE;

// Branch diffs: everything on a worktree's branch since it split from the
// default branch, including staged, unstaged, and untracked files.
export class DiffService {
  private readonly git: GitService;
  // Overlapping polls for the same worktree and scope share one computation.
  private readonly loaded = new Map<string, { promise: Promise<LoadedDiff>; expiresAt: number }>();

  constructor(
    private readonly deps: {
      worktrees: Pick<WorktreeService, 'get'>;
      git?: GitService;
      now?: () => number;
    }
  ) {
    this.git = deps.git ?? new GitService();
  }

  async current(raw: DiffCurrentInput): Promise<DiffSummary> {
    const input = diffCurrentInput.parse(raw);
    return (await this.load(input.worktree_id, input.scope)).summary;
  }

  async file(raw: DiffFileInput): Promise<DiffFileContents> {
    const input = diffFileInput.parse(raw);
    const filePath = relativeDiffPath(input.path);
    const loaded = await this.load(input.worktree_id, input.scope);
    const file = loaded.summary.files.find((entry) => entry.path === filePath);
    if (!file) throw new Error(`${filePath} is not a changed file in this worktree's ${input.scope} diff`);

    const contents: DiffFileContents = {
      path: file.path,
      previousPath: file.previousPath,
      status: file.status,
      binary: file.binary,
      tooLarge: false,
      oldContents: null,
      newContents: null
    };
    if (file.binary) return contents;
    const change = file.untracked ? undefined : loaded.tracked.get(file.path);
    const [before, after] = await Promise.all([
      change && file.status !== 'added' ? this.baseSide(loaded.root, change) : null,
      file.status === 'deleted' ? null : this.workingTreeSide(loaded.root, file.path, change)
    ]);
    if (before === TOO_LARGE || after === TOO_LARGE) return { ...contents, tooLarge: true };
    if (before === BINARY || after === BINARY) return { ...contents, binary: true };
    return { ...contents, oldContents: before, newContents: after };
  }

  private load(worktreeId: string, scope: DiffScope): Promise<LoadedDiff> {
    const worktree = this.deps.worktrees.get(worktreeId);
    const now = this.now();
    for (const [key, entry] of this.loaded) {
      if (entry.expiresAt <= now) this.loaded.delete(key);
    }
    const key = `${worktree.id}\u0000${scope}`;
    const cached = this.loaded.get(key);
    if (cached) return cached.promise;

    const entry = { promise: this.compute(worktree, scope), expiresAt: Number.POSITIVE_INFINITY };
    this.loaded.set(key, entry);
    entry.promise.then(
      () => { entry.expiresAt = this.now() + SUMMARY_TTL_MS; },
      () => { if (this.loaded.get(key) === entry) this.loaded.delete(key); }
    );
    return entry.promise;
  }

  private async compute(worktree: WorktreeRecord, scope: DiffScope): Promise<LoadedDiff> {
    const cwd = worktree.worktree_path;
    if (!existsSync(cwd)) throw new Error(`worktree path does not exist: ${cwd}`);
    const [toplevel, head, branch, originHead] = await Promise.all([
      this.read(cwd, ['rev-parse', '--show-toplevel']),
      this.query(cwd, ['rev-parse', '-q', '--verify', 'HEAD^{commit}']),
      this.query(cwd, ['symbolic-ref', '-q', '--short', 'HEAD']),
      scope === 'branch' ? this.query(cwd, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']) : null
    ]);
    const root = toplevel.trim() || cwd;
    const headCommit = head?.trim() || null;
    const base = !headCommit
      ? { ref: null, commit: await this.emptyTree(root) }
      : scope === 'uncommitted'
        ? { ref: 'HEAD', commit: headCommit }
        : await this.branchBase(root, headCommit, originHead?.trim() || null);

    const [diff, others] = await Promise.all([
      this.read(root, ['diff', '--raw', '--numstat', '-z', '--find-renames', '--no-abbrev', '--no-ext-diff', '--no-textconv', '--no-color', base.commit, '--']),
      this.read(root, ['ls-files', '--others', '--exclude-standard', '-z'])
    ]);
    const tracked = parseTrackedChanges(diff);
    // Nested repositories are listed as directories; they have no file diff.
    const untrackedPaths = others.split('\0').filter((entry) => entry && !entry.endsWith('/'));
    const listedUntracked = untrackedPaths.slice(0, UNTRACKED_LIMIT);
    const [untrackedStats, trackedStats] = await Promise.all([
      mapLimit(listedUntracked, UNTRACKED_READ_CONCURRENCY, (filePath) => untrackedFile(root, filePath)),
      mapLimit(tracked, UNTRACKED_READ_CONCURRENCY, async (change) => (change.status === 'deleted' ? null : lstatIfExists(path.join(root, change.path)).catch(() => null)))
    ]);

    const files: DiffFile[] = tracked.map((change, index) => ({
      path: change.path,
      previousPath: change.previousPath,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      binary: change.binary,
      untracked: false,
      ...classifyDiffPath(change.path),
      version: `${change.oldObject}:${fileVersion(trackedStats[index] ?? null)}`
    }));
    listedUntracked.forEach((filePath, index) => {
      const stats = untrackedStats[index];
      if (!stats) return;
      files.push({ path: filePath, previousPath: null, status: 'added', additions: stats.additions, deletions: 0, binary: stats.binary, untracked: true, ...classifyDiffPath(filePath), version: `untracked:${stats.version}` });
    });
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : Number(a.untracked) - Number(b.untracked)));

    return {
      root,
      tracked: new Map(tracked.map((change) => [change.path, change])),
      summary: {
        worktree: { id: worktree.id, repoPath: worktree.repo_path, worktreePath: worktree.worktree_path, branch: branch?.trim() || worktree.branch },
        scope,
        base,
        head: headCommit,
        files,
        totals: {
          files: files.length,
          additions: files.reduce((sum, file) => sum + file.additions, 0),
          deletions: files.reduce((sum, file) => sum + file.deletions, 0)
        },
        truncated: untrackedPaths.length > UNTRACKED_LIMIT
      }
    };
  }

  // The default branch is origin/HEAD's branch, else main, else master. Its
  // local and origin refs are both candidates; the split point nearer HEAD wins.
  private async branchBase(root: string, head: string, originHead: string | null): Promise<{ ref: string; commit: string }> {
    const remoteDefault = originHead?.startsWith('refs/remotes/origin/') ? originHead.slice('refs/remotes/origin/'.length) : null;
    const names = [...new Set([remoteDefault, 'main', 'master'].filter((name): name is string => Boolean(name)))];
    const refsFor = (name: string) => [`refs/heads/${name}`, `refs/remotes/origin/${name}`];
    const existing = new Set((await this.read(root, ['for-each-ref', '--format=%(refname)', ...names.flatMap(refsFor)])).split('\n'));
    const candidates = names.map((name) => refsFor(name).filter((ref) => existing.has(ref))).find((refs) => refs.length > 0) ?? [];
    const bases = (await Promise.all(candidates.map(async (ref) => ({
      ref: ref.replace(/^refs\/(?:heads|remotes)\//, ''),
      commit: (await this.query(root, ['merge-base', head, ref]))?.trim() ?? ''
    })))).filter((base) => base.commit);

    let best = bases[0];
    if (!best) return { ref: 'HEAD', commit: head };
    for (const next of bases.slice(1)) {
      if (next.commit !== best.commit && (await this.query(root, ['merge-base', '--is-ancestor', best.commit, next.commit])) !== null) best = next;
    }
    return best;
  }

  // Before the first commit, everything is compared with the empty tree.
  // Git versions without --show-object-format only support SHA-1.
  private async emptyTree(root: string): Promise<string> {
    const format = (await this.query(root, ['rev-parse', '--show-object-format']).catch(() => null))?.trim() ?? 'sha1';
    return EMPTY_TREES[format] ?? EMPTY_TREES.sha1!;
  }

  private async baseSide(root: string, change: TrackedChange): Promise<FileSide> {
    if (change.oldMode === GITLINK_MODE) return `Subproject commit ${change.oldObject}\n`;
    const size = Number((await this.read(root, ['cat-file', '-s', change.oldObject])).trim());
    if (size > MAX_TEXT_BYTES) return TOO_LARGE;
    return textOrBinary(await this.git.buffer(root, [...GIT_READ, 'cat-file', 'blob', change.oldObject], MAX_TEXT_BYTES + 1));
  }

  // Reads the working tree without following symlinks out of it. A symlink's
  // contents are its target text, as git diffs it.
  private async workingTreeSide(root: string, filePath: string, change: TrackedChange | undefined): Promise<FileSide> {
    const target = await containedPath(root, filePath);
    if (!target) return null;
    const stat = await lstatIfExists(target);
    if (!stat) return null;
    if (change?.newMode === GITLINK_MODE) return stat.isDirectory() ? this.submoduleSide(target, change.newObject) : null;
    if (stat.isSymbolicLink()) return fs.readlink(target);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_TEXT_BYTES) return TOO_LARGE;
    const bytes = await readPrefix(target, MAX_TEXT_BYTES + 1);
    return bytes.length > MAX_TEXT_BYTES ? TOO_LARGE : textOrBinary(bytes);
  }

  private async submoduleSide(directory: string, objectId: string): Promise<string | null> {
    const commit = /^0+$/.test(objectId)
      ? (await this.query(directory, ['rev-parse', '-q', '--verify', 'HEAD']).catch(() => null))?.trim()
      : objectId;
    return commit ? `Subproject commit ${commit}\n` : null;
  }

  private async read(cwd: string, args: string[]): Promise<string> {
    return (await this.git.run(cwd, [...GIT_READ, ...args])).stdout;
  }

  private query(cwd: string, args: string[]): Promise<string | null> {
    return this.git.query(cwd, [...GIT_READ, ...args]);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

const TEST_SEGMENTS = new Set(['test', 'tests', '__tests__', '__test__', 'spec', 'specs', 'e2e', '__mocks__', '__snapshots__', 'testdata']);
const TEST_NAMES = [/\.(test|spec)\.[^.]+$/, /_test\.[^.]+$/, /^test_.+\.py$/, /Tests?\.(java|kt|cs|swift)$/, /\.snap$/];
const DOC_EXTENSIONS = new Set(['md', 'mdx', 'markdown', 'txt', 'rst', 'adoc', 'asciidoc', 'org']);
const DOC_DIRECTORIES = new Set(['docs', 'doc', 'documentation']);
const DOC_NAMES = /^(?:license|licence|copying|notice|authors|changelog|changes)/i;
// Source files such as changelog.ts or Notice.vue are not documentation.
const CODE_EXTENSION = /\.[a-z0-9]{1,4}$/;

// Flags for the "Exclude docs" and "Exclude tests" review filters. Directory
// names match case-insensitively; a file can be both.
export function classifyDiffPath(filePath: string): { docs: boolean; tests: boolean } {
  const segments = filePath.split('/').filter(Boolean);
  const name = segments.at(-1) ?? '';
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const tests = segments.some((segment) => TEST_SEGMENTS.has(segment.toLowerCase())) || TEST_NAMES.some((pattern) => pattern.test(name));
  const docs = DOC_EXTENSIONS.has(extension)
    || segments.slice(0, -1).some((segment) => DOC_DIRECTORIES.has(segment.toLowerCase()))
    || (DOC_NAMES.test(name) && !CODE_EXTENSION.test(name));
  return { docs, tests };
}

// Parses `git diff --raw --numstat -z`: every raw entry, then every numstat
// entry. Renames and copies carry two paths in both sections.
function parseTrackedChanges(output: string): TrackedChange[] {
  const fields = output.split('\0');
  const changes: Array<Omit<TrackedChange, 'additions' | 'deletions' | 'binary'>> = [];
  let index = 0;
  for (let entry = RAW_ENTRY.exec(fields[0] ?? ''); entry; entry = RAW_ENTRY.exec(fields[index] ?? '')) {
    const [, oldMode = '', newMode = '', oldObject = '', newObject = '', letter = 'M'] = entry;
    const paired = letter === 'R' || letter === 'C';
    const first = fields[index + 1] ?? '';
    changes.push({
      path: paired ? fields[index + 2] ?? first : first,
      previousPath: paired ? first : null,
      // Unmerged and unknown entries are still modifications of the path.
      status: STATUSES[letter] ?? 'modified',
      oldMode,
      newMode,
      oldObject,
      newObject
    });
    index += paired ? 3 : 2;
  }

  const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  while (index < fields.length) {
    const entry = NUMSTAT_ENTRY.exec(fields[index] ?? '');
    if (!entry) {
      index += 1;
      continue;
    }
    const [, added = '0', removed = '0', inlinePath = ''] = entry;
    const filePath = inlinePath || (fields[index + 2] ?? '');
    index += inlinePath ? 1 : 3;
    // Git prints "-" for both counts of a binary file.
    stats.set(filePath, { additions: Number(added) || 0, deletions: Number(removed) || 0, binary: added === '-' || removed === '-' });
  }
  return changes.map((change) => ({ ...change, ...(stats.get(change.path) ?? { additions: 0, deletions: 0, binary: false }) }));
}

async function untrackedFile(root: string, filePath: string): Promise<{ additions: number; binary: boolean; version: string } | null> {
  const absolute = path.join(root, filePath);
  const stat = await lstatIfExists(absolute);
  if (!stat) return null;
  const version = fileVersion(stat);
  // A new symlink adds one line: its target.
  if (stat.isSymbolicLink()) return { additions: 1, binary: false, version };
  if (!stat.isFile()) return null;
  const large = stat.size > MAX_TEXT_BYTES;
  const bytes = await readPrefix(absolute, large ? BINARY_SNIFF_BYTES : stat.size).catch(() => null);
  if (!bytes) return { additions: 0, binary: false, version };
  const binary = isBinary(bytes);
  return { additions: binary || large ? 0 : countLines(bytes), binary, version };
}

function fileVersion(stat: { size: number; mtimeMs: number } | null): string {
  return stat ? `${stat.size}:${Math.trunc(stat.mtimeMs)}` : 'missing';
}

function relativeDiffPath(value: string): string {
  if (value.includes('\0') || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error('path must be relative to the worktree root');
  }
  if (value.split(/[\\/]/).includes('..')) throw new Error('path must not contain ".." segments');
  return value;
}

// Resolves the parent directory, so a symlinked directory cannot lead
// outside the worktree. The final component is never followed.
async function containedPath(root: string, filePath: string): Promise<string | null> {
  const realRoot = await fs.realpath(root);
  let parent: string;
  try {
    parent = await fs.realpath(path.dirname(path.join(realRoot, filePath)));
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (parent !== realRoot && !parent.startsWith(realRoot + path.sep)) {
    throw new Error(`${filePath} resolves outside the worktree`);
  }
  return path.join(parent, path.basename(filePath));
}

async function lstatIfExists(target: string) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

// O_NOFOLLOW refuses a symlink swapped in after lstat; O_NONBLOCK keeps a
// swapped-in FIFO from blocking.
async function readPrefix(file: string, length: number): Promise<Buffer> {
  const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

// Git treats content as binary when its first 8000 bytes contain a NUL byte.
function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

function textOrBinary(bytes: Buffer): string | typeof BINARY {
  return isBinary(bytes) ? BINARY : bytes.toString('utf8');
}

function countLines(bytes: Buffer): number {
  if (bytes.length === 0) return 0;
  let lines = 0;
  for (let index = bytes.indexOf(10); index !== -1; index = bytes.indexOf(10, index + 1)) lines += 1;
  return bytes[bytes.length - 1] === 10 ? lines : lines + 1;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function mapLimit<T, R>(items: T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await map(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
