import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FinishedSubagentsAction } from '../app/Actions/FinishedSubagentsAction';
import { WorkbenchRepository } from '../app/Repositories/WorkbenchRepository';
import { DatabaseService } from '../app/Services/DatabaseService';
import type { HarnessLauncher, LaunchHarnessInput } from '../app/Services/HarnessLauncher';
import type { TerminalService } from '../app/Services/TerminalService';
import { TimelineService } from '../app/Services/TimelineService';
import { createTestMcpRegistry } from './fixtures/McpRegistryFixture';

// Sub-agents can delegate further: a child spawns a grandchild that reports to
// the child, stays inside the project, and closes with its ancestors.
async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-nested-'));
  const database = new DatabaseService(dir);
  try {
    database.initialize();
    const db = database.connection;
    const now = new Date().toISOString();
    for (const id of ['p', 'other']) {
      db.prepare('insert into projects(id,name,path,created_at,updated_at) values(?,?,?,?,?)').run(id, id, path.join(dir, id), now, now);
    }
    db.prepare(`insert into worktrees(id,project_id,repo_path,worktree_path,branch,created_by,created_at) values(?,?,?,?,?,'user',?)`)
      .run('wt_other', 'other', dir, path.join(dir, 'wt_other'), 'other', now);

    const insertAgent = (id: string, parent: string | null, role: string) => {
      db.prepare(`insert into processes(id,project_id,parent_process_id,kind,name,status,activity,created_at,updated_at) values(?,'p',?,'agent',?,'running','idle',?,?)`)
        .run(id, parent, id, now, now);
      db.prepare(`insert into sessions(id,project_id,process_id,mcp_identity,harness,session_role,resume_status,started_at,created_by_actor) values(?,'p',?,?,'codex',?,'unknown',?,'user')`)
        .run(`session_${id}`, id, `identity_${id}`, role, now);
    };
    insertAgent('root', null, 'orchestrator');

    const launches: LaunchHarnessInput[] = [];
    const harnessLauncher = {
      async launch(input: LaunchHarnessInput) {
        launches.push(input);
        const id = input.name ?? `agent_${launches.length}`;
        insertAgent(id, input.parent_process_id ?? null, input.session_role ?? 'orchestrator');
        return { process_id: id, harness: input.harness ?? 'codex' };
      }
    } as unknown as HarnessLauncher;

    const inputs: Array<{ process_id: string; text: string }> = [];
    const terminal = {
      async request(method: string, params: unknown) {
        if (method === 'terminal.process.input') inputs.push(params as { process_id: string; text: string });
        return { ok: true };
      }
    } as unknown as TerminalService;
    const timeline = new TimelineService(database);
    const registry = createTestMcpRegistry({ tempDir: dir, database, timeline, terminal, workbench: new WorkbenchRepository(database), harnessLauncher });
    const as = (id: string) => ({ identity: `identity_${id}` });

    const childWho = await registry.callPublic('whoami', { include_tools: true }, as('root')) as { available_tools: string[] };
    assert.ok(childWho.available_tools.includes('spawn_agent'));
    await registry.call('spawn_agent', { agent: 'codex', name: 'child', prompt: 'Review the API.' }, as('root'));
    const subWho = await registry.callPublic('whoami', { include_tools: true }, as('child')) as { role: string; parent_process_id: string; available_tools: string[] };
    assert.equal(subWho.role, 'sub-agent');
    assert.equal(subWho.parent_process_id, 'root');
    assert.ok(subWho.available_tools.includes('spawn_agent'), 'sub-agents are offered spawn_agent');
    assert.match(registry.help('spawn_agent').usageNotes?.join('\n') ?? '', /must not start unrelated work/, 'help keeps nested spawns inside the delegated task');

    // A sub-agent spawns a grandchild, which is its own child in its project.
    const spawned = await registry.call('spawn_agent', { agent: 'codex', name: 'grandchild', prompt: 'Check the tests.' }, as('child')) as { process_id: string; parent_process_id: string };
    assert.equal(spawned.parent_process_id, 'child', 'the grandchild reports to the sub-agent that spawned it');
    const launched = launches.at(-1);
    assert.equal(launched?.parent_process_id, 'child');
    assert.equal(launched?.session_role, 'child');
    assert.equal(launched?.project_id, 'p', 'the grandchild joins the caller project');
    assert.equal(launched?.actor_id, 'session_child');
    assert.match(launched?.initial_prompt ?? '', /call report_to_parent/);
    const listed = await registry.call('list_processes', { kind: 'agent' }, as('child')) as { processes: Array<{ process_id: string; parent_process_id?: string }> };
    assert.equal(listed.processes.find((row) => row.process_id === 'grandchild')?.parent_process_id, 'child');

    // Nesting does not widen scope: no other project, worktree, or process.
    await assert.rejects(registry.call('spawn_agent', { agent: 'codex', project_id: 'other' }, as('child')), /outside the current caller scope/);
    await assert.rejects(registry.call('spawn_agent', { agent: 'codex', worktree_id: 'wt_other' }, as('child')), /outside the current caller scope/);
    db.prepare(`insert into processes(id,project_id,kind,name,status,created_at,updated_at) values('foreign','other','agent','foreign','running',?,?)`).run(now, now);
    await assert.rejects(registry.call('timer_fire_when_reported_all', { watched: ['foreign'], body: 'x' }, as('child')), /outside the current caller scope/);
    assert.equal(launches.length, 2, 'rejected spawns launch nothing');

    // The sub-agent waits on its own child, and the report reaches it, not the root.
    await registry.call('timer_fire_when_reported_all', { watched: ['grandchild'], body: 'grandchild done' }, as('child'));
    await registry.call('report_to_parent', { status: 'completed', body: 'Tests pass.' }, as('grandchild'));
    const report = inputs.find((input) => input.text.startsWith('[report from grandchild'));
    assert.equal(report?.process_id, 'child', 'the grandchild reports to its own parent');
    assert.ok(!inputs.some((input) => input.process_id === 'root'), 'nothing skips a level to the root');
    // The report carries the timer's callback, so the sub-agent wakes once.
    assert.match(report!.text, /^\[report from grandchild: completed\]\nTests pass\.\n\n\[Patterm timer timer_\w+: condition met\]\n- grandchild "grandchild": reported completed at \S+: Tests pass\.\nRead full results with get_conversation_output\.\ngrandchild done$/);
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(inputs.filter((input) => input.process_id === 'child').length, 1, 'no second callback repeats the report');
    await registry.call('send_message', { target_process_id: 'parent', message: 'question' }, as('grandchild'));
    assert.equal(inputs.at(-1)?.process_id, 'child', 'parent alias resolves to the direct parent');

    // A reported, idle sub-agent with a running child is not offered for closing.
    await registry.call('report_to_parent', { status: 'completed', body: 'Done.' }, as('child'));
    db.prepare(`update processes set status = 'exited' where id = 'grandchild'`).run();
    assert.deepEqual(new FinishedSubagentsAction(database).execute('root').map((row) => row.process_id), ['child'], 'a reported child is finished once its own children stop');
    db.prepare(`update processes set status = 'running' where id = 'grandchild'`).run();
    assert.deepEqual(new FinishedSubagentsAction(database).execute('root'), [], 'closing a delegating child would close its running grandchild');
    // A stopped grandchild does not hide a running great-grandchild, which closing would reach.
    db.prepare(`update processes set status = 'exited' where id = 'grandchild'`).run();
    insertAgent('great_grandchild', 'grandchild', 'child');
    assert.deepEqual(new FinishedSubagentsAction(database).execute('root'), [], 'a running agent at any depth keeps its ancestor open');
    db.prepare(`update processes set status = 'exited' where id = 'great_grandchild'`).run();
    assert.deepEqual(new FinishedSubagentsAction(database).execute('root').map((row) => row.process_id), ['child'], 'the child is finished once nothing below it runs');
    db.prepare(`update processes set status = 'running' where id in ('grandchild', 'great_grandchild')`).run();

    // Agents the assistant spawns are sub-agents too, and can delegate in turn.
    insertAgent('assistant', null, 'assistant');
    await registry.call('spawn_agent', { agent: 'codex', name: 'helper', project_id: 'p' }, as('assistant'));
    const helperWho = await registry.callPublic('whoami', {}, as('helper')) as { role: string; parent_process_id: string };
    assert.deepEqual([helperWho.role, helperWho.parent_process_id], ['sub-agent', 'assistant']);
    await registry.call('spawn_agent', { agent: 'codex', name: 'helper_child' }, as('helper'));
    assert.deepEqual([launches.at(-1)?.parent_process_id, launches.at(-1)?.project_id], ['helper', 'p']);
    await assert.rejects(registry.call('spawn_agent', { agent: 'codex', project_id: 'other' }, as('helper')), /outside the current caller scope/, 'only the assistant itself chooses projects');

    // Closing the root closes every level below it.
    const closed = await registry.call('close_process', { process_id: 'root' }) as { closed: string[] };
    assert.deepEqual(closed.closed, ['root', 'child', 'grandchild', 'great_grandchild']);
    const statuses = db.prepare(`select id, status from processes where id in ('root','child','grandchild','great_grandchild') order by id`).all() as Array<{ id: string; status: string }>;
    assert.ok(statuses.every((row) => row.status === 'closed'), 'every descendant is closed');
    console.log('nested agents smoke ok');
  } finally {
    database.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
