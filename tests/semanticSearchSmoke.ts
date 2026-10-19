import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../app/Services/DatabaseService';
import { HistoryDatabaseService } from '../app/Services/HistoryDatabaseService';
import { SettingsService } from '../app/Services/SettingsService';
import { AgentHistoryReadService } from '../app/Services/AgentHistory/AgentHistoryReadService';
import { HistorySearchIndexService } from '../app/Services/AgentHistory/HistorySearchIndexService';
import type { HistoryImportWorkerProcess } from '../app/Services/AgentHistory/AgentHistoryImportQueueService';
import { DOCUMENT_PROMPT, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL_KEY, prepareVector, QUERY_PROMPT } from '../app/Services/SemanticSearch/EmbeddingModel';
import { EmbeddingModelInstaller } from '../app/Services/SemanticSearch/EmbeddingModelInstaller';
import { EmbeddingWorkerRuntime, type QueryEmbedder } from '../app/Services/SemanticSearch/EmbeddingWorker';
import type { EmbeddingWorkerRequest } from '../app/Services/SemanticSearch/EmbeddingWorkerProtocol';
import { HistoryEmbeddingIndexer, type DocumentEmbedder } from '../app/Services/SemanticSearch/HistoryEmbeddingIndexer';
import { messagePassages } from '../app/Services/SemanticSearch/HistoryPassages';
import { HybridHistorySearchService } from '../app/Services/SemanticSearch/HybridHistorySearchService';
import { SemanticSearchService } from '../app/Services/SemanticSearch/SemanticSearchService';

// A deterministic stand-in for the model: a bag of hashed words. It is only
// for exercising the queue, publishing, and fusion; the real model is
// checked by tests/manual/semanticSearchModel.mjs.
function fakeVector(text: string): Float32Array {
  const words = text.replace(QUERY_PROMPT, '').replace(DOCUMENT_PROMPT, '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const raw = new Float32Array(EMBEDDING_DIMENSIONS);
  for (const word of words) raw[createHash('sha256').update(word).digest()[0]! % EMBEDDING_DIMENSIONS]! += 1;
  return prepareVector(raw) ?? new Float32Array(EMBEDDING_DIMENSIONS);
}

class FakeEmbedder implements QueryEmbedder {
  embedded: string[] = [];
  loaded = false;
  failNext = false;
  beforeEmbed: (() => void) | null = null;
  async load() { this.loaded = true; }
  async dispose() { this.loaded = false; }
  async embedQuery(text: string) { return fakeVector(QUERY_PROMPT + text); }
  async embedDocuments(texts: string[]) {
    this.beforeEmbed?.();
    this.beforeEmbed = null;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('inference exploded');
    }
    this.embedded.push(...texts);
    return texts.map(fakeVector);
  }
}

const later = () => Date.now() + 60_000;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-semantic-'));
const app = new DatabaseService(directory);
const history = new HistoryDatabaseService(directory);

function addConversation(id: string, projectId: string, messages: string[], extra: { provider?: string; sessionId?: string } = {}) {
  history.connection.prepare(`insert into conversations (id, provider, project_id, session_id, provider_conversation_id, title, status, created_at, imported_at, updated_at)
    values (?, ?, ?, ?, ?, ?, 'complete', 'now', ?, ?)`).run(id, extra.provider ?? 'codex', projectId, extra.sessionId ?? null, `native-${id}`, `Conversation ${id}`, new Date().toISOString(), new Date().toISOString());
  messages.forEach((text, seq) => addMessage(id, seq, text));
}
function addMessage(conversationId: string, seq: number, text: string, role = seq % 2 ? 'assistant' : 'user'): string {
  const id = randomUUID();
  history.connection.prepare(`insert into conversation_messages (id, conversation_id, seq, role, kind, text, created_at) values (?, ?, ?, ?, 'message', ?, 'now')`).run(id, conversationId, seq, role, text);
  return id;
}
const queueRow = (id: string) => history.connection.prepare(`select generation, attempts, last_error from history_embedding_queue where conversation_id = ?`).get(id) as { generation: number; attempts: number; last_error: string | null } | undefined;
const passageRows = (id: string) => history.connection.prepare(`select message_id, content_hash from history_embedding_passages where conversation_id = ? order by seq, chunk`).all(id) as Array<{ message_id: string; content_hash: string }>;
const settle = () => history.connection.exec(`update history_embedding_queue set marked_at = '2000-01-01T00:00:00.000Z'`);

async function waitFor(check: () => boolean, label: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function main() {
  app.initialize();
  history.initialize();

  // Passage splitting is bounded and content-addressed.
  const long = messagePassages({ id: 'm', seq: 0, text: `${'Sentence about terminals. '.repeat(400)}` });
  assert.equal(long.length, 2);
  assert.ok(long.every((passage) => passage.text.length <= 1_200));
  assert.equal(messagePassages({ id: 'a', seq: 0, text: 'same   words here ok' })[0]!.contentHash, messagePassages({ id: 'b', seq: 9, text: 'same words here ok' })[0]!.contentHash);
  assert.deepEqual(messagePassages({ id: 'm', seq: 0, text: 'tiny' }), []);
  assert.equal(prepareVector([Number.NaN, ...new Array(EMBEDDING_DIMENSIONS).fill(1)]), null);
  assert.equal(prepareVector(new Array(EMBEDDING_DIMENSIONS).fill(0)), null);

  // Imports mark conversations dirty through triggers in their own write.
  addConversation('alpha', 'project_a', ['The cobalt furnace overheated during the night shift', 'We replaced the thermostat and it held steady']);
  addConversation('beta', 'project_a', ['Discussed release notes for the spring launch', 'Drafted the changelog entries']);
  addConversation('gamma', 'project_b', ['The cobalt furnace overheated again in another project']);
  assert.ok(queueRow('alpha')!.generation >= 2, 'each message write bumps the generation');

  const embedder = new FakeEmbedder();
  const indexer = new HistoryEmbeddingIndexer(history.connection, embedder, EMBEDDING_MODEL_KEY, later);
  assert.equal(await new HistoryEmbeddingIndexer(history.connection, embedder, EMBEDDING_MODEL_KEY).step(), 'waiting', 'fresh writes settle before they are read');

  // An import that is still running holds embedding back.
  history.connection.prepare(`insert into conversation_import_batches (id, trigger, started_at, status) values ('batch', 'watch', ?, 'running')`).run(new Date().toISOString());
  assert.equal(await indexer.step(), 'waiting');
  history.connection.exec(`update conversation_import_batches set status = 'completed'`);

  while ((await indexer.step()) === 'indexed');
  assert.equal(indexer.counts().indexed, 3);
  assert.equal(indexer.counts().pending, 0);
  assert.equal(passageRows('alpha').length, 2);
  const embeddedAfterBackfill = embedder.embedded.length;

  // A reimport recreates message rows with new IDs. Vectors are reused by
  // content hash and passages follow the new rows for navigation.
  const oldIds = passageRows('alpha').map((row) => row.message_id);
  history.connection.exec(`delete from conversation_messages where conversation_id = 'alpha'`);
  assert.equal(passageRows('alpha').length, 0, 'deleted messages take their passages with them');
  addMessage('alpha', 0, 'The cobalt furnace overheated during the night shift');
  addMessage('alpha', 1, 'We replaced the thermostat and it held steady');
  assert.equal(await indexer.step(), 'indexed');
  assert.equal(embedder.embedded.length, embeddedAfterBackfill, 'unchanged passages are not embedded again');
  const newIds = passageRows('alpha').map((row) => row.message_id);
  assert.equal(newIds.length, 2);
  assert.ok(newIds.every((id) => !oldIds.includes(id)));

  // A write during inference makes the job stale; it is not published and
  // the newer generation is indexed next.
  addMessage('beta', 2, 'Added a section about the migration guide');
  embedder.beforeEmbed = () => addMessage('beta', 3, 'And a late note about deprecations');
  assert.equal(await indexer.step(), 'stale');
  assert.equal(passageRows('beta').length, 2, 'the stale job left the published passages alone');
  assert.equal(await indexer.step(), 'indexed');
  assert.equal(passageRows('beta').length, 4);

  // Inference failures back off without blocking other conversations.
  addMessage('beta', 4, 'One more line that will fail to embed at first');
  addMessage('gamma', 1, 'Another furnace inspection note');
  embedder.failNext = true;
  assert.equal(await indexer.step(), 'failed');
  const failedId = ['beta', 'gamma'].find((id) => queueRow(id)?.attempts === 1)!;
  assert.match(queueRow(failedId)!.last_error!, /inference exploded/);
  assert.equal(await indexer.step(), 'indexed', 'the other conversation is not blocked');
  assert.equal(indexer.counts().failed, 1);
  assert.equal(await indexer.step(), 'waiting', 'the failed conversation waits for its retry time');
  history.connection.prepare(`update history_embedding_queue set retry_after = null`).run();
  assert.equal(await indexer.step(), 'indexed');

  // Deleting a conversation removes its passages and its queue entry.
  addConversation('doomed', 'project_a', ['Temporary conversation to delete']);
  while ((await indexer.step()) === 'indexed');
  history.connection.exec(`delete from conversations where id = 'doomed'`);
  assert.equal(passageRows('doomed').length, 0);
  assert.equal(await indexer.step(), 'removed');
  assert.equal(queueRow('doomed'), undefined);
  assert.ok(indexer.collectGarbage() >= 1, 'vectors no passage uses are collected once the queue is empty');

  // Hybrid search: keyword results stay, semantic results join them, and
  // every result stays inside the requested project.
  new HistorySearchIndexService(history).rebuildIndex();
  const read = new AgentHistoryReadService(history);
  const semantic = { active: true, embedQuery: async (text: string) => fakeVector(QUERY_PROMPT + text) };
  const hybrid = new HybridHistorySearchService(read, history, semantic);
  assert.equal(read.searchConversations({ query: 'cobalt furnace overheated during night shift broke', project_id: 'project_a' }).conversations.length, 0, 'every keyword must match');
  const found = await hybrid.searchConversations({ query: 'cobalt furnace overheated during night shift broke', project_id: 'project_a' });
  assert.equal(found.semantic, true);
  assert.deepEqual(found.conversations.map((row) => row.id), ['alpha']);
  const match = found.conversations[0]!.match as { messageId: string; preview: string; semantic?: boolean };
  assert.equal(match.semantic, true);
  assert.ok(newIds.includes(match.messageId), 'semantic matches navigate to a live message');
  assert.match(match.preview, /cobalt furnace/);
  assert.deepEqual((await hybrid.searchConversations({ query: 'cobalt furnace overheated during night shift broke', project_id: 'project_a', provider: 'claude' })).conversations, []);
  const messages = await hybrid.search({ query: 'cobalt furnace overheated during night shift broke', project_id: 'project_a' });
  assert.equal(messages.results[0]?.messageId, match.messageId);
  assert.equal(messages.results[0]?.match, 'semantic');
  const both = await hybrid.search({ query: 'thermostat', project_id: 'project_a' });
  assert.equal(both.results[0]?.conversationId, 'alpha');

  // A project move takes effect at once, even with a cached matrix.
  history.connection.exec(`update conversations set project_id = 'project_b' where id = 'alpha'`);
  assert.deepEqual((await hybrid.searchConversations({ query: 'cobalt furnace overheated during night shift broke', project_id: 'project_a' })).conversations, []);
  assert.deepEqual((await hybrid.searchConversations({ query: 'cobalt furnace overheated during night shift broke', project_id: 'project_b' })).conversations.map((row) => row.id), ['alpha']);
  history.connection.exec(`update conversations set project_id = 'project_a' where id = 'alpha'`);

  // Resumable searches hide sub-agent conversations semantically too.
  addConversation('child', 'project_a', ['The cobalt furnace overheated during the night shift'], { sessionId: 'session_child' });
  while ((await indexer.step()) === 'indexed');
  const resumable = await hybrid.searchConversations({ query: 'cobalt furnace overheated during night shift broke', project_id: 'project_a', resumable: true }, [{ id: 'session_child', role: 'child', exitedAt: null }]);
  assert.deepEqual(resumable.conversations.map((row) => row.id), ['alpha']);

  // Keyword fallback when semantic search is off or cannot answer.
  const off = new HybridHistorySearchService(read, history, { active: false, embedQuery: async () => { throw new Error('must not be called'); } });
  assert.deepEqual(await off.searchConversations({ query: 'thermostat', project_id: 'project_a' }), { ...read.searchConversations({ query: 'thermostat', project_id: 'project_a' }), semantic: false });
  const failing = new HybridHistorySearchService(read, history, { active: true, embedQuery: async () => null });
  assert.equal((await failing.search({ query: 'thermostat', project_id: 'project_a' })).semantic, false);

  // A model or chunker change drops incompatible vectors and queues everything.
  const other = new HistoryEmbeddingIndexer(history.connection, embedder, 'other-model-key', later);
  assert.equal(other.reconcile().queued, 4);
  assert.equal(other.counts().passages, 0);
  history.connection.exec(`delete from history_embedding_queue`);

  await installerChecks();
  await serviceChecks();
  console.log('semantic search smoke ok');
}

async function installerChecks() {
  const body = Buffer.from('pretend gguf weights');
  const manifest = { id: 'test-model', fileName: 'model.gguf', url: 'https://example.invalid/model.gguf', bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') };
  const respond = (bytes: Buffer) => async () => new Response(new Uint8Array(bytes), { headers: { 'content-length': String(bytes.length) } });
  const root = path.join(directory, 'installer');

  const bad = new EmbeddingModelInstaller(root, () => undefined, respond(Buffer.from('tampered gguf weights')) as typeof fetch, { ...manifest, bytes: 21 });
  bad.install();
  await bad.settled();
  assert.equal(bad.state().status, 'error');
  assert.match((bad.state() as { error: string }).error, /SHA-256/);
  assert.deepEqual(fs.readdirSync(bad.directory), [], 'a failed download leaves no partial or model file');

  const short = new EmbeddingModelInstaller(root, () => undefined, respond(body.subarray(0, 5)) as typeof fetch, manifest);
  short.install();
  await short.settled();
  assert.equal(short.state().status, 'error');

  const hanging = (async (_url: string, init?: RequestInit) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(body.subarray(0, 4)));
      init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
    }
  }))) as unknown as typeof fetch;
  const cancelled = new EmbeddingModelInstaller(root, () => undefined, hanging, manifest);
  cancelled.install();
  await new Promise((resolve) => setTimeout(resolve, 20));
  cancelled.cancel();
  await cancelled.settled();
  assert.equal(cancelled.state().status, 'absent');
  assert.equal(fs.existsSync(cancelled.modelPath), false);

  const good = new EmbeddingModelInstaller(root, () => undefined, respond(body) as typeof fetch, manifest);
  good.install();
  await good.settled();
  assert.equal(good.state().status, 'installed');
  assert.equal(new EmbeddingModelInstaller(root, () => undefined, respond(body) as typeof fetch, manifest).installed, true, 'installation survives a restart');
  fs.truncateSync(good.modelPath, 3);
  assert.equal(new EmbeddingModelInstaller(root, () => undefined, respond(body) as typeof fetch, manifest).installed, false, 'a damaged file is not trusted');
  await good.remove();
  assert.equal(fs.existsSync(good.directory), false);
}

// The service drives an in-process worker runtime through the same message
// protocol as the utility process or child process.
async function serviceChecks() {
  const settings = new SettingsService(app);
  const embedder = new FakeEmbedder();
  let launches = 0;
  const launchWorker = () => {
    launches++;
    const worker = new EventEmitter() as HistoryImportWorkerProcess;
    const runtime = new EmbeddingWorkerRuntime((event) => setImmediate(() => worker.emit('message', event)), () => setImmediate(() => worker.emit('exit', 0)), () => embedder);
    worker.postMessage = (message: unknown) => setImmediate(() => runtime.handle(message as EmbeddingWorkerRequest));
    worker.kill = () => worker.emit('exit', null);
    return worker;
  };
  const body = Buffer.from('pretend gguf weights');
  const installer = new EmbeddingModelInstaller(directory, () => undefined, (async () => new Response(new Uint8Array(body))) as unknown as typeof fetch,
    { id: 'test-model', fileName: 'model.gguf', url: 'https://example.invalid/model.gguf', bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') });
  let migrations = 0;
  const service = new SemanticSearchService({ appDataPath: directory, settings, historyDatabase: history, launchWorker, installer, requestMigration: () => { migrations++; }, onChanged: () => undefined, threads: 1, debugLog: { write: (...args: unknown[]) => { if (process.env.SEMANTIC_DEBUG) console.log(...args); } } });

  assert.equal(settings.semanticSearchSettings().enabled, false, 'off by default');
  await assert.rejects(service.setEnabled(true), /Install the embedding model/);
  service.start();
  assert.equal(launches, 0);
  service.installModel();
  await installer.settled();
  assert.equal(service.state().model.install.status, 'installed');
  assert.equal(service.state().enabled, false, 'installing does not turn search on');
  assert.equal(launches, 0);

  settle();
  await service.setEnabled(true);
  await waitFor(() => service.state().index.state === 'idle', 'backfill to finish');
  assert.equal(service.state().index.counts?.pending, 0);
  assert.ok(await service.embedQuery('cobalt furnace'));
  assert.equal(migrations, 0);

  // Disabling stops the worker and queries but keeps model and index.
  await service.setEnabled(false);
  assert.equal(service.state().index.state, 'off');
  assert.equal(await service.embedQuery('cobalt furnace'), null);
  assert.equal(service.state().model.install.status, 'installed');
  const indexed = service.state().index.counts!.indexed;
  assert.ok(indexed > 0);

  // History imported while disabled is caught up on re-enable.
  addConversation('while-off', 'project_a', ['Imported while semantic search was off']);
  settle();
  await service.setEnabled(true);
  await waitFor(() => service.state().index.state === 'idle' && service.state().index.counts?.indexed === indexed + 1, 'catch-up after re-enable');
  assert.ok(embedder.embedded.some((text) => text.includes('Imported while semantic search was off')));

  // A rebuild re-embeds everything from stored history.
  const before = embedder.embedded.length;
  await service.rebuild();
  settle();
  service.historyChanged();
  await waitFor(() => service.state().index.state === 'idle' && service.state().index.counts?.pending === 0 && embedder.embedded.length > before, 'rebuild');

  // Removing the model turns search off and clears the index.
  await service.removeModel();
  assert.equal(service.state().enabled, false);
  assert.equal(service.state().model.install.status, 'absent');
  assert.equal(service.state().index.counts?.passages, 0);
  assert.equal(service.state().index.counts?.indexed, 0);
  await service.dispose();
}

main().finally(() => {
  history.dispose();
  app.dispose();
  fs.rmSync(directory, { recursive: true, force: true });
}).catch((error) => {
  console.error(error);
  // A failed check can leave the in-process worker polling.
  process.exit(1);
});
