import { baseName } from './serverPath';

// Shapes returned by diff_current and diff_file, plus the pure
// view helpers the worktree diff viewer shares. The service classifies files as
// docs or tests; the viewer only filters and arranges them.

export type DiffScope = 'branch' | 'uncommitted';
export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type_changed';
export type DiffStyle = 'split' | 'unified';

export interface WorktreeDiffFile {
  path: string;
  previousPath: string | null;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  untracked: boolean;
  docs: boolean;
  tests: boolean;
  // Changes whenever either side's content may have changed.
  version: string;
}

export interface DiffTotals { files: number; additions: number; deletions: number }

export interface WorktreeDiffSummary {
  worktree: { id: string; repoPath: string; worktreePath: string; branch: string | null };
  scope: DiffScope;
  base: { ref: string | null; commit: string };
  head: string | null;
  files: WorktreeDiffFile[];
  totals: DiffTotals;
  truncated: boolean;
}

export interface WorktreeDiffFileContents {
  path: string;
  previousPath: string | null;
  status: DiffFileStatus;
  binary: boolean;
  tooLarge: boolean;
  oldContents: string | null;
  newContents: string | null;
}

export interface DiffFilters { excludeDocs: boolean; excludeTests: boolean }

export interface DiffTreeDirectory {
  kind: 'directory';
  name: string;
  path: string;
  children: DiffTreeNode[];
  additions: number;
  deletions: number;
  files: number;
}
export interface DiffTreeFile { kind: 'file'; name: string; path: string; file: WorktreeDiffFile }
export type DiffTreeNode = DiffTreeDirectory | DiffTreeFile;
export interface DiffTreeRow { node: DiffTreeNode; depth: number }

export function filterDiffFiles(files: readonly WorktreeDiffFile[], filters: DiffFilters): WorktreeDiffFile[] {
  return files.filter((file) => !(filters.excludeDocs && file.docs) && !(filters.excludeTests && file.tests));
}

export function diffTotals(files: readonly WorktreeDiffFile[]): DiffTotals {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { files: files.length, additions, deletions };
}

// Directories sort before files, as in an editor tree. A directory whose only
// child is another directory folds into one row, such as `app/Services`.
export function buildDiffTree(files: readonly WorktreeDiffFile[]): DiffTreeNode[] {
  const root: DiffTreeDirectory = { kind: 'directory', name: '', path: '', children: [], additions: 0, deletions: 0, files: 0 };
  for (const file of files) {
    const segments = file.path.split('/');
    let directory = root;
    for (const [index, segment] of segments.slice(0, -1).entries()) {
      const path = segments.slice(0, index + 1).join('/');
      let child = directory.children.find((node): node is DiffTreeDirectory => node.kind === 'directory' && node.path === path);
      if (!child) {
        child = { kind: 'directory', name: segment, path, children: [], additions: 0, deletions: 0, files: 0 };
        directory.children.push(child);
      }
      directory = child;
    }
    directory.children.push({ kind: 'file', name: segments.at(-1) ?? file.path, path: file.path, file });
  }
  return finish(root).children;
}

function finish(directory: DiffTreeDirectory): DiffTreeDirectory {
  directory.children = directory.children.map((node) => (node.kind === 'directory' ? fold(finish(node)) : node));
  directory.children.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1));
  directory.additions = 0;
  directory.deletions = 0;
  directory.files = 0;
  for (const node of directory.children) {
    if (node.kind === 'directory') {
      directory.additions += node.additions;
      directory.deletions += node.deletions;
      directory.files += node.files;
    } else {
      directory.additions += node.file.additions;
      directory.deletions += node.file.deletions;
      directory.files += 1;
    }
  }
  return directory;
}

function fold(directory: DiffTreeDirectory): DiffTreeDirectory {
  const only = directory.children.length === 1 ? directory.children[0] : undefined;
  return only?.kind === 'directory' ? { ...only, name: `${directory.name}/${only.name}` } : directory;
}

// Files in the order the tree shows them, so next and previous follow it.
export function orderedDiffFiles(nodes: readonly DiffTreeNode[]): WorktreeDiffFile[] {
  return nodes.flatMap((node) => (node.kind === 'file' ? [node.file] : orderedDiffFiles(node.children)));
}

export function visibleDiffTreeRows(nodes: readonly DiffTreeNode[], collapsed: ReadonlySet<string>, depth = 0): DiffTreeRow[] {
  return nodes.flatMap((node) => [
    { node, depth },
    ...(node.kind === 'directory' && !collapsed.has(node.path) ? visibleDiffTreeRows(node.children, collapsed, depth + 1) : [])
  ]);
}

const STATUS = {
  added: { letter: 'A', label: 'Added' },
  modified: { letter: 'M', label: 'Modified' },
  deleted: { letter: 'D', label: 'Deleted' },
  renamed: { letter: 'R', label: 'Renamed' },
  copied: { letter: 'C', label: 'Copied' },
  type_changed: { letter: 'T', label: 'Type changed' }
} satisfies Record<DiffFileStatus, { letter: string; label: string }>;

export function diffStatus(status: DiffFileStatus): { letter: string; label: string } {
  return STATUS[status] ?? STATUS.modified;
}

export function formatDiffCount(value: number): string {
  return value.toLocaleString('en-GB');
}

export function worktreeName(worktree: { branch: string | null; path: string }): string {
  return worktree.branch ?? baseName(worktree.path) ?? worktree.path;
}

export function fileName(path: string): string {
  return path.split('/').at(-1) ?? path;
}

export function directoryName(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

// Single-key review shortcuts leave typing and open menus alone.
export function acceptsDiffShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return false;
  const target = typeof Element !== 'undefined' && event.target instanceof Element ? event.target : null;
  return !target?.closest('input, textarea, select, [contenteditable="true"], [role="menu"], [role="listbox"]');
}

// ] and [ step to the next and previous file.
export function diffFileStepKey(event: KeyboardEvent): -1 | 1 | null {
  if (!acceptsDiffShortcut(event)) return null;
  if (event.key === ']') return 1;
  if (event.key === '[') return -1;
  return null;
}
