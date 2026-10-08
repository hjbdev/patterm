import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectContextAction, type ContextOperation } from '../app/Actions/ProjectContextAction';
import { RegisterProcessAction, registerProcessInput } from '../app/Actions/RegisterProcessAction';
import { RegisterSessionAction, registerSessionInput } from '../app/Actions/RegisterSessionAction';
import { WorkbenchRepository } from '../app/Repositories/WorkbenchRepository';
import { DatabaseService } from '../app/Services/DatabaseService';
import { ProjectContextService, type SessionWorktreeItem } from '../app/Services/ProjectContextService';
import type { TerminalService } from '../app/Services/TerminalService';
import { TimelineService } from '../app/Services/TimelineService';
import { createTestMcpRegistry } from './fixtures/McpRegistryFixture';

type SessionWorktrees = { items: SessionWorktreeItem[]; total: number };
type AgentWorktreeResult = { worktree: { id: string; worktreePath: string }; attached?: boolean; warning?: string };

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-session-worktrees-'));
  const database = new DatabaseService(dir);
  try {
    database.initialize();
    const db = database.connection;
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    for (const args of [['init', '-q'], ['config', 'user.email', 'test@example.com'], ['config', 'user.name', 'Test User'], ['commit', '-q', '--allow-empty', '-m', 'init']]) git(repo, args);
    const now = new Date().toISOString();
    for (const id of ['p', 'other']) db.prepare('insert into projects(id,name,path,created_at,updated_at) values(?,?,?,?,?)').run(id, id, repo, now, now);
    const timeline = new TimelineService(database);
    const action = new ProjectContextAction(database, new ProjectContextService(database, timeline));
    const call = <T = unknown>(operation: ContextOperation, input: Record<string, unknown> = {}, identity?: string) => action.execute(operation, { project_id: 'p', ...input }, identity) as T;
    const worktree = (id: string, project = 'p') => {
      db.prepare(`insert into worktrees(id,project_id,repo_path,worktree_path,branch,created_by,created_at) values(?,?,?,?,?,'user',?)`)
        .run(id, project, repo, path.join(repo, '.worktrees', id), `patterm/${id}`, now);
      return id;
    };
    const agent = (identity: string, project = 'p', worktreeId: string | null = null) => {
      const { process_id } = new RegisterProcessAction(database, timeline).execute(registerProcessInput.parse({ project_id: project, name: identity, kind: 'agent' }));
      return new RegisterSessionAction(database, timeline).execute(registerSessionInput.parse({ project_id: project, process_id, harness: 'claude', mcp_identity: identity, worktree_id: worktreeId })).session_id;
    };
    const links = (session: string) => (db.prepare('select worktree_id from session_worktrees where session_id=? order by created_at,rowid').all(session) as { worktree_id: string }[]).map((row) => row.worktree_id);
    const events = () => (db.prepare(`select metadata from timeline_events where event_type='worktree.attachment_changed' order by created_at,rowid`).all() as { metadata: string }[]).map((row) => JSON.parse(row.metadata) as Record<string, unknown>);
    const worktrees = (identity: string) => call<{ worktrees: SessionWorktrees }>('patterm.session.context', {}, identity).worktrees;

    const own = worktree('own');
    const alice = agent('alice', 'p', own);
    const bob = agent('bob');
    const outsider = agent('outsider', 'other');
    const foreign = worktree('foreign', 'other');
    const trees = Array.from({ length: 11 }, (_, index) => worktree(`tree_${String(index).padStart(2, '0')}`));

    // The own worktree is listed first without a link row.
    assert.deepEqual(worktrees('alice'), { items: [{ id: own, branch: 'patterm/own', worktree_path: path.join(repo, '.worktrees', own), repo_path: repo, linked_at: null, own: true }], total: 1 });

    // Attaching is idempotent, and agents infer their own session.
    assert.deepEqual(call('patterm.worktree.attach', { worktree_id: trees[1] }, 'alice'), { attached: true });
    assert.deepEqual(call('patterm.worktree.attach', { worktree_id: trees[1] }, 'alice'), { attached: true });
    assert.deepEqual(call('patterm.worktree.attach', { worktree_id: trees[0] }, 'alice'), { attached: true });
    assert.deepEqual(links(alice), [trees[1], trees[0]]);
    assert.deepEqual(events(), [{ worktree_id: trees[1], session_id: alice, removed: false }, { worktree_id: trees[0], session_id: alice, removed: false }], 'repeated attachment records one event');
    assert.deepEqual(worktrees('alice').items.map((item) => [item.id, item.own, item.linked_at === null]), [[own, true, true], [trees[1], false, false], [trees[0], false, false]], 'own first, then links in link order');

    // The own worktree is never a link and cannot be detached.
    assert.deepEqual(call('patterm.worktree.attach', { worktree_id: own }, 'alice'), { attached: true });
    assert.deepEqual(links(alice), [trees[1], trees[0]]);
    assert.throws(() => call('patterm.worktree.detach', { worktree_id: own }, 'alice'), /own working directory/);
    // A stray link row for the own worktree is listed once.
    db.prepare('insert into session_worktrees(session_id,worktree_id,created_at) values(?,?,?)').run(alice, own, now);
    assert.deepEqual(worktrees('alice').items.map((item) => item.id), [own, trees[1], trees[0]]);
    db.prepare('delete from session_worktrees where session_id=? and worktree_id=?').run(alice, own);

    // Detaching is idempotent.
    assert.deepEqual(call('patterm.worktree.detach', { worktree_id: trees[1] }, 'alice'), { attached: false });
    assert.deepEqual(call('patterm.worktree.detach', { worktree_id: trees[1] }, 'alice'), { attached: false });
    assert.deepEqual(links(alice), [trees[0]]);
    assert.equal(events().length, 3);

    // Owner requests name the session; records stay in the caller's project.
    assert.throws(() => call('patterm.worktree.attach', { worktree_id: trees[2] }), /session_id is required for owner requests/);
    assert.throws(() => call('patterm.worktree.attach', { worktree_id: foreign }, 'alice'), /worktrees record not found/);
    assert.throws(() => call('patterm.worktree.attach', { worktree_id: trees[2], session_id: outsider }), /sessions record not found/);
    assert.throws(() => call('patterm.worktree.attach', { worktree_id: trees[2], project_id: 'other' }, 'alice'), /outside the caller scope/);
    assert.throws(() => call('patterm.worktree.attach', { worktree_id: trees[2], actor_id: bob }, 'alice'), /Unrecognized/);

    // A session links at most ten worktrees.
    for (const tree of trees.slice(0, 10)) call('patterm.worktree.attach', { worktree_id: tree, session_id: bob });
    const eventCount = events().length;
    assert.throws(() => call('patterm.worktree.attach', { worktree_id: trees[10], session_id: bob }), /A session can link at most 10 worktrees; detach one first\./);
    assert.equal(links(bob).length, 10);
    assert.equal(events().length, eventCount, 'a rejected link records nothing');
    assert.deepEqual(call('patterm.worktree.attach', { worktree_id: trees[3], session_id: bob }), { attached: true }, 'a full session can repeat an existing link');
    assert.equal(worktrees('bob').total, 10, 'session context lists every link without paging');
    assert.deepEqual(worktrees('bob').items.map((item) => item.id), trees.slice(0, 10));
    call('patterm.worktree.detach', { worktree_id: trees[9], session_id: bob });
    call('patterm.worktree.attach', { worktree_id: trees[10], session_id: bob });
    assert.deepEqual(links(bob), [...trees.slice(0, 9), trees[10]]);

    // Agents' new worktrees are recorded as theirs and linked to their session.
    const carol = agent('carol');
    const dave = agent('dave');
    const registry = createTestMcpRegistry({ tempDir: dir, database, timeline,
      terminal: { request: async () => ({}) } as unknown as TerminalService,
      workbench: new WorkbenchRepository(database) });
    const created = await registry.callPublic('worktree.create', { project_id: 'p', name: 'Agent tree', actor_type: 'user', actor_id: 'spoofed' }, { identity: 'carol' }) as AgentWorktreeResult;
    assert.equal(created.attached, true);
    assert.equal(created.warning, undefined);
    assert.deepEqual(db.prepare('select created_by from worktrees where id=?').get(created.worktree.id), { created_by: carol }, 'agents cannot choose the recorded creator');
    assert.deepEqual(db.prepare(`select actor_type, actor_id from timeline_events where event_type='worktree.created'`).get(), { actor_type: 'agent', actor_id: carol });
    assert.deepEqual(links(carol), [created.worktree.id]);
    const carolContext = await registry.callPublic('session.context', {}, { identity: 'carol' }) as { worktrees: SessionWorktrees };
    assert.deepEqual(carolContext.worktrees.items.map((item) => [item.id, item.worktree_path, item.own]), [[created.worktree.id, created.worktree.worktreePath, false]]);

    const manualPath = path.join(dir, 'manual');
    git(repo, ['worktree', 'add', '-q', '-b', 'manual/link', manualPath]);
    const linked = await registry.callPublic('worktree.link', { project_id: 'p', worktree_path: manualPath }, { identity: 'carol' }) as AgentWorktreeResult;
    assert.equal(linked.attached, true);
    const relinked = await registry.callPublic('worktree.link', { project_id: 'p', worktree_path: `${manualPath}${path.sep}` }, { identity: 'dave' }) as AgentWorktreeResult;
    assert.equal(relinked.worktree.id, linked.worktree.id, 'relinking returns the existing registration');
    assert.equal(relinked.attached, true);
    assert.equal((db.prepare('select count(*) n from worktrees where worktree_path=?').get(manualPath) as { n: number }).n, 1);
    assert.deepEqual([links(carol), links(dave)], [[created.worktree.id, linked.worktree.id], [linked.worktree.id]]);

    // Owner and UI calls do not link worktrees to sessions.
    const ownerTree = await registry.call('patterm.worktree.create', { project_id: 'p', name: 'Owner tree' }) as AgentWorktreeResult;
    assert.equal('attached' in ownerTree, false);
    assert.equal((db.prepare('select count(*) n from session_worktrees where worktree_id=?').get(ownerTree.worktree.id) as { n: number }).n, 0);

    // A full session keeps the new worktree and reports why it was not linked.
    const overflow = await registry.callPublic('worktree.create', { project_id: 'p', name: 'Overflow' }, { identity: 'bob' }) as AgentWorktreeResult;
    assert.equal(overflow.attached, false);
    assert.match(overflow.warning ?? '', /not linked to your session: A session can link at most 10 worktrees/);
    assert.ok(db.prepare('select 1 from worktrees where id=?').get(overflow.worktree.id), 'the worktree is not rolled back');
    assert.equal(links(bob).length, 10);

    // The UI attaches through the same tool, naming the session.
    await registry.call('patterm.worktree.attach', { project_id: 'p', worktree_id: ownerTree.worktree.id, session_id: dave });
    assert.deepEqual(links(dave), [linked.worktree.id, ownerTree.worktree.id]);
    assert.deepEqual(registry.changedTopics('patterm.worktree.attach'), ['context'], 'linking a worktree refreshes session context, not the workbench');
    assert.match(registry.helpPublic('session.context').description, /worktrees/);

    // Abandoning a worktree removes its links.
    await registry.call('patterm.worktree.abandon', { worktree_id: linked.worktree.id });
    assert.deepEqual([links(carol), links(dave)], [[created.worktree.id], [ownerTree.worktree.id]]);
    assert.deepEqual(db.prepare('pragma foreign_key_check').all(), []);
    console.log('session worktrees smoke passed');
  } finally {
    database.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
