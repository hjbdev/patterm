import assert from 'node:assert/strict';

import {
  acceptsDiffShortcut,
  buildDiffTree,
  diffFileStepKey,
  diffTotals,
  filterDiffFiles,
  orderedDiffFiles,
  visibleDiffTreeRows,
  worktreeName,
  type WorktreeDiffFile
} from '../resources/js/lib/worktreeDiff';

function file(path: string, overrides: Partial<WorktreeDiffFile> = {}): WorktreeDiffFile {
  return { path, previousPath: null, status: 'modified', additions: 1, deletions: 1, binary: false, untracked: false, docs: false, tests: false, version: `${path}:1`, ...overrides };
}

const files = [
  file('README.md', { docs: true, additions: 4, deletions: 0 }),
  file('app/Services/DiffService.ts', { additions: 120, deletions: 40 }),
  file('app/Services/GitService.ts', { additions: 3, deletions: 1 }),
  file('tests/worktreeDiffSmoke.ts', { tests: true, additions: 80, deletions: 10 }),
  file('tests/fixtures/notes.md', { docs: true, tests: true, status: 'added', untracked: true, additions: 2, deletions: 0 }),
  file('resources/js/lib/worktreeDiff.ts', { status: 'added', additions: 150, deletions: 0 })
];

assert.deepEqual(diffTotals(files), { files: 6, additions: 359, deletions: 51 });
assert.deepEqual(filterDiffFiles(files, { excludeDocs: true, excludeTests: false }).map((item) => item.path),
  ['app/Services/DiffService.ts', 'app/Services/GitService.ts', 'tests/worktreeDiffSmoke.ts', 'resources/js/lib/worktreeDiff.ts'], 'excluding docs drops any file flagged as docs');
assert.deepEqual(filterDiffFiles(files, { excludeDocs: false, excludeTests: true }).map((item) => item.path),
  ['README.md', 'app/Services/DiffService.ts', 'app/Services/GitService.ts', 'resources/js/lib/worktreeDiff.ts'], 'excluding tests drops a file flagged as both');
assert.equal(filterDiffFiles(files, { excludeDocs: true, excludeTests: true }).length, 3);

const tree = buildDiffTree(files);
assert.deepEqual(tree.map((node) => [node.kind, node.name]), [
  ['directory', 'app/Services'],
  ['directory', 'resources/js/lib'],
  ['directory', 'tests'],
  ['file', 'README.md']
], 'directories come first and single-child chains fold into one row');
const services = tree[0]!;
assert.equal(services.kind === 'directory' && services.path, 'app/Services', 'a folded directory keeps its full path for collapsing');
assert.equal(services.kind === 'directory' && services.additions, 123, 'directories total their files');
assert.deepEqual(orderedDiffFiles(tree).map((item) => item.path), [
  'app/Services/DiffService.ts',
  'app/Services/GitService.ts',
  'resources/js/lib/worktreeDiff.ts',
  'tests/fixtures/notes.md',
  'tests/worktreeDiffSmoke.ts',
  'README.md'
], 'next and previous follow the tree order');

const rows = visibleDiffTreeRows(tree, new Set(['tests']));
assert.deepEqual(rows.map((row) => [row.node.path, row.depth]), [
  ['app/Services', 0], ['app/Services/DiffService.ts', 1], ['app/Services/GitService.ts', 1],
  ['resources/js/lib', 0], ['resources/js/lib/worktreeDiff.ts', 1],
  ['tests', 0],
  ['README.md', 0]
], 'collapsed directories hide their rows');

assert.equal(worktreeName({ branch: 'patterm/worktree-diffs', path: '/repo/.worktrees/worktree-diffs' }), 'patterm/worktree-diffs');
assert.equal(worktreeName({ branch: null, path: '/repo/.worktrees/detached/' }), 'detached');

const key = (init: KeyboardEventInit & { target?: unknown }) => ({ defaultPrevented: false, altKey: false, ctrlKey: false, metaKey: false, target: null, ...init }) as unknown as KeyboardEvent;
assert.equal(diffFileStepKey(key({ key: ']' })), 1);
assert.equal(diffFileStepKey(key({ key: '[' })), -1);
assert.equal(diffFileStepKey(key({ key: 'j' })), null, 'only brackets step through files');
assert.equal(diffFileStepKey(key({ key: ']', ctrlKey: true })), null, 'modified keys keep their meaning');
assert.equal(acceptsDiffShortcut(key({ key: 'v' })), true);

console.log('worktree diff view smoke ok');
