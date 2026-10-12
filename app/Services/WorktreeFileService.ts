import fs from 'node:fs/promises';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { matchPath } from './FuzzyPathMatch';
import { endsWithSeparator, slashPath } from '../Platform/PathIdentity';
import type { DatabaseService } from './DatabaseService';
import type { UploadService } from '../Http/UploadService';
import type {
  IntegratedInputResolver,
  IntegratedPromptAttachment,
  IntegratedPromptInput,
  IntegratedPromptReference,
  IntegratedWorktreeFile,
  ResolvedIntegratedAttachment,
  ResolvedIntegratedPrompt
} from './IntegratedInput';

// The @ picker lists files and directories from the agent's working
// directory. Directory paths end in `/`, as native @ references write them.
// The walk is breadth-first and bounded. It honours `.gitignore` and `.ignore`
// whether or not the directory is a repository, plus the repository's
// `info/exclude`, including from a linked worktree. It skips heavy build
// directories and never follows symlinks. Listings are cached and refreshed in
// the background so typing never waits for a rescan.
const IGNORED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', '.cache', '.next', '.turbo', '.venv', '.pnpm-store', '__pycache__',
  'build', 'dist', 'node_modules', 'out', 'target', 'venv'
]);
// Tier 0 is the repository's `info/exclude`.
const IGNORE_FILES = [{ name: '.gitignore', tier: 1 }, { name: '.ignore', tier: 2 }];
const MAX_TIER = 2;
// Git and ripgrep match ignore rules case-sensitively on Linux; the package
// defaults to case-insensitive. On Windows the filesystem ignores case and
// `git init` sets core.ignorecase, so rules match without it there.
const IGNORE_OPTIONS = { ignorecase: process.platform === 'win32' };
const DIRECTORY_BATCH = 32;
const STAT_BATCH = 128;
const MAX_FILES = 50_000;
const MAX_DEPTH = 24;
const CACHE_TTL_MS = 5000;
const MAX_CACHED_ROOTS = 8;
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;

interface ListedFile {
  path: string;
  name: string;
  modifiedAt: number;
  directory: boolean;
}

interface IgnoreScope {
  base: string;
  rules: Ignore;
  tier: number;
}

export class WorktreeFileService implements IntegratedInputResolver {
  private readonly listings = new Map<string, { at: number; files: ListedFile[] }>();
  private readonly walks = new Map<string, Promise<ListedFile[]>>();

  constructor(
    private readonly database: DatabaseService,
    private readonly uploads: UploadService
  ) {}

  async resolve(processId: string, input: IntegratedPromptInput): Promise<ResolvedIntegratedPrompt> {
    const references = new Map<string, ResolvedIntegratedPrompt['references'][number]>();
    for (const reference of (input.references ?? []).slice(0, 20)) {
      const resolved = await this.resolveReference(processId, reference);
      references.set(resolved.path, resolved);
    }
    const attachments = new Map<string, ResolvedIntegratedAttachment>();
    for (const attachment of (input.attachments ?? []).slice(0, 20)) {
      const resolved = await this.resolveAttachment(attachment);
      attachments.set(resolved.path, resolved);
    }
    return {
      text: input.text,
      references: [...references.values()],
      attachments: [...attachments.values()],
      ...(normaliseMessageId(input.messageId) ? { messageId: normaliseMessageId(input.messageId)! } : {})
    };
  }

  // An empty query lists the most recently modified files, which are usually
  // the ones being worked on. Directories appear only for a typed query.
  async search(processId: string, query: string, limit = 20): Promise<IntegratedWorktreeFile[]> {
    const root = await this.scope(processId);
    const files = await this.list(root);
    const needle = slashPath(query.trim().slice(0, 200));
    const bounded = Math.max(1, Math.min(50, limit));
    if (!needle) {
      return files.filter((file) => !file.directory)
        .sort((left, right) => right.modifiedAt - left.modifiedAt || left.path.localeCompare(right.path))
        .slice(0, bounded)
        .map((file) => ({ path: file.path, name: file.name }));
    }
    // When the query starts with a listed directory, as after completing into
    // it, only that directory's contents are candidates. Nothing typed after
    // the slash lists its direct children, directories first.
    const lower = needle.toLowerCase();
    const directory = lower.slice(0, lower.lastIndexOf('/') + 1);
    const scoped = Boolean(directory) && files.some((file) => file.directory && file.path.toLowerCase() === directory);
    const rest = scoped ? needle.slice(directory.length) : needle;
    const candidates = scoped
      ? files.filter((file) => file.path.length > directory.length && file.path.toLowerCase().startsWith(directory))
      : files;
    if (scoped && !rest) {
      return candidates
        .filter((file) => !file.path.slice(directory.length, -1).includes('/'))
        .sort((left, right) => Number(right.directory) - Number(left.directory) || left.path.localeCompare(right.path))
        .slice(0, bounded)
        .map((file) => ({ path: file.path, name: file.name }));
    }
    const offset = scoped ? directory.length : 0;
    const ranked: Array<{ file: ListedFile; score: number; positions: number[] }> = [];
    for (const file of candidates) {
      const match = matchPath(file.path.slice(offset), rest);
      if (match) ranked.push({ file, score: match.score, positions: match.positions.map((position) => position + offset) });
    }
    return ranked
      .sort((left, right) => right.score - left.score
        || left.file.name.length - right.file.name.length
        || left.file.path.length - right.file.path.length
        || right.file.modifiedAt - left.file.modifiedAt
        || left.file.path.localeCompare(right.file.path))
      .slice(0, bounded)
      .map(({ file, positions }) => ({ path: file.path, name: file.name, matches: positions }));
  }

  // Only files and directories inside the agent's own working directory
  // resolve, after symlink resolution, so a picked path cannot escape through
  // `..` or a link. A directory reference must end in `/` so the token in the
  // prompt text and the resolved reference always agree.
  private async resolveReference(processId: string, reference: IntegratedPromptReference): Promise<ResolvedIntegratedPrompt['references'][number]> {
    if (!reference || typeof reference.path !== 'string' || !reference.path || reference.path.includes('\0')) {
      throw new Error('Invalid file reference');
    }
    const root = await this.scope(processId);
    const relative = path.isAbsolute(reference.path) ? path.relative(root, reference.path) : reference.path;
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('File reference is outside the agent working directory');
    }
    const real = await fs.realpath(path.resolve(root, relative)).catch(() => null);
    if (!real) throw new Error(`File reference not found: ${relative}`);
    const native = path.relative(root, real);
    if (native.startsWith('..') || path.isAbsolute(native)) {
      throw new Error('File reference is outside the agent working directory');
    }
    // `./`, `src/../`, or a link back to the root name the working directory
    // itself, whose relative path would be empty or render as `/`.
    if (!native) throw new Error('File reference names the agent working directory itself');
    // Agents and the UI see `/` separators; filesystem access keeps `real`.
    const inside = slashPath(native);
    const stat = await fs.stat(real);
    const directory = endsWithSeparator(reference.path);
    if (directory) {
      if (!stat.isDirectory()) throw new Error(`File reference is not a directory: ${relative}`);
      return { path: real, name: `${path.basename(real)}/`, relativePath: `${inside}/`, directory: true };
    }
    if (stat.isDirectory()) throw new Error(`Directory references must end with /: ${relative}`);
    if (!stat.isFile()) throw new Error(`File reference is not a file: ${relative}`);
    if (stat.size > MAX_REFERENCE_BYTES) throw new Error(`File reference is too large: ${relative}`);
    return { path: real, name: path.basename(real), relativePath: inside };
  }

  private async resolveAttachment(attachment: IntegratedPromptAttachment): Promise<ResolvedIntegratedAttachment> {
    if (!attachment || typeof attachment.path !== 'string' || !attachment.path || attachment.path.includes('\0')) {
      throw new Error('Invalid attachment');
    }
    return this.uploads.describe(attachment.path, attachment.name);
  }

  private async scope(processId: string): Promise<string> {
    const row = this.database.connection.prepare(`
      select processes.cwd from processes join sessions on sessions.process_id = processes.id
      where (sessions.process_id = ? or sessions.id = ?) and sessions.interface_mode = 'integrated' and processes.cwd is not null
      order by sessions.exited_at is null desc, sessions.started_at desc limit 1
    `).get(processId, processId) as { cwd: string } | undefined;
    if (!row) throw new Error('Integrated agent session not found');
    const root = await fs.realpath(row.cwd).catch(() => null);
    if (!root) throw new Error('Agent working directory is unavailable');
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) throw new Error('Agent working directory is not a directory');
    return root;
  }

  // Serves the previous listing while a stale one refreshes, so only the first
  // search in a worktree waits for the walk.
  private list(root: string): Promise<ListedFile[]> {
    const cached = this.listings.get(root);
    if ((!cached || Date.now() - cached.at >= CACHE_TTL_MS) && !this.walks.has(root)) {
      const walk = listWorktree(root)
        .then((files) => {
          this.listings.delete(root);
          this.listings.set(root, { at: Date.now(), files });
          while (this.listings.size > MAX_CACHED_ROOTS) this.listings.delete(this.listings.keys().next().value!);
          return files;
        })
        .finally(() => this.walks.delete(root));
      this.walks.set(root, walk);
      if (cached) walk.catch(() => undefined);
    }
    return cached ? Promise.resolve(cached.files) : this.walks.get(root)!;
  }
}

async function listWorktree(root: string): Promise<ListedFile[]> {
  const files: ListedFile[] = [];
  const exclude = await gitExcludeFile(root);
  const rootScopes = await readIgnoreScopes(root, '', exclude);
  let level: Array<{ relative: string; scopes: IgnoreScope[] }> = [{ relative: '', scopes: rootScopes }];
  for (let depth = 0; level.length && depth <= MAX_DEPTH && files.length < MAX_FILES; depth++) {
    // Levels are read a bounded batch of directories at a time, and the cap,
    // which counts directories too, keeps shallower entries when a worktree is
    // too large to list. Nothing is stat'ed beyond the remaining budget.
    const next: typeof level = [];
    for (let index = 0; index < level.length && files.length < MAX_FILES; index += DIRECTORY_BATCH) {
      const batch = level.slice(index, index + DIRECTORY_BATCH);
      const listed = await Promise.all(batch.map((directory) => readDirectory(root, directory.relative, directory.scopes)));
      for (const result of listed) {
        for (const directory of result.directories) {
          if (files.length >= MAX_FILES) break;
          files.push({ path: `${directory.relative}/`, name: `${path.posix.basename(directory.relative)}/`, modifiedAt: 0, directory: true });
          next.push(directory);
        }
        const budget = MAX_FILES - files.length;
        if (budget <= 0) break;
        files.push(...await statFiles(root, result.files.slice(0, budget)));
      }
    }
    level = next;
  }
  return files;
}

async function readDirectory(root: string, relative: string, inherited: IgnoreScope[]): Promise<{ files: string[]; directories: Array<{ relative: string; scopes: IgnoreScope[] }> }> {
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true }).catch(() => []);
  const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const own = relative && IGNORE_FILES.some((file) => names.has(file.name)) ? await readIgnoreScopes(root, relative) : [];
  const scopes = own.length ? [...inherited, ...own] : inherited;
  const directories: Array<{ relative: string; scopes: IgnoreScope[] }> = [];
  const files: string[] = [];
  for (const entry of entries) {
    // A linked worktree's `.git` is a pointer file rather than a directory.
    if (entry.isSymbolicLink() || entry.name === '.git') continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name) && !isIgnored(scopes, child, true)) directories.push({ relative: child, scopes: admitDirectory(scopes, child) });
    } else if (entry.isFile() && !isIgnored(scopes, child, false)) {
      files.push(child);
    }
  }
  files.sort((left, right) => left.localeCompare(right));
  directories.sort((left, right) => left.relative.localeCompare(right.relative));
  return { files, directories };
}

async function statFiles(root: string, relatives: string[]): Promise<ListedFile[]> {
  const listed: ListedFile[] = [];
  for (let index = 0; index < relatives.length; index += STAT_BATCH) {
    const batch = await Promise.all(relatives.slice(index, index + STAT_BATCH).map((relative) => fs.lstat(path.join(root, relative))
      .then((stat): ListedFile | null => stat.isFile() ? { path: relative, name: path.posix.basename(relative), modifiedAt: stat.mtimeMs, directory: false } : null)
      .catch(() => null)));
    for (const file of batch) if (file) listed.push(file);
  }
  return listed;
}

// A linked worktree's `.git` is a file pointing at its git directory, whose
// `commondir` names the shared repository that holds `info/exclude`.
async function gitExcludeFile(root: string): Promise<string | null> {
  const dotGit = path.join(root, '.git');
  const stat = await fs.stat(dotGit).catch(() => null);
  if (!stat) return null;
  let gitDirectory = dotGit;
  if (stat.isFile()) {
    const pointer = (await fs.readFile(dotGit, 'utf8').catch(() => '')).match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
    if (!pointer) return null;
    gitDirectory = path.resolve(root, pointer);
  }
  const common = (await fs.readFile(path.join(gitDirectory, 'commondir'), 'utf8').catch(() => '')).trim();
  return path.join(common ? path.resolve(gitDirectory, common) : gitDirectory, 'info', 'exclude');
}

async function readIgnoreScopes(root: string, relative: string, exclude: string | null = null): Promise<IgnoreScope[]> {
  const directory = path.join(root, relative);
  const sources = [
    ...(exclude ? [{ file: exclude, tier: 0 }] : []),
    ...IGNORE_FILES.map((file) => ({ file: path.join(directory, file.name), tier: file.tier }))
  ];
  const scopes: IgnoreScope[] = [];
  for (const source of sources) {
    const content = await fs.readFile(source.file, 'utf8').catch(() => '');
    if (content) scopes.push({ base: relative, rules: ignore(IGNORE_OPTIONS).add(content), tier: source.tier });
  }
  return scopes;
}

// Precedence follows ripgrep: any `.ignore` match beats any `.gitignore`
// match, which beats `info/exclude`. Within one kind, the deepest file with a
// matching rule decides, so a negated pattern can re-include what a shallower
// file of the same kind excluded.
function isIgnored(scopes: IgnoreScope[], relative: string, directory: boolean): boolean {
  let ignored = false;
  for (let tier = 0; tier <= MAX_TIER; tier++) {
    for (const scope of scopes) {
      if (scope.tier !== tier) continue;
      const result = scope.rules.test(`${localPath(scope, relative)}${directory ? '/' : ''}`);
      if (result.ignored) ignored = true;
      else if (result.unignored) ignored = false;
    }
  }
  return ignored;
}

// A rule such as `foo/` also excludes everything beneath `foo`. When a higher
// tier re-includes `foo/`, each scope that still excludes it gets a copy with
// an exact negation for that directory, so its other rules, such as `*.log`,
// still judge the children. Copies keep sibling directories unaffected.
function admitDirectory(scopes: IgnoreScope[], relative: string): IgnoreScope[] {
  let changed = false;
  const admitted = scopes.map((scope) => {
    const local = localPath(scope, relative);
    if (!scope.rules.test(`${local}/`).ignored) return scope;
    changed = true;
    return { ...scope, rules: ignore(IGNORE_OPTIONS).add(scope.rules).add(`!/${escapeIgnorePattern(local)}/`) };
  });
  return changed ? admitted : scopes;
}

function localPath(scope: IgnoreScope, relative: string): string {
  return scope.base ? relative.slice(scope.base.length + 1) : relative;
}

// Escapes glob syntax and trailing spaces so a directory name matches literally.
function escapeIgnorePattern(value: string): string {
  return value.replace(/[\\*?[\]]/g, '\\$&').replace(/ $/, '\\ ');
}

function normaliseMessageId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : undefined;
}
