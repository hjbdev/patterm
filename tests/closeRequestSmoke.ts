import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../app/Services/DatabaseService';
import { SettingsService } from '../app/Services/SettingsService';
import { NotificationService } from '../app/Services/NotificationService';
import { CloseProcessAction } from '../app/Actions/CloseProcessAction';
import { CloseRequestActions } from '../app/Actions/CloseRequestActions';
import { NotificationActions } from '../app/Actions/NotificationActions';
import { PresenceService } from '../app/Services/PresenceService';
import type { PushService } from '../app/Services/PushService';
import { WorkbenchRepository } from '../app/Repositories/WorkbenchRepository';
import type { TerminalService } from '../app/Services/TerminalService';

async function main(): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-close-request-test-'));
  const database = new DatabaseService(directory);
  try {
    database.initialize();
    const db = database.connection;
    const at = new Date(0).toISOString();
    db.prepare('insert into projects (id, name, path, created_at, updated_at) values (?, ?, ?, ?, ?)').run('project_a', 'Alpha', directory, at, at);
    const addAgent = (id: string, parent: string | null = null, integrated = 0) => {
      db.prepare(`insert into processes
        (id, project_id, parent_process_id, kind, name, status, activity, pty_process_id, created_at, updated_at)
        values (?, 'project_a', ?, 'agent', ?, 'running', 'idle', ?, ?, ?)`).run(id, parent, id, `pty_${id}`, at, at);
      db.prepare(`insert into sessions (id, project_id, process_id, harness, session_role, interface_mode, started_at)
        values (?, 'project_a', ?, 'claude', ?, ?, ?)`).run(`session_${id}`, id, parent ? 'child' : 'orchestrator', integrated ? 'integrated' : 'tui', at);
    };
    addAgent('root');
    addAgent('child', 'root');
    addAgent('integrated', null, 1);

    const messages: Array<{ processId: string; text: string }> = [];
    const messageProcess = async (processId: string, text: string) => { messages.push({ processId, text }); };
    const notifications = new NotificationService(database, new SettingsService(database), { append: () => 'event' }, messageProcess, () => undefined);
    const terminalCalls: string[] = [];
    const terminal = { request: async (method: string) => { terminalCalls.push(method); return {}; } } as unknown as TerminalService;
    let changes = 0;
    const requests = new CloseRequestActions(database, { append: () => 'event' }, new CloseProcessAction(database, terminal, undefined, undefined, notifications), messageProcess, () => { changes += 1; }, notifications);
    const sessions = () => new WorkbenchRepository(database).snapshot().projects[0]!.projectSessions;
    const closeRequest = (id: string) => sessions().find((session) => session.processId === id)?.closeRequest ?? null;

    // A root TUI agent's request waits for the user and is announced at once.
    assert.deepEqual(await requests.request('root', { summary: 'Opened PR #74.' }), { status: 'requested' });
    assert.equal(closeRequest('root')?.summary, 'Opened PR #74.');
    assert.ok(changes > 0);
    const open = notifications.list({ process_id: 'root' }).items;
    assert.equal(open.length, 1);
    assert.equal(open[0]!.title, 'Ready to close');

    // A child asks its parent instead.
    assert.deepEqual(await requests.request('child', { summary: 'Review done.' }), { status: 'routed_to_parent', parent_process_id: 'root' });
    assert.equal(messages.at(-1)?.processId, 'root');
    assert.match(messages.at(-1)!.text, /Close requested by child/);
    assert.equal(closeRequest('child'), null);

    // An Integrated agent announces only when its turn ends, and the request
    // is hidden while it is still working.
    await requests.request('integrated', { summary: 'All set.' });
    assert.equal(notifications.list({ process_id: 'integrated' }).total, 0);
    db.prepare(`update processes set activity = 'working' where id = 'integrated'`).run();
    assert.equal(closeRequest('integrated'), null);
    db.prepare(`update processes set activity = 'idle' where id = 'integrated'`).run();
    assert.equal(closeRequest('integrated')?.summary, 'All set.');
    await requests.announce('integrated');
    assert.equal(notifications.list({ process_id: 'integrated' }).total, 1);

    // User input withdraws a request, by Patterm or PTY id.
    const actions = new NotificationActions(notifications, new SettingsService(database), new PresenceService(), {} as PushService);
    actions.onUserInput((processId) => requests.clear(processId));
    actions.userInput('pty_integrated');
    assert.equal(closeRequest('integrated'), null);
    await assert.rejects(requests.answer({ process_id: 'integrated', decision: 'close' }), /no pending close request/);

    // Keep open with a reason tells the agent; without one it stays quiet.
    await requests.request('integrated', { summary: 'Done again.' });
    const sent = messages.length;
    assert.deepEqual(await requests.answer({ process_id: 'integrated', decision: 'keep_open' }), { kept_open: true });
    assert.equal(messages.length, sent);
    await requests.request('integrated', { summary: 'Done, really.' });
    await requests.answer({ process_id: 'integrated', decision: 'keep_open', feedback: 'Wait for CI.' });
    assert.deepEqual(messages.at(-1), { processId: 'integrated', text: '[Close request declined by the user]\nWait for CI.' });
    assert.equal(closeRequest('integrated'), null);

    // Close closes the agent and its subagents.
    assert.deepEqual(await requests.answer({ process_id: 'root', decision: 'close' }), { closed: ['root', 'child'] });
    const statuses = db.prepare(`select id, status from processes where id in ('root', 'child') order by id`).all() as Array<{ id: string; status: string }>;
    assert.deepEqual(statuses.map((row) => ({ ...row })), [{ id: 'child', status: 'closed' }, { id: 'root', status: 'closed' }]);
    assert.equal(notifications.list({ process_id: 'root' }).total, 0);
    await assert.rejects(requests.request('root', { summary: 'x' }), /not running/);
  } finally {
    database.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().then(() => console.log('close request smoke passed')).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
