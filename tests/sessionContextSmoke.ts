import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../app/Services/DatabaseService';
import { TimelineService } from '../app/Services/TimelineService';
import { RegisterSessionAction, registerSessionInput } from '../app/Actions/RegisterSessionAction';
import { ReconcileRuntimeAction } from '../app/Actions/ReconcileRuntimeAction';
import { SessionContextService } from '../app/Services/SessionContextService';
import { HarnessLauncher } from '../app/Services/HarnessLauncher';
import { harnessProviders } from '../app/Harness/providers';
import { WorkbenchRepository } from '../app/Repositories/WorkbenchRepository';

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-session-context-'));
  const database = new DatabaseService(dir);
  try {
    database.initialize();
    const db = database.connection;
    const now = new Date().toISOString();
    for (const id of ['p', 'other']) db.prepare('insert into projects(id,name,path,created_at,updated_at) values(?,?,?,?,?)').run(id, id, dir, now, now);
    const timeline = new TimelineService(database);
    const register = (project = 'p', harness = 'claude', resume = 'native', imported = false) => new RegisterSessionAction(database, timeline).execute(registerSessionInput.parse({
      project_id: project, harness, resume_id: resume, resume_status: imported ? 'imported' : 'found'
    })).session_id;
    const source = register();
    const otherProjectSession = register('other');
    register('p', 'codex');
    for (const [id, status] of [['open', 'open'], ['done', 'completed']]) {
      db.prepare(`insert into todos(id,project_id,title,status,created_at,updated_at,created_by_actor) values(?,'p',?,?,?,?,'user')`).run(id, id, status, now, now);
      db.prepare('insert into todo_assignments values(?,?,?)').run(id, source, source);
    }
    db.prepare(`insert into scratchpads(id,project_id,title,created_at,updated_at,created_by_actor) values('pad','p','Plan',?,?,'user')`).run(now, now);
    db.prepare('insert into session_scratchpads values(?,?)').run(source, 'pad');
    db.prepare(`insert into external_references(id,project_id,url,provider,resource_type,created_at,updated_at) values('ref','p','https://example.com/1','generic','link',?,?)`).run(now, now);
    db.prepare('insert into session_references values(?,?)').run(source, 'ref');
    db.prepare('insert into todo_leases values(?,?,?,?,?)').run('open', source, source, 'original-token', Date.now() + 60_000);
    for (const id of ['wt_a', 'wt_b']) {
      db.prepare(`insert into worktrees(id,project_id,repo_path,worktree_path,branch,created_by,created_at) values(?,'p',?,?,?,'user',?)`).run(id, dir, path.join(dir, id), id, now);
    }
    const linkedAt = ['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'];
    db.prepare('insert into session_worktrees values(?,?,?)').run(source, 'wt_b', linkedAt[0]);
    db.prepare('insert into session_worktrees values(?,?,?)').run(source, 'wt_a', linkedAt[1]);
    const resumed = register('p', 'claude', 'native', true);
    assert.deepEqual(db.prepare('select resumed_from_session_id from sessions where id = ?').get(resumed), { resumed_from_session_id: source });
    assert.deepEqual(db.prepare('select session_id from todo_assignments where todo_id = ?').get('open'), { session_id: resumed });
    assert.deepEqual(db.prepare('select session_id from todo_assignments where todo_id = ?').get('done'), { session_id: source });
    assert.deepEqual(db.prepare('select holder_session_id from todo_leases').get(), { holder_session_id: source });
    assert.equal(db.prepare('select * from session_references').all().length, 2);
    assert.equal(db.prepare('select * from session_scratchpads').all().length, 2);
    assert.deepEqual(db.prepare('select worktree_id, created_at from session_worktrees where session_id = ? order by created_at, rowid').all(resumed),
      [{ worktree_id: 'wt_b', created_at: linkedAt[0] }, { worktree_id: 'wt_a', created_at: linkedAt[1] }], 'resumed sessions keep linked worktrees in link order');
    const ownSource = register('p', 'codex', 'own-check');
    for (const id of ['wt_a', 'wt_b']) db.prepare('insert into session_worktrees values(?,?,?)').run(ownSource, id, now);
    const ownResumed = new RegisterSessionAction(database, timeline).execute(registerSessionInput.parse({
      project_id: 'p', harness: 'codex', resume_id: 'own-check', resume_status: 'imported', worktree_id: 'wt_a'
    })).session_id;
    assert.deepEqual(db.prepare('select worktree_id from session_worktrees where session_id = ?').all(ownResumed), [{ worktree_id: 'wt_b' }], 'a resumed session does not link its own worktree');
    const imported = register('p', 'claude', 'unknown', true);
    assert.deepEqual(db.prepare('select resumed_from_session_id from sessions where id = ?').get(imported), { resumed_from_session_id: null });
    assert.throws(() => new RegisterSessionAction(database, timeline).execute(registerSessionInput.parse({
      project_id: 'p', harness: 'claude', resume_id: 'native', resumed_from_session_id: otherProjectSession
    })), /does not match/);

    // Failure after inheritance must roll back the new session and assignment transfer.
    const shimPath = path.join(dir, 'shim.js');
    fs.writeFileSync(shimPath, '');
    db.prepare(`insert into harness_installations(id,harness,executable_path,status,discovered_at,last_checked_at) values('h','claude','/bin/true','available',?,?)`).run(now, now);
    const requests: string[] = [];
    const launcher = new HarnessLauncher({ database,
      timeline: new TimelineService(database, () => {
        if (db.prepare(`select id from timeline_events where event_type = 'session.started'`).all().length > 5) throw new Error('injected registration failure');
      }),
      terminal: { request: async (method) => { requests.push(method); return { process_id: 'pty-failure' }; } },
      workbench: new WorkbenchRepository(database), providers: harnessProviders, nodePath: process.execPath,
      shimPath, socketPath: path.join(dir, 'socket'), runtimeDir: dir
    });
    const before = db.prepare('select id from sessions').all().length;
    await assert.rejects(launcher.resume({ project_id: 'p', harness: 'claude' }, { resume_id: 'native', conversation_id: 'conversation' }), /injected registration failure/);
    assert.equal(db.prepare('select id from sessions').all().length, before);
    assert.deepEqual(db.prepare('select session_id from todo_assignments where todo_id = ?').get('open'), { session_id: resumed });
    assert.equal(db.prepare(`select id from processes where pty_process_id = 'pty-failure'`).all().length, 0);
    assert.deepEqual(requests, ['terminal.process.spawn', 'terminal.process.close']);

    db.prepare('update sessions set process_id = ? where id = ?').run('pty-source', source);
    new SessionContextService(database).releaseProcessLeases('pty-source');
    assert.equal(db.prepare('select * from todo_leases').all().length, 0);
    db.prepare('insert into todo_leases values(?,?,?,?,?)').run('open', resumed, resumed, 'fresh-token', Date.now() + 60_000);
    new ReconcileRuntimeAction(database).execute();
    assert.equal(db.prepare('select * from todo_leases').all().length, 0);
    assert.deepEqual(db.prepare('select session_id from todo_assignments where todo_id = ?').get('open'), { session_id: resumed });
    assert.deepEqual(db.prepare('pragma foreign_key_check').all(), []);
    console.log('session context smoke passed');
  } finally {
    database.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

void main();
