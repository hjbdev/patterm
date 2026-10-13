import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RegisterProcessAction, registerProcessInput } from '../app/Actions/RegisterProcessAction';
import { RegisterSessionAction, registerSessionInput } from '../app/Actions/RegisterSessionAction';
import { DatabaseService } from '../app/Services/DatabaseService';
import { classifyDiffPath, DiffService, type DiffFileContents, type DiffScope, type DiffSummary } from '../app/Services/DiffService';
import { GitService, type GitResult } from '../app/Services/GitService';
import { SearchService } from '../app/Services/SearchService';
import { TimelineService } from '../app/Services/TimelineService';
import { WorktreeService } from '../app/Services/WorktreeService';
import { WorkbenchRepository } from '../app/Repositories/WorkbenchRepository';
import type { TerminalService } from '../app/Services/TerminalService';
import { createTestMcpRegistry } from './fixtures/McpRegistryFixture';
import { trySymlink } from './fixtures/SymlinkFixture';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// Records every git invocation so the smoke can check that diff reads never
// take optional locks.
class RecordingGit extends GitService {
  readonly calls: string[][] = [];

  override run(cwd: string, args: string[]): Promise<GitResult> {
    this.calls.push(args);
    return super.run(cwd, args);
  }

  override buffer(cwd: string, args: string[], maxBuffer?: number): Promise<Buffer> {
    this.calls.push(args);
    return super.buffer(cwd, args, maxBuffer);
  }
}

async function main(): Promise<void> {
  assertClassification();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-worktree-'));
  const database = new DatabaseService(tempDir);
  try {
    const repoDir = path.join(tempDir, 'repo');
    fs.mkdirSync(repoDir);
    git(repoDir, ['init', '-q']);
    git(repoDir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    git(repoDir, ['config', 'user.email', 'test@example.com']);
    git(repoDir, ['config', 'user.name', 'Test User']);
    write(repoDir, 'README.md', 'hello\n');
    write(repoDir, 'src/old.ts', numbered(10));
    write(repoDir, 'src/app.ts', 'export const app = 1;\n');
    write(repoDir, 'src/remove.ts', 'gone\n');
    fs.writeFileSync(path.join(repoDir, 'logo.bin'), Buffer.from([0, 1, 2, 3]));
    git(repoDir, ['add', '-A']);
    git(repoDir, ['commit', '-qm', 'init']);
    const splitPoint = git(repoDir, ['rev-parse', 'HEAD']).trim();

    database.initialize();
    const timeline = new TimelineService(database);
    const workbench = new WorkbenchRepository(database);
    const projectId = 'project_worktree';
    const now = new Date().toISOString();
    database.connection.prepare(`insert into projects (id, name, path, created_at, updated_at) values (?, ?, ?, ?, ?)`).run(projectId, 'Repo', repoDir, now, now);
    const worktrees = new WorktreeService({ database, timeline, workbench });
    const recordingGit = new RecordingGit();
    let clock = 0;
    const diffs = new DiffService({ worktrees, git: recordingGit, now: () => clock });
    // Each read after a change moves past the two-second summary cache.
    const current = (worktreeId: string, scope: DiffScope = 'branch') => {
      clock += 5_000;
      return diffs.current({ worktree_id: worktreeId, scope });
    };
    const file = (worktreeId: string, filePath: string, scope: DiffScope = 'branch') => diffs.file({ worktree_id: worktreeId, path: filePath, scope });

    const created = await worktrees.create({ project_id: projectId, name: 'Implement worktree diff' });
    const tree = created.worktree;
    assert.equal(tree.branch, 'patterm/implement-worktree-diff');
    await assert.rejects(worktrees.create({ project_id: projectId, name: 'Implement worktree diff', worktree_path: path.join(tempDir, 'collision') }), /already exists/, 'existing branches are never overwritten');
    await assert.rejects(worktrees.create({ project_id: projectId, name: 'Option ref', base_ref: '--no-checkout' }), /base_ref cannot start with/, 'a base ref is never read as a git option');
    await assert.rejects(worktrees.create({ project_id: projectId, name: 'Option branch', branch: '-f' }), /branch cannot start with/, 'a branch is never read as a git option');
    assert.ok(tree.worktreePath.includes(`${path.sep}.worktrees${path.sep}`), 'created path is under .worktrees');
    assert.equal(fs.existsSync(tree.worktreePath), true, 'git worktree exists on disk');
    const worktreeDir = tree.worktreePath;

    // Committed on the branch: a rename with an edit, a new test, a deletion,
    // and a binary change.
    git(worktreeDir, ['mv', 'src/old.ts', 'src/new.ts']);
    write(worktreeDir, 'src/new.ts', `${numbered(10)}added line\n`);
    write(worktreeDir, 'tests/app.test.ts', 'test("app", () => {});\n');
    git(worktreeDir, ['rm', '-q', 'src/remove.ts']);
    fs.writeFileSync(path.join(worktreeDir, 'logo.bin'), Buffer.from([0, 9, 9, 9, 9]));
    git(worktreeDir, ['add', '-A']);
    git(worktreeDir, ['commit', '-qm', 'branch work']);
    const branchHead = git(worktreeDir, ['rev-parse', 'HEAD']).trim();
    // Uncommitted: a staged edit, an unstaged edit, and untracked files.
    write(worktreeDir, 'src/app.ts', 'export const app = 2;\nexport const more = true;\n');
    git(worktreeDir, ['add', 'src/app.ts']);
    write(worktreeDir, 'README.md', 'hello\nworld\n');
    write(worktreeDir, 'docs/notes.md', 'one\ntwo\nthree');
    fs.writeFileSync(path.join(worktreeDir, 'blob.dat'), Buffer.from([1, 0, 1]));
    write(tempDir, 'outside.txt', 'secret\n');
    // Windows refuses symlinks without Developer Mode; the link assertions skip then.
    const outsideLink = trySymlink(path.join(tempDir, 'outside.txt'), path.join(worktreeDir, 'outside-link'), 'file');    write(worktreeDir, 'big.txt', `${'x'.repeat(1024 * 1024)}\n`);

    const branch = await current(tree.id);
    assert.deepEqual(branch.worktree, { id: tree.id, repoPath: tree.repoPath, worktreePath: worktreeDir, branch: 'patterm/implement-worktree-diff' });
    assert.equal(branch.scope, 'branch');
    assert.deepEqual(branch.base, { ref: 'main', commit: splitPoint }, 'the branch splits from main at its merge base');
    assert.equal(branch.head, branchHead);
    assert.equal(branch.truncated, false);
    assert.deepEqual(branch.files.map(({ path: filePath, previousPath, status, additions, deletions, binary, untracked, docs, tests }) => [filePath, previousPath, status, additions, deletions, binary, untracked, docs, tests]), [
      ['README.md', null, 'modified', 1, 0, false, false, true, false],
      ['big.txt', null, 'added', 0, 0, false, true, true, false],
      ['blob.dat', null, 'added', 0, 0, true, true, false, false],
      ['docs/notes.md', null, 'added', 3, 0, false, true, true, false],
      ['logo.bin', null, 'modified', 0, 0, true, false, false, false],
      ...(outsideLink ? [['outside-link', null, 'added', 1, 0, false, true, false, false]] : []),
      ['src/app.ts', null, 'modified', 2, 1, false, false, false, false],
      ['src/new.ts', 'src/old.ts', 'renamed', 1, 0, false, false, false, false],
      ['src/remove.ts', null, 'deleted', 0, 1, false, false, false, false],
      ['tests/app.test.ts', null, 'added', 1, 0, false, false, false, true]
    ], 'committed, staged, unstaged, and untracked changes are listed by path');
    assert.deepEqual(branch.totals, outsideLink ? { files: 10, additions: 9, deletions: 2 } : { files: 9, additions: 8, deletions: 2 });
    assert.ok(!('patch' in branch), 'summaries carry no patch text');

    const uncommitted = await current(tree.id, 'uncommitted');
    assert.deepEqual(uncommitted.base, { ref: 'HEAD', commit: branchHead });
    assert.deepEqual(uncommitted.files.map((entry) => entry.path), ['README.md', 'big.txt', 'blob.dat', 'docs/notes.md', ...(outsideLink ? ['outside-link'] : []), 'src/app.ts'],'uncommitted scope leaves out committed branch work');

    // Contents for side-by-side review.
    assert.deepEqual(await file(tree.id, 'src/new.ts'), contents('src/new.ts', 'src/old.ts', 'renamed', numbered(10), `${numbered(10)}added line\n`));
    assert.deepEqual(await file(tree.id, 'README.md'), contents('README.md', null, 'modified', 'hello\n', 'hello\nworld\n'));
    assert.deepEqual(await file(tree.id, 'src/app.ts', 'uncommitted'), contents('src/app.ts', null, 'modified', 'export const app = 1;\n', 'export const app = 2;\nexport const more = true;\n'));
    if (process.platform === 'win32') assert.deepEqual(await file(tree.id, 'src\\app.ts', 'uncommitted'), await file(tree.id, 'src/app.ts', 'uncommitted'), 'a backslash path names the changed file git lists with a slash');
    assert.deepEqual(await file(tree.id, 'src/remove.ts'), contents('src/remove.ts', null, 'deleted', 'gone\n', null));
    assert.deepEqual(await file(tree.id, 'tests/app.test.ts'), contents('tests/app.test.ts', null, 'added', null, 'test("app", () => {});\n'));
    assert.deepEqual(await file(tree.id, 'docs/notes.md'), contents('docs/notes.md', null, 'added', null, 'one\ntwo\nthree'));
    if (outsideLink) assert.deepEqual(await file(tree.id, 'outside-link'), contents('outside-link', null, 'added', null, path.join(tempDir, 'outside.txt')), 'symlinks show their target, never the file outside');
    assert.deepEqual(await file(tree.id, 'logo.bin'), { ...contents('logo.bin', null, 'modified', null, null), binary: true });
    assert.deepEqual(await file(tree.id, 'blob.dat'), { ...contents('blob.dat', null, 'added', null, null), binary: true });
    assert.deepEqual(await file(tree.id, 'big.txt'), { ...contents('big.txt', null, 'added', null, null), tooLarge: true });
    await assert.rejects(file(tree.id, path.join(worktreeDir, 'README.md')), /relative/);
    await assert.rejects(file(tree.id, '../repo/README.md'), /"\.\." segments/);
    await assert.rejects(file(tree.id, 'src/../README.md'), /"\.\." segments/);
    await assert.rejects(file(tree.id, 'src/unchanged.ts'), /not a changed file/);
    await assert.rejects(file(tree.id, 'src/new.ts', 'uncommitted'), /not a changed file/, 'files use the requested scope');

    // Overlapping polls share one computation until the cache expires.
    const [first, second] = await Promise.all([diffs.current({ worktree_id: tree.id }), diffs.current({ worktree_id: tree.id })]);
    assert.equal(first, second, 'concurrent reads coalesce');
    write(worktreeDir, 'late.ts', 'late\n');
    assert.equal(await diffs.current({ worktree_id: tree.id }), first, 'reads within the cache window reuse the summary');
    clock += 2_001;
    assert.ok((await diffs.current({ worktree_id: tree.id })).files.some((entry) => entry.path === 'late.ts'), 'the cache expires after two seconds');
    fs.rmSync(path.join(worktreeDir, 'late.ts'));

    // Content versions move with any edit, even one that keeps the line counts.
    const readme = path.join(worktreeDir, 'README.md');
    const versionOf = async (filePath: string) => (await diffs.current({ worktree_id: tree.id })).files.find((entry) => entry.path === filePath)?.version;
    const readmeVersion = await versionOf('README.md');
    assert.ok(readmeVersion, 'every file has a content version');
    write(worktreeDir, 'README.md', 'hello\nWORLD\n');
    fs.utimesSync(readme, new Date(), new Date(Date.now() + 60_000));
    clock += 2_001;
    assert.notEqual(await versionOf('README.md'), readmeVersion, 'an edit with the same line counts gets a new version');
    write(worktreeDir, 'README.md', 'hello\nworld\n');
    clock += 2_001;
    assert.ok(recordingGit.calls.length > 0 && recordingGit.calls.every((args) => args[0] === '--no-optional-locks' && args[1] === '-c' && args[2] === 'core.quotepath=off'), 'diff reads never take index.lock');

    // Main moving on does not show its new commits as branch deletions.
    write(repoDir, 'src/app.ts', 'export const app = 3;\n');
    git(repoDir, ['commit', '-qam', 'main moves on']);
    const mainHead = git(repoDir, ['rev-parse', 'HEAD']).trim();
    const afterMainMoved = await current(tree.id);
    assert.deepEqual(afterMainMoved.base, { ref: 'main', commit: splitPoint });
    assert.deepEqual(afterMainMoved.totals, branch.totals);

    // The origin branch wins when its split point is nearer HEAD.
    git(repoDir, ['update-ref', 'refs/remotes/origin/main', branchHead]);
    assert.deepEqual((await current(tree.id)).base, { ref: 'origin/main', commit: branchHead });
    git(repoDir, ['update-ref', '-d', 'refs/remotes/origin/main']);
    // origin/HEAD names the default branch.
    git(repoDir, ['branch', 'trunk', branchHead]);
    git(repoDir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk']);
    assert.deepEqual((await current(tree.id)).base, { ref: 'trunk', commit: branchHead });
    git(repoDir, ['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD']);
    git(repoDir, ['branch', '-q', '-D', 'trunk']);

    // The main checkout itself shows only its uncommitted changes.
    write(repoDir, 'README.md', 'hello\nmain\n');
    const mainCheckout = (await worktrees.link({ project_id: projectId, worktree_path: repoDir })).worktree;
    assert.equal(mainCheckout.branch, 'main');
    const mainDiff = await current(mainCheckout.id);
    assert.deepEqual(mainDiff.base, { ref: 'main', commit: mainHead });
    assert.deepEqual(mainDiff.files.map((entry) => [entry.path, entry.status]), [['README.md', 'modified']], 'nested worktrees are not listed as changes');
    // Linking a registered directory again returns its registration.
    const count = () => (database.connection.prepare('select count(*) n from worktrees').get() as { n: number }).n;
    const before = count();
    assert.equal((await worktrees.link({ project_id: projectId, worktree_path: `${repoDir}${path.sep}` })).worktree.id, mainCheckout.id);
    if (trySymlink(repoDir, path.join(tempDir, 'repo-alias'), 'junction')) {
      assert.equal((await worktrees.link({ project_id: projectId, worktree_path: path.join(tempDir, 'repo-alias') })).worktree.id, mainCheckout.id, 'a symlinked path matches the real directory');
    }
    if (process.platform === 'win32') {
      for (const spelling of [repoDir.toLowerCase(), repoDir.replace(/\\/g, '/')]) {
        assert.equal((await worktrees.link({ project_id: projectId, worktree_path: spelling })).worktree.id, mainCheckout.id, `${spelling} matches the registered directory`);
      }
    }
    assert.equal(count(), before, 'relinking does not duplicate the worktree');

    // A repository without commits compares with the empty tree.
    const emptyDir = path.join(tempDir, 'empty');
    fs.mkdirSync(emptyDir);
    git(emptyDir, ['init', '-q']);
    write(emptyDir, 'staged.txt', 'first\n');
    git(emptyDir, ['add', 'staged.txt']);
    write(emptyDir, 'loose.ts', 'loose\n');
    const empty = (await worktrees.link({ project_id: projectId, worktree_path: emptyDir })).worktree;
    const emptyDiff = await current(empty.id);
    assert.equal(emptyDiff.head, null);
    assert.deepEqual(emptyDiff.base, { ref: null, commit: EMPTY_TREE });
    assert.deepEqual(emptyDiff.files.map((entry) => [entry.path, entry.status, entry.untracked, entry.additions]), [['loose.ts', 'added', true, 1], ['staged.txt', 'added', false, 1]]);
    assert.deepEqual(await file(empty.id, 'staged.txt'), contents('staged.txt', null, 'added', null, 'first\n'));

    // Abandoning keeps files, branches, and historical snapshot rows, and
    // removes session links.
    const linkedPath = path.join(tempDir, 'linked-worktree');
    git(repoDir, ['worktree', 'add', '-q', '-b', 'manual/link', linkedPath, 'HEAD']);
    const linked = (await worktrees.link({ project_id: projectId, worktree_path: linkedPath })).worktree;
    assert.equal(linked.branch, 'manual/link');
    assert.equal(worktrees.list({ project_id: projectId }).worktrees.length, 4, 'project lists created and linked worktrees');
    database.connection.prepare(`insert into diff_snapshots (id, project_id, worktree_id, patch, metadata, created_at) values ('diff_history', ?, ?, 'retained patch', '{}', ?)`).run(projectId, linked.id, now);
    database.connection.prepare(`insert into sessions (id, project_id, session_role, worktree_id, cwd, started_at) values ('unlink_session', ?, 'orchestrator', ?, ?, ?)`).run(projectId, linked.id, linkedPath, now);
    database.connection.prepare(`insert into session_worktrees (session_id, worktree_id, created_at) values ('unlink_session', ?, ?)`).run(tree.id, now);
    database.connection.prepare(`insert into sessions (id, project_id, session_role, cwd, started_at) values ('linking_session', ?, 'orchestrator', ?, ?)`).run(projectId, repoDir, now);
    database.connection.prepare(`insert into session_worktrees (session_id, worktree_id, created_at) values ('linking_session', ?, ?)`).run(linked.id, now);
    database.connection.prepare(`insert into processes (id, project_id, kind, name, status, worktree_id, cwd, created_at, updated_at) values ('unlink_process', ?, 'command', 'Shell', 'exited', ?, ?, ?, ?)`).run(projectId, linked.id, linkedPath, now, now);
    await worktrees.abandon({ worktree_id: linked.id });
    assert.equal(database.connection.prepare(`select * from worktrees where id = ?`).get(linked.id), undefined);
    assert.deepEqual(database.connection.prepare(`select id, project_id, worktree_id, patch from diff_snapshots where id = 'diff_history'`).get(), { id: 'diff_history', project_id: projectId, worktree_id: null, patch: 'retained patch' });
    assert.deepEqual(database.connection.prepare("select worktree_id, cwd from sessions where id = 'unlink_session'").get(), { worktree_id: null, cwd: linkedPath });
    assert.deepEqual(database.connection.prepare("select worktree_id, cwd from processes where id = 'unlink_process'").get(), { worktree_id: null, cwd: linkedPath });
    assert.deepEqual(database.connection.prepare('select session_id, worktree_id from session_worktrees order by session_id').all(), [{ session_id: 'unlink_session', worktree_id: tree.id }], 'links to the abandoned worktree are removed');
    assert.equal(fs.existsSync(linkedPath), true, 'abandon does not delete files');
    assert.equal(git(linkedPath, ['branch', '--show-current']).trim(), 'manual/link');
    assert.deepEqual(database.connection.prepare('pragma foreign_key_check').all(), []);

    // MCP: agents default to their own worktree, else their first link.
    const searchService = new SearchService(database);
    const registry = createTestMcpRegistry({
      tempDir,
      database,
      terminal: { isAvailable: () => false } as unknown as TerminalService,
      timeline,
      workbench,
      worktreeService: worktrees,
      diffService: diffs,
      searchService
    });
    const agent = (identity: string, worktreeId: string | null) => {
      const { process_id } = new RegisterProcessAction(database, timeline).execute(registerProcessInput.parse({ project_id: projectId, name: identity, kind: 'agent' }));
      return new RegisterSessionAction(database, timeline).execute(registerSessionInput.parse({ project_id: projectId, process_id, harness: 'claude', mcp_identity: identity, worktree_id: worktreeId })).session_id;
    };
    agent('worktree_agent', tree.id);
    agent('linking_agent', null);
    const agentDiff = (await registry.callPublic('diff_current', {}, { identity: 'worktree_agent' })) as DiffSummary;
    assert.equal(agentDiff.worktree.id, tree.id, 'agents default to their own worktree');
    assert.equal(((await registry.callPublic('diff_file', { path: 'README.md' }, { identity: 'worktree_agent' })) as DiffFileContents).newContents, 'hello\nworld\n');
    await assert.rejects(registry.callPublic('diff_current', {}, { identity: 'linking_agent' }), /no worktree/);
    await registry.callPublic('worktree_attach', { worktree_id: mainCheckout.id }, { identity: 'linking_agent' });
    await registry.callPublic('worktree_attach', { worktree_id: empty.id }, { identity: 'linking_agent' });
    assert.equal(((await registry.callPublic('diff_current', {}, { identity: 'linking_agent' })) as DiffSummary).worktree.id, mainCheckout.id, 'without an own worktree, agents default to their first link');
    const ownerDiff = (await registry.call('diff_current', { worktree_id: tree.id, scope: 'uncommitted' })) as DiffSummary;
    assert.equal(ownerDiff.scope, 'uncommitted');
    await assert.rejects(registry.call('diff_current', { worktree_id: tree.id, scope: 'all' }));
    await assert.rejects(registry.call('diff_file', { worktree_id: tree.id, path: '/etc/passwd' }), /relative/);
    for (const name of ['diff_current', 'diff_file']) {
      assert.deepEqual(registry.changedTopics(name), [], `${name} polling does not refresh the workbench`);
    }
    const publicNames = registry.publicTools().map(({ name }) => name);
    for (const removed of ['diff.snapshot', 'diff.list', 'diff.get']) {
      assert.ok(!publicNames.includes(removed), `${removed} is removed`);
      await assert.rejects(registry.call(`${removed}`, {}), /unknown MCP tool/);
    }

    // eslint-disable-next-line no-console
    console.log('worktree diff smoke ok');
  } finally {
    database.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function assertClassification(): void {
  const cases: Array<[string, boolean, boolean]> = [
    ['README.md', true, false],
    ['guide.MDX', true, false],
    ['docs/setup.sh', true, false],
    ['Documentation/api.yaml', true, false],
    ['notes.txt', true, false],
    ['LICENSE', true, false],
    ['licence-MIT', true, false],
    ['COPYING.LESSER', true, false],
    ['NOTICE', true, false],
    ['AUTHORS', true, false],
    ['CHANGELOG', true, false],
    ['packages/web/CHANGES.rst', true, false],
    ['src/changelog.ts', false, false],
    ['src/LicenseService.ts', false, false],
    ['tests/app.ts', false, true],
    ['src/__tests__/app.ts', false, true],
    ['Tests/AppTests/Model.swift', false, true],
    ['spec/models/user_spec.rb', false, true],
    ['e2e/login.ts', false, true],
    ['src/__mocks__/fs.ts', false, true],
    ['src/__snapshots__/view.ts', false, true],
    ['pkg/testdata/input.json', false, true],
    ['src/app.test.ts', false, true],
    ['src/app.spec.js', false, true],
    ['pkg/server_test.go', false, true],
    ['test_models.py', false, true],
    ['src/main/java/AppTest.java', false, true],
    ['Sources/AppTests.swift', false, true],
    ['src/view.ts.snap', false, true],
    ['tests/README.md', true, true],
    ['docs/spec/format.md', true, true],
    ['src/latest.ts', false, false],
    ['src/contest.java', false, false],
    ['src/app.ts', false, false]
  ];
  for (const [filePath, docs, tests] of cases) {
    assert.deepEqual(classifyDiffPath(filePath), { docs, tests }, filePath);
  }
}

function contents(filePath: string, previousPath: string | null, status: DiffFileContents['status'], oldContents: string | null, newContents: string | null): DiffFileContents {
  return { path: filePath, previousPath, status, binary: false, tooLarge: false, oldContents, newContents };
}

function numbered(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}\n`).join('');
}

function write(root: string, filePath: string, body: string): void {
  fs.mkdirSync(path.dirname(path.join(root, filePath)), { recursive: true });
  fs.writeFileSync(path.join(root, filePath), body);
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
