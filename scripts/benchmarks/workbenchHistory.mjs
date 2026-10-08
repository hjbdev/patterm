// Compile first: pnpm exec tsc -p tsconfig.tests.json
// Uses synthetic, temporary databases. Pass the pre-change Git ref (default HEAD).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import { DatabaseService } from '../../dist/tests/app/Services/DatabaseService.js';
import { HistoryDatabaseService } from '../../dist/tests/app/Services/HistoryDatabaseService.js';
import { WorkbenchRepository } from '../../dist/tests/app/Repositories/WorkbenchRepository.js';
import { RuntimeReconciler } from '../../dist/tests/app/Services/RuntimeReconciler.js';
import { HistorySearchIndexService } from '../../dist/tests/app/Services/AgentHistory/HistorySearchIndexService.js';

const reference = process.argv[2] ?? 'HEAD';
function baseline(source, name) {
  const code = execFileSync('git', ['show', `${reference}:${source}`], { encoding: 'utf8' });
  const module = { exports: {} };
  const require = createRequire(path.resolve('dist/tests', source.replace(/\.ts$/, '.js')));
  new Function('require', 'module', 'exports', transformSync(code, { loader: 'ts', format: 'cjs' }).code)(require, module, module.exports);
  return module.exports[name];
}
function summary(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { medianMs: (sorted[4] + sorted[5]) / 2, p95Ms: sorted[9], samplesMs: samples };
}
const implementations = [
  { name: 'before', Workbench: baseline('app/Repositories/WorkbenchRepository.ts', 'WorkbenchRepository'), Reconciler: baseline('app/Services/RuntimeReconciler.ts', 'RuntimeReconciler'), Search: baseline('app/Services/AgentHistory/HistorySearchIndexService.ts', 'HistorySearchIndexService') },
  { name: 'after', Workbench: WorkbenchRepository, Reconciler: RuntimeReconciler, Search: HistorySearchIndexService }
];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-workbench-history-bench-'));
const app = new DatabaseService(directory);
const history = new HistoryDatabaseService(directory);
const results = [];
try {
  app.initialize();
  history.initialize();
  const now = new Date().toISOString();
  app.connection.prepare('insert into projects (id, name, path, created_at, updated_at) values (?, ?, ?, ?, ?)').run('project', 'Fixture', directory, now, now);
  app.connection.transaction(() => {
    const process = app.connection.prepare("insert into processes (id, project_id, kind, name, status, pty_process_id, created_at, updated_at) values (?, 'project', 'agent', 'Agent', 'running', ?, ?, ?)");
    const session = app.connection.prepare("insert into sessions (id, project_id, process_id, session_role, resume_status, started_at) values (?, 'project', ?, 'orchestrator', 'unknown', ?)");
    for (let i = 0; i < 550; i++) {
      process.run(`process_${i}`, `pty_${i}`, now, now);
      session.run(`session_${i}`, `process_${i}`, now);
    }
    const timeline = app.connection.prepare("insert into timeline_events (id, project_id, event_type, actor_type, metadata, created_at) values (?, 'project', 'fixture', 'system', ?, ?)");
    for (let i = 0; i < 1800; i++) timeline.run(`event_${i}`, JSON.stringify({ text: 'x'.repeat(850) }), now);
  })();
  const measurements = implementations.map(implementation => ({ ...implementation, snapshot: [], titles: [], notifications: 0, snapshotBytes: 0 }));
  for (let sample = -1; sample < 10; sample++) {
    for (const measurement of sample % 2 === 0 ? measurements : [...measurements].reverse()) {
      const repo = new measurement.Workbench(app);
      const start = performance.now();
      const snapshot = repo.snapshot();
      const elapsed = performance.now() - start;
      measurement.snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot));
      if (sample >= 0) measurement.snapshot.push(elapsed);
      app.connection.prepare('update sessions set last_title = null').run();
      let listener;
      let notifications = 0;
      const reconciler = new measurement.Reconciler(app, null, null, null, { onFrame(fn) { listener = fn; return () => {}; } }, () => notifications++);
      const titlesStart = performance.now();
      for (let i = 0; i < 500; i++) listener({ type: 'terminal-lifecycle', processId: `pty_${i % 6}`, event: 'title', title: `${String.fromCharCode(0x2801 + Math.floor(i / 6) % 8)} Investigating` });
      if (sample >= 0) measurement.titles.push(performance.now() - titlesStart);
      measurement.notifications = notifications;
      reconciler.dispose();
    }
  }
  for (const measurement of measurements) results.push({ implementation: measurement.name, snapshotBytes: measurement.snapshotBytes, snapshot: summary(measurement.snapshot), titleBatch: summary(measurement.titles), notificationsPer500Titles: measurement.notifications });

  const db = history.connection;
  for (const count of [10_000, 100_000]) {
    db.transaction(() => {
      db.prepare('delete from conversation_history_fts').run();
      db.prepare('delete from conversation_history_rows').run();
      const insert = db.prepare("insert into conversation_history_fts (kind, owner_id, conversation_id, title, body) values ('conversation_message', ?, ?, 'Fixture', ?)");
      for (let i = 0; i < count; i++) insert.run(`message_${i}`, i < 100 ? 'target' : `conversation_${Math.floor(i / 100)}`, 'synthetic output '.repeat(16));
      db.prepare('insert into conversation_history_rows select rowid, conversation_id from conversation_history_fts').run();
    })();
    const samples = new Map(implementations.map(implementation => [implementation.name, []]));
    const rollback = new Error('roll back benchmark deletion');
    for (let sample = -1; sample < 10; sample++) {
      for (const implementation of sample % 2 === 0 ? implementations : [...implementations].reverse()) {
        let elapsed;
        try {
          db.transaction(() => {
            const search = new implementation.Search(history);
            const start = performance.now();
            search.removeConversation('target');
            elapsed = performance.now() - start;
            assert.equal(db.prepare('select count(*) as count from conversation_history_fts').get().count, count - 100);
            throw rollback;
          })();
        } catch (error) {
          if (error !== rollback) throw error;
        }
        if (sample >= 0) samples.get(implementation.name).push(elapsed);
      }
    }
    for (const [implementation, values] of samples) results.push({ implementation, searchRows: count, deletedRows: 100, deletion: summary(values) });
  }
  console.log(JSON.stringify({ reference, node: process.version, cpu: os.cpus()[0]?.model, boundary: 'Synthetic SQLite fixtures; ten alternating warmed samples after one warm-up. Snapshot excludes IPC/UI. Title batch includes SQLite updates but excludes snapshot refresh. Search deletion includes its nested transaction but excludes outer rollback. No live databases or GPU measurements.', results }, null, 2));
} finally {
  app.dispose();
  history.dispose();
  fs.rmSync(directory, { recursive: true, force: true });
}
