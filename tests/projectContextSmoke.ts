import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../app/Services/DatabaseService';
import { TimelineService } from '../app/Services/TimelineService';
import { ProjectContextService, type TodoRow, type ScratchpadRow, type ReferenceRow } from '../app/Services/ProjectContextService';
import { ProjectContextAction, type ContextOperation } from '../app/Actions/ProjectContextAction';
import { RegisterProcessAction, registerProcessInput } from '../app/Actions/RegisterProcessAction';
import { RegisterSessionAction, registerSessionInput } from '../app/Actions/RegisterSessionAction';
import { WorkbenchRepository } from '../app/Repositories/WorkbenchRepository';
import type { TerminalService } from '../app/Services/TerminalService';
import { createTestMcpRegistry } from './fixtures/McpRegistryFixture';

type Todo = TodoRow & { assignments: string[]; blocked: boolean; lease: { holder_actor: string; expires_at: number } | null };
type Page<T> = { items: T[]; total: number };
type Lease = { token: string; holder_actor: string; expires_at: number };

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-project-context-'));
  const database = new DatabaseService(dir);
  try {
    database.initialize();
    const db = database.connection;
    let now = Date.now();
    for (const id of ['p', 'other']) db.prepare('insert into projects(id,name,path,created_at,updated_at) values(?,?,?,?,?)').run(id, id, dir, new Date(now).toISOString(), new Date(now).toISOString());
    const timeline = new TimelineService(database);
    const service = new ProjectContextService(database, timeline, () => now);
    const action = new ProjectContextAction(database, service);
    const call = <T = unknown>(operation: ContextOperation, input: Record<string, unknown> = {}, identity?: string) => action.execute(operation, { project_id: 'p', ...input }, identity) as T;
    const agent = (identity: string, project = 'p') => {
      const { process_id } = new RegisterProcessAction(database, timeline).execute(registerProcessInput.parse({ project_id: project, name: identity, kind: 'agent' }));
      return new RegisterSessionAction(database, timeline).execute(registerSessionInput.parse({ project_id: project, process_id, harness: 'claude', mcp_identity: identity })).session_id;
    };
    const alice = agent('alice');
    const bob = agent('bob');
    const outsider = agent('outsider', 'other');
    const todo = (title: string, options: Record<string, unknown> = {}) => call<Todo>('patterm.todo.create', { title, ...options });
    const get = (id: string) => call<Todo>('patterm.todo.get', { todo_id: id });
    const a = todo('Write plan', { priority: 'high', notes: 'Find requirements' });
    const b = todo('Implement', { priority: 'low', status: 'backlog' });
    const c = todo('Verify');
    const foreign = todo('Private', { project_id: 'other' });
    assert.equal(a.revision, 1);
    assert.equal(call<Page<Todo>>('patterm.todo.list', { status: 'backlog', priority: 'low' }).items[0]?.id, b.id);
    assert.equal(call<Page<Todo>>('patterm.todo.list', { query: 'requirements' }).total, 1);
    assert.equal(call<Page<Todo>>('patterm.todo.list', { limit: 1, offset: 1 }).items.length, 1);
    assert.equal(call<Page<Todo>>('patterm.todo.list').total, 3);
    assert.throws(() => call('patterm.todo.get', { todo_id: foreign.id }), /not found/);
    assert.throws(() => call('patterm.todo.list', {}, 'unknown'), /identity/);
    assert.throws(() => call('patterm.todo.list', { project_id: 'other' }, 'alice'), /scope/);
    assert.throws(() => call('patterm.todo.create', { title: 'Spoof', actor_id: bob }, 'alice'), /Unrecognized/);

    call('patterm.todo.dependency_add', { todo_id: b.id, blocker_id: a.id });
    call('patterm.todo.dependency_add', { todo_id: c.id, blocker_id: b.id });
    assert.equal(get(b.id).blocked, true);
    assert.equal(call<Page<Todo>>('patterm.todo.list', { blocked: true }).total, 2);
    assert.throws(() => call('patterm.todo.dependency_add', { todo_id: a.id, blocker_id: c.id }), /cycle/);
    assert.throws(() => call('patterm.todo.dependency_add', { todo_id: a.id, blocker_id: a.id }), /itself/);
    assert.throws(() => call('patterm.todo.dependency_add', { todo_id: a.id, blocker_id: foreign.id }), /not found/);
    assert.throws(() => call('patterm.todo.delete', { todo_id: a.id, revision: get(a.id).revision }), /dependencies/);
    call('patterm.todo.update', { todo_id: a.id, revision: get(a.id).revision, status: 'completed' });
    assert.equal(get(b.id).blocked, false);
    call('patterm.todo.update', { todo_id: a.id, revision: get(a.id).revision, status: 'open' });
    assert.equal(get(b.id).blocked, true);
    assert.throws(() => call('patterm.todo.update', { todo_id: a.id, revision: 1, title: 'Overwrite' }), /Revision conflict/);

    call('patterm.todo.assign', { todo_id: a.id }, 'alice');
    call('patterm.todo.assign', { todo_id: a.id }, 'alice');
    call('patterm.todo.assign', { todo_id: a.id, assignee_id: 'user' });
    assert.deepEqual(get(a.id).assignments.sort(), [alice, 'user'].sort());
    assert.throws(() => call('patterm.todo.assign', { todo_id: a.id, assignee_id: outsider }), /not found/);
    assert.equal(call<Page<Todo>>('patterm.todo.list', { assignee_id: alice }).total, 1);
    call('patterm.todo.unassign', { todo_id: a.id, assignee_id: 'user' });

    const first = call<Lease>('patterm.todo.lease_acquire', { todo_id: a.id }, 'alice');
    assert.equal(first.expires_at, now + 300_000);
    assert.equal(first.holder_actor, alice);
    assert.throws(() => call('patterm.todo.lease_acquire', { todo_id: a.id }, 'bob'), /Lease conflict/);
    assert.equal(db.prepare('select * from todo_leases where todo_id=?').all(a.id).length, 1);
    assert.throws(() => call('patterm.todo.lease_acquire', { todo_id: b.id, holder_actor: alice }, 'bob'), /Unrecognized/);
    assert.throws(() => call('patterm.todo.lease_renew', { todo_id: a.id, token: first.token }, 'bob'), /another actor/);
    assert.throws(() => call('patterm.todo.lease_release', { todo_id: a.id, token: randomUUID() }, 'alice'), /replaced/);
    assert.throws(() => call('patterm.todo.lease_revoke', { todo_id: a.id }, 'bob'), /Only the owner/);
    call('patterm.todo.lease_renew', { todo_id: a.id, token: first.token, ttl_seconds: 1 }, 'alice');
    now += 1000;
    assert.equal(get(a.id).lease, null);
    assert.throws(() => call('patterm.todo.lease_renew', { todo_id: a.id, token: first.token }, 'alice'), /expired/);
    assert.throws(() => call('patterm.todo.lease_release', { todo_id: a.id, token: first.token }, 'alice'), /expired/);
    const second = call<Lease>('patterm.todo.lease_acquire', { todo_id: a.id }, 'bob');
    assert.notEqual(second.token, first.token);
    call('patterm.todo.lease_revoke', { todo_id: a.id });
    assert.equal(get(a.id).lease, null);
    assert.throws(() => call('patterm.todo.lease_release', { todo_id: a.id, token: second.token }, 'bob'), /replaced/);
    const held = call<Lease>('patterm.todo.lease_acquire', { todo_id: a.id }, 'alice');
    for (const operation of ['patterm.todo.get', 'patterm.todo.list', 'patterm.session.context'] as const) {
      const result = call(operation, operation.endsWith('.get') ? { todo_id: a.id } : operation.endsWith('.context') ? { session_id: alice } : {});
      assert.ok(!JSON.stringify(result).includes(held.token), `${operation} must redact lease tokens`);
    }
    call('patterm.todo.update', { todo_id: a.id, revision: get(a.id).revision, status: 'completed' });
    assert.equal(get(a.id).lease, null);
    assert.throws(() => call('patterm.todo.lease_acquire', { todo_id: a.id }, 'alice'), /completed/);
    assert.throws(() => call('patterm.todo.lease_acquire', { todo_id: b.id, ttl_seconds: 86401 }, 'alice'));

    const pad = call<ScratchpadRow>('patterm.scratchpad.create', { title: 'Plan', body: '# Plan\nFirst\n## Checks\nSecond' });
    call('patterm.scratchpad.append', { scratchpad_id: pad.id, body: '\nThird' });
    call('patterm.scratchpad.append', { scratchpad_id: pad.id, body: '\nFourth' });
    const read = () => call<ScratchpadRow>('patterm.scratchpad.get', { scratchpad_id: pad.id });
    assert.equal(read().revision, 3);
    assert.ok(read().body.endsWith('Third\nFourth'));
    assert.throws(() => call('patterm.scratchpad.update', { scratchpad_id: pad.id, revision: 1, body: 'Lost update' }), /Revision conflict/);
    assert.throws(() => call('patterm.scratchpad.append', { scratchpad_id: pad.id, revision: 1, body: 'Lost update' }), /Revision conflict/);
    assert.equal(call<ScratchpadRow>('patterm.scratchpad.get', { scratchpad_id: pad.id, mode: 'headings' }).body, '# Plan\n## Checks');
    assert.equal(call<ScratchpadRow>('patterm.scratchpad.get', { scratchpad_id: pad.id, offset: 1, limit: 1 }).body, 'First');
    assert.throws(() => call('patterm.scratchpad.append', { scratchpad_id: pad.id, body: 'x'.repeat(262144) }), /exceeds/);
    call('patterm.scratchpad.attach', { scratchpad_id: pad.id }, 'alice');
    call('patterm.scratchpad.attach', { scratchpad_id: pad.id }, 'alice');
    assert.equal(db.prepare('select * from session_scratchpads').all().length, 1);
    assert.throws(() => call('patterm.scratchpad.attach', { scratchpad_id: pad.id, session_id: outsider }), /not found/);
    const assigned = todo('Assigned on create', { assignee_id: alice });
    assert.deepEqual(assigned.assignments, [alice]);
    const attached = call<ScratchpadRow>('patterm.scratchpad.create', { title: 'Attached on create', session_id: bob });
    assert.ok(db.prepare('select 1 from session_scratchpads where session_id=? and scratchpad_id=?').get(bob, attached.id));
    const todoCount = db.prepare('select count(*) n from todos').get(), padCount = db.prepare('select count(*) n from scratchpads').get();
    assert.throws(() => todo('Foreign assignee', { assignee_id: outsider }), /not found/);
    assert.throws(() => call('patterm.scratchpad.create', { title: 'Foreign session', session_id: outsider }), /not found/);
    assert.deepEqual(db.prepare('select count(*) n from todos').get(), todoCount);
    assert.deepEqual(db.prepare('select count(*) n from scratchpads').get(), padCount);
    call('patterm.scratchpad.update', { scratchpad_id: pad.id, revision: read().revision, status: 'archived' });
    assert.equal(call<Page<ScratchpadRow>>('patterm.scratchpad.list', { status: 'archived', query: 'Third' }).total, 1);

    const reference = call<ReferenceRow>('patterm.reference.attach', { target_type: 'todo', target_id: a.id, url: 'https://EXAMPLE.com:443/issues/1', identifier: 'PAT-1' });
    const again = call<ReferenceRow>('patterm.reference.attach', { target_type: 'todo', target_id: a.id, url: 'https://example.com/issues/1', title: 'Does not overwrite' });
    assert.equal(reference.id, again.id);
    assert.equal(again.title, null);
    for (const [target_type, target_id] of [['scratchpad', pad.id], ['session', alice]]) {
      assert.equal(call<ReferenceRow>('patterm.reference.attach', { target_type, target_id, url: reference.url }).id, reference.id);
    }
    assert.equal(call<Page<ReferenceRow>>('patterm.reference.list', { target_type: 'todo', target_id: a.id }).total, 1);
    for (const url of ['javascript:alert(1)', 'file:///tmp/private', 'https://user:pass@example.com/']) {
      assert.throws(() => call('patterm.reference.attach', { target_type: 'todo', target_id: a.id, url }), /HTTP\(S\)/);
    }
    assert.throws(() => call('patterm.reference.attach', { target_type: 'session', target_id: outsider, url: reference.url }), /not found/);
    assert.throws(() => call('patterm.reference.update', { project_id: 'other', reference_id: reference.id, revision: 1, title: 'Leak' }), /not found/);
    call('patterm.reference.update', { reference_id: reference.id, revision: 1, title: 'Verified issue' });
    assert.throws(() => call('patterm.reference.update', { reference_id: reference.id, revision: 1, title: 'Overwrite' }), /Revision conflict/);
    const other = call<ReferenceRow>('patterm.reference.attach', { target_type: 'todo', target_id: a.id, url: 'https://example.com/issues/2' });
    assert.throws(() => call('patterm.reference.update', { reference_id: reference.id, revision: 2, url: other.url }), /already uses that URL/);
    assert.throws(() => call('patterm.reference.update', { reference_id: reference.id, revision: 2, url: 'https://user:pass@example.com/' }), /HTTP\(S\)/);
    const moved = call<ReferenceRow>('patterm.reference.update', { reference_id: reference.id, revision: 2, url: 'https://EXAMPLE.com:443/pulls/1', resource_type: 'pull_request' });
    assert.deepEqual([moved.url, moved.resource_type, moved.title, moved.identifier], ['https://example.com/pulls/1', 'pull_request', 'Verified issue', 'PAT-1']);
    call('patterm.reference.detach', { target_type: 'todo', target_id: a.id, reference_id: other.id });
    const context = call<{ scratchpads: Page<ScratchpadRow>; references: Page<ReferenceRow> }>('patterm.session.context', {}, 'alice');
    assert.equal(context.scratchpads.total, 1, 'Archiving preserves session attachments');
    assert.equal(context.references.items[0]?.title, 'Verified issue');
    assert.ok(!('body' in context.scratchpads.items[0]!), 'Context excludes full note bodies');
    call('patterm.reference.detach', { target_type: 'todo', target_id: a.id, reference_id: reference.id });
    assert.equal(call<Page<ReferenceRow>>('patterm.reference.list', { target_type: 'session', target_id: alice }).total, 1);
    const pr = call<ReferenceRow>('patterm.reference.attach', { target_type: 'session', url: 'https://github.com/o/r/pull/42', provider: 'github', resource_type: 'pull_request' }, 'bob');
    assert.equal(call<Page<ReferenceRow>>('patterm.reference.list', { target_type: 'session', target_id: bob }).items[0]?.id, pr.id, 'Agents attach to their own session without target_id');
    assert.equal(call<Page<ReferenceRow>>('patterm.reference.list', { target_type: 'session' }, 'bob').total, 1);
    assert.throws(() => call('patterm.reference.attach', { target_type: 'session', url: pr.url }), /owner requests/);
    assert.throws(() => call('patterm.reference.attach', { target_type: 'todo', url: pr.url }, 'bob'), /todo targets/);
    call('patterm.reference.detach', { target_type: 'session', reference_id: pr.id }, 'bob');
    assert.equal(call<Page<ReferenceRow>>('patterm.reference.list', { target_type: 'session', target_id: bob }).total, 0);
    const registry = createTestMcpRegistry({ tempDir: dir, database, timeline,
      terminal: { request: async () => ({}) } as unknown as TerminalService,
      workbench: new WorkbenchRepository(database) });
    const mcpTodo = await registry.callPublic('todo.create', { title: 'MCP work' }, { identity: 'alice' }) as Todo;
    assert.equal(mcpTodo.project_id, 'p');
    assert.equal(call<Todo>('patterm.todo.get', { todo_id: mcpTodo.id }).title, 'MCP work', 'Owner reads the record created through MCP');
    await assert.rejects(registry.call('patterm.todo.list', { project_id: 'p' }, { identity: 'unknown' }), /identity/);
    await assert.rejects(registry.callPublic('todo.list', { project_id: 'other' }, { identity: 'alice' }), /scope/);
    assert.deepEqual(registry.changedTopics('patterm.todo.update'), ['context'], 'context writes refresh context views only');
    for (const name of ['patterm.todo.create', 'patterm.todo.assign', 'patterm.todo.unassign', 'patterm.todo.delete']) {
      assert.deepEqual(registry.changedTopics(name), ['workbench', 'context'], `${name} can change which ended sessions the workbench keeps`);
    }
  assert.deepEqual(registry.changedTopics('patterm.session.context'), [], 'context reads announce nothing');
  const contenders = await Promise.allSettled(['alice', 'bob'].map(identity => registry.call(
    'patterm.todo.lease_acquire', { todo_id: mcpTodo.id }, { identity }
  )));
  assert.equal(contenders.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(contenders.filter(result => result.status === 'rejected').length, 1);
    assert.deepEqual(db.prepare('pragma foreign_key_check').all(), []);
    console.log('project context smoke passed');
  } finally {
    database.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

void main();
