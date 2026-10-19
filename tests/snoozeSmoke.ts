import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../app/Services/DatabaseService';
import { SnoozeActions } from '../app/Actions/SnoozeActions';
import { WorkbenchRepository } from '../app/Repositories/WorkbenchRepository';
import { removeTree } from './fixtures/TempTree';

function main(): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-snooze-test-'));
  const database = new DatabaseService(directory);
  try {
    database.initialize();
    const db = database.connection;
    const at = new Date(0).toISOString();
    db.prepare('insert into projects (id, name, path, created_at, updated_at) values (?, ?, ?, ?, ?)').run('project_a', 'Alpha', directory, at, at);
    db.prepare(`insert into processes (id, project_id, kind, name, status, activity, pty_process_id, created_at, updated_at)
      values ('root', 'project_a', 'agent', 'root', 'running', 'idle', 'pty_root', ?, ?)`).run(at, at);
    db.prepare(`insert into sessions (id, project_id, process_id, harness, session_role, interface_mode, started_at)
      values ('session_root', 'project_a', 'root', 'claude', 'orchestrator', 'tui', ?)`).run(at);

    let changes = 0;
    const snoozes = new SnoozeActions(database, { append: () => 'event' }, () => { changes += 1; });
    const snooze = () => new WorkbenchRepository(database).snapshot().projects[0]!.projectSessions[0]!.snooze ?? null;

    // Snoozing keeps the reminder; an idle agent stays asleep until a turn ends.
    snoozes.snooze({ process_id: 'root', reminder: '  Check the CI run.  ' });
    assert.equal(snooze()?.reminder, 'Check the CI run.');
    assert.ok(snooze()?.snoozedAt);
    assert.equal(changes, 1);
    snoozes.activity('root', 'idle', 'working');
    assert.ok(snooze()?.snoozedAt, 'starting work is not a message');
    snoozes.activity('root', 'working', 'thinking');
    assert.ok(snooze()?.snoozedAt);

    // The turn ending wakes it, by PTY id too, and the reminder stays.
    snoozes.activity('pty_root', 'thinking', 'idle');
    assert.deepEqual(snooze(), { snoozedAt: null, reminder: 'Check the CI run.' });
    assert.deepEqual(snoozes.dismissReminder({ process_id: 'root' }), { dismissed: true });
    assert.equal(snooze(), null);

    // A question or permission request is a message even mid-turn.
    snoozes.snooze({ process_id: 'root' });
    assert.deepEqual(snooze()?.reminder, null);
    snoozes.activity('root', 'idle', 'permission');
    assert.equal(snooze(), null);

    // Reconnect snapshots from idle to idle wake nothing; user input does.
    snoozes.snooze({ process_id: 'root', reminder: 'Merge it' });
    snoozes.activity('root', 'unknown', 'idle');
    assert.ok(snooze()?.snoozedAt);
    snoozes.userInput('pty_root');
    assert.deepEqual(snooze(), { snoozedAt: null, reminder: 'Merge it' });

    // A reminder can't be dismissed while still asleep; waking by hand drops it.
    snoozes.snooze({ process_id: 'root', reminder: 'Later' });
    assert.deepEqual(snoozes.dismissReminder({ process_id: 'root' }), { dismissed: false });
    snoozes.unsnooze({ process_id: 'root' });
    assert.equal(snooze(), null);

    // An exited agent can't be snoozed, and its stale snooze doesn't show.
    snoozes.snooze({ process_id: 'root' });
    db.prepare(`update processes set status = 'exited' where id = 'root'`).run();
    assert.equal(snooze(), null);
    assert.throws(() => snoozes.snooze({ process_id: 'root' }), /running agent/);
  } finally {
    database.dispose();
    removeTree(directory);
  }
}

main();
console.log('snooze smoke passed');
