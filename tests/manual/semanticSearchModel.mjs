// Opt-in check of semantic history search with the real EmbeddingGemma 2
// model, through the same installer, worker process, and hybrid search the
// app uses. It touches no Patterm data: everything lives in a temp directory.
// Run: pnpm run build:main && node tests/manual/semanticSearchModel.mjs <path-to-embeddinggemma-2-Q8_0.gguf>
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);
const dist = path.resolve(import.meta.dirname, '../../dist/main/app');
const { DatabaseService } = require(`${dist}/Services/DatabaseService.js`);
const { HistoryDatabaseService } = require(`${dist}/Services/HistoryDatabaseService.js`);
const { SettingsService } = require(`${dist}/Services/SettingsService.js`);
const { AgentHistoryReadService } = require(`${dist}/Services/AgentHistory/AgentHistoryReadService.js`);
const { HistorySearchIndexService } = require(`${dist}/Services/AgentHistory/HistorySearchIndexService.js`);
const { EMBEDDING_MODEL } = require(`${dist}/Services/SemanticSearch/EmbeddingModel.js`);
const { EmbeddingModelInstaller } = require(`${dist}/Services/SemanticSearch/EmbeddingModelInstaller.js`);
const { SemanticSearchService } = require(`${dist}/Services/SemanticSearch/SemanticSearchService.js`);
const { HybridHistorySearchService } = require(`${dist}/Services/SemanticSearch/HybridHistorySearchService.js`);
const { launchNodeHistoryWorker } = require(`${dist}/Runtime/NodeHistoryWorker.js`);

const source = process.argv[2];
if (!source || !fs.existsSync(source)) {
  console.error('Usage: node tests/manual/semanticSearchModel.mjs <path-to-embeddinggemma-2-Q8_0.gguf>');
  process.exit(2);
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-semantic-model-'));
const app = new DatabaseService(directory);
const history = new HistoryDatabaseService(directory);
app.initialize();
history.initialize();

const conversations = {
  furnace: ['The deploy failed because the database migration locked the users table for twenty minutes.', 'We split the migration into batches and added a lock timeout.'],
  voice: ['Speech mode loses the thread when the call ends: what was only said to the realtime model is never written to the transcript.', 'I will persist the voice transcript into the assistant thread.'],
  fonts: ['The terminal renders blurry glyphs on fractional display scaling.', 'Snapping the glyph atlas to device pixels fixed the blur.'],
  billing: ['Invoices were emailed twice when the webhook retried.', 'Added an idempotency key to the invoice job.']
};
for (const [id, messages] of Object.entries(conversations)) {
  history.connection.prepare(`insert into conversations (id, provider, project_id, provider_conversation_id, title, status, created_at, imported_at, updated_at) values (?, 'codex', 'project_x', ?, ?, 'complete', 'now', 'now', ?)`).run(id, `native-${id}`, `Conversation ${id}`, new Date().toISOString());
  messages.forEach((text, seq) => history.connection.prepare(`insert into conversation_messages (id, conversation_id, seq, role, kind, text, created_at) values (?, ?, ?, ?, 'message', ?, 'now')`).run(`${id}-${seq}`, id, seq, seq ? 'assistant' : 'user', text));
}
history.connection.exec(`update history_embedding_queue set marked_at = '2000-01-01T00:00:00.000Z'`);
new HistorySearchIndexService(history).rebuildIndex();

// The installer hashes and installs the local file exactly as it would a download.
const localFetch = async () => new Response(Readable.toWeb(fs.createReadStream(source)), { headers: { 'content-length': String(fs.statSync(source).size) } });
const installer = new EmbeddingModelInstaller(directory, () => undefined, localFetch);
let started = performance.now();
installer.install();
await installer.settled();
assert.equal(installer.state().status, 'installed', JSON.stringify(installer.state()));
console.log(`installed and verified ${EMBEDDING_MODEL.fileName} in ${Math.round(performance.now() - started)} ms`);

const settings = new SettingsService(app);
const service = new SemanticSearchService({
  appDataPath: directory, settings, historyDatabase: history, installer, launchWorker: launchNodeHistoryWorker,
  workerPath: `${dist}/Services/SemanticSearch/EmbeddingWorker.js`, requestMigration: () => undefined, onChanged: () => undefined, threads: 2,
  debugLog: { write: (...args) => console.log('[semantic]', ...args) }
});
started = performance.now();
await service.setEnabled(true);
const deadline = Date.now() + 120_000;
while (service.state().index.state !== 'idle' || service.state().index.counts?.pending) {
  if (Date.now() > deadline) throw new Error(`index did not finish: ${JSON.stringify(service.state().index)}`);
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const counts = service.state().index.counts;
console.log(`indexed ${counts.indexed} conversations, ${counts.passages} passages in ${Math.round(performance.now() - started)} ms (includes model load)`);
const worker = workerMemory();
if (worker) console.log(`worker peak RSS ${worker} MB`);

const vectors = history.connection.prepare(`select vector from history_embedding_vectors`).all();
for (const { vector } of vectors) {
  const values = new Float32Array(new Uint8Array(vector).buffer);
  assert.equal(values.length, 512);
  assert.ok(values.every(Number.isFinite));
  const norm = Math.hypot(...values);
  assert.ok(Math.abs(norm - 1) < 1e-3, `stored vectors are unit length, got ${norm}`);
}

const hybrid = new HybridHistorySearchService(new AgentHistoryReadService(history), history, service);
const expectations = [
  ['voice chat history disappears after hanging up', 'voice'],
  ['schema change blocked a table during release', 'furnace'],
  ['text looks fuzzy on high dpi screens', 'fonts'],
  ['customers received duplicate bills', 'billing']
];
const latencies = [];
for (const [query, expected] of expectations) {
  const at = performance.now();
  const result = await hybrid.searchConversations({ query, project_id: 'project_x' });
  latencies.push(performance.now() - at);
  assert.equal(result.semantic, true);
  assert.equal(result.conversations[0]?.id, expected, `${query} → ${result.conversations.map((row) => row.id).join(', ')}`);
  console.log(`"${query}" → ${expected} (${Math.round(latencies.at(-1))} ms)`);
}
for (let index = 0; index < 10; index++) {
  const at = performance.now();
  assert.ok(await service.embedQuery(`warm query number ${index} about terminals`));
  latencies.push(performance.now() - at);
}
latencies.sort((a, b) => a - b);
console.log(`query p50 ${Math.round(latencies[Math.floor(latencies.length / 2)])} ms, max ${Math.round(latencies.at(-1))} ms`);

await service.setEnabled(false);
assert.equal(await service.embedQuery('anything'), null);
await service.dispose();
history.dispose();
app.dispose();
fs.rmSync(directory, { recursive: true, force: true });
console.log('real-model semantic search check passed');

// Linux only: the forked worker's high-water RSS.
function workerMemory() {
  if (process.platform !== 'linux') return null;
  try {
    const children = execFileSync('ps', ['-o', 'pid=', '--ppid', String(process.pid)], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
    // ps lists itself, and is gone by the time it is read.
    const peaks = children.map((pid) => fs.existsSync(`/proc/${pid}/status`) ? Number(/VmHWM:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0) : 0);
    return Math.round(Math.max(0, ...peaks) / 1024);
  } catch (error) {
    console.log('worker memory unavailable:', error.message);
    return null;
  }
}
