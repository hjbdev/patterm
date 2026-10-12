import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { IntegratedAgentService } from '../app/Services/IntegratedAgentService';
import { DatabaseService } from '../app/Services/DatabaseService';
import { ClaudeStreamService } from '../app/Services/ClaudeStreamService';
import { applyConversationStreamEvent, normaliseMessages } from '../resources/js/lib/integratedConversation';
import type { IntegratedConversationEvent } from '../app/Services/IntegratedConversation';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Fixture {
  service: ClaudeStreamService;
  events: IntegratedConversationEvent[];
  connections: () => number;
  drop: () => void;
  append: (delta: string) => void;
  release: () => void;
  stopListening: () => Promise<void>;
  listen: () => Promise<void>;
  close: () => Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-claude-reconnect-'));
  const socketPath = path.join(directory, 'host.sock');
  const sockets = new Set<net.Socket>();
  const subscribers = new Set<net.Socket>();
  let connections = 0;
  let revision = 0;
  let text = 'Hello';
  const publish = (event: Record<string, unknown>): void => {
    revision += 1;
    for (const socket of subscribers) socket.write(`${JSON.stringify({ event: { ...event, revision } })}\n`);
  };
  const server = net.createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => { sockets.delete(socket); subscribers.delete(socket); });
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const request = JSON.parse(buffer.slice(0, end)) as { id?: unknown; method?: string };
        buffer = buffer.slice(end + 1);
        if (request.method === 'subscribe') {
          subscribers.add(socket);
          socket.write(`${JSON.stringify({ id: request.id, result: { revision } })}\n`);
          publish({ kind: 'pending' });
        } else {
          socket.write(`${JSON.stringify({ id: request.id, result: { revision, status: 'working', messages: { data: [{ id: 'message-1', role: 'assistant', kind: 'text', text }] }, questions: { data: [] }, permissions: { data: [] } } })}\n`);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const database = new DatabaseService(directory);
  database.initialize();
  const now = new Date().toISOString();
  database.connection.prepare('insert into projects (id,name,path,created_at,updated_at) values (?,?,?,?,?)').run('project_test', 'Synthetic review', directory, now, now);
  database.connection.prepare("insert into processes(id,project_id,kind,name,status,activity,cwd,argv,created_at,updated_at) values('process_test','project_test','agent','Synthetic','running','working',?,?,?,?)")
    .run(directory, JSON.stringify(['/unused-claude', 'claude-host', socketPath]), now, now);
  database.connection.prepare("insert into sessions(id,project_id,process_id,harness,interface_mode,resume_id,started_at,session_role,resume_status,created_by_actor) values('session_test','project_test','process_test','claude','integrated','native_test',?,'orchestrator','found','user')")
    .run(now);
  const service = new ClaudeStreamService(database, directory, process.execPath);
  const events: IntegratedConversationEvent[] = [];
  const release = await service.subscribe('process_test', (event) => events.push(event));
  await delay(20);
  return {
    service,
    events,
    connections: () => connections,
    drop: () => { for (const socket of sockets) socket.destroy(); },
    append: (delta) => { text += delta; publish({ kind: 'append', id: 'message-1', delta }); },
    release,
    stopListening: () => new Promise((resolve) => server.close(() => resolve())),
    listen: () => new Promise((resolve) => server.listen(socketPath, () => resolve())),
    close: async () => {
      release();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      database.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

async function verifyPromptDelivery(): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-claude-delivery-'));
  const socketPath = path.join(directory, 'host.sock');
  const database = new DatabaseService(directory);
  const sockets = new Set<net.Socket>();
  let mode: 'timeout' | 'close' | 'malformed' | 'reject' = 'timeout';
  let prompts = 0;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer.split('\n')[0]!) as { id: string; method: string };
      if (request.method === 'prompt') {
        prompts++;
        if (mode === 'timeout') return; // Accepted prompt, withheld acknowledgement.
        if (mode === 'close') { socket.end(); return; }
        if (mode === 'malformed') { socket.end('{invalid\n'); return; }
        socket.end(`${JSON.stringify({ id: request.id, error: 'native rejection' })}\n`);
      } else {
        assert.equal(request.method, 'delivery');
        socket.end(`${JSON.stringify({ id: request.id, result: { state: 'unknown' } })}\n`);
      }
    });
  });
  let integrated: IntegratedAgentService | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    database.initialize();
    const now = new Date().toISOString();
    database.connection.prepare('insert into projects (id,name,path,created_at,updated_at) values (?,?,?,?,?)').run('project', 'Delivery', directory, now, now);
    database.connection.prepare(`insert into processes (id,project_id,kind,name,status,activity,cwd,argv,created_at,updated_at)
      values ('process','project','agent','Test','running','idle',?,?,?,?)`).run(directory, JSON.stringify(['/unused', 'claude-host', socketPath]), now, now);
    database.connection.prepare(`insert into sessions (id,project_id,process_id,harness,interface_mode,resume_id,started_at,session_role,resume_status)
      values ('session','project','process','claude','integrated','native',?,'orchestrator','found')`).run(now);
    const claude = new ClaudeStreamService(database, directory, process.execPath);
    integrated = new IntegratedAgentService(database, { claude });
    const ledger = (id: string) => database.connection.prepare('select state from integrated_submissions where process_id = ? and message_id = ?').get('process', id) as { state: string } | undefined;
    for (const failure of ['timeout', 'close', 'malformed'] as const) {
      mode = failure;
      const prompt = { text: `Lost ${failure} reply`, messageId: failure };
      const before = prompts;
      assert.equal((await integrated.prompt('process', prompt) as { delivery: string }).delivery, 'uncertain');
      assert.equal(ledger(failure)?.state, 'uncertain', `${failure} keeps the submission reservation`);
      assert.equal((await integrated.prompt('process', prompt) as { delivery: string }).delivery, 'uncertain');
      assert.equal(prompts, before + 1, `${failure} never resends the same message ID`);
    }
    mode = 'reject';
    await assert.rejects(integrated.prompt('process', { text: 'Rejected', messageId: 'reject' }), /native rejection/);
    assert.equal(ledger('reject'), undefined, 'an explicit host rejection remains definitive');
  } finally {
    integrated?.dispose();
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    database.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await verifyPromptDelivery();
  // A reconnect attempt that fails before acknowledgement must keep the bounded
  // recovery alive until the host returns.
  const returning = await fixture();
  try {
    returning.drop();
    await returning.stopListening();
    await delay(500); // The first retry reaches an unavailable socket.
    await returning.listen();
    await delay(1_200);
    assert.ok(returning.connections() >= 2, `expected a reconnect after the first retry failed, saw ${returning.connections()}`);
    assert.ok(returning.events.some((event) => event.kind === 'reconnecting'), 'the drop is announced');
    assert.ok(returning.events.some((event) => event.kind === 'pending' && event.revision > 0), 'the reconnected host hands back a fresh boundary');
    // Releasing the subscription cancels any further recovery.
    const before = returning.connections();
    returning.release();
    await delay(400);
    assert.equal(returning.connections(), before, 'release cancels the retry loop');
    await returning.close();
  } catch (error) {
    await returning.close().catch(() => {});
    throw error;
  }

  // A snapshot taken after a reconnect already contains the appended text; the
  // forwarded append shares the same native revision, so it is not replayed.
  const boundary = await fixture();
  try {
    boundary.drop();
    await delay(400);
    boundary.append(' B');
    await delay(30);
    const snapshot = await boundary.service.conversation('process_test') as { revision: number; messages: { data: Array<Record<string, unknown>> } };
    const delta = boundary.events.filter((event) => event.kind === 'append').at(-1)!;
    let rows = normaliseMessages(snapshot.messages.data);
    if (delta.revision > snapshot.revision) rows = applyConversationStreamEvent(rows, delta);
    assert.equal(snapshot.messages.data[0]?.text, 'Hello B', 'the snapshot contains the append');
    assert.equal(delta.revision, snapshot.revision, 'the forwarded append shares the snapshot revision');
    assert.equal(rows[0]?.text, 'Hello B', 'the buffered append is not replayed onto a snapshot that already contains it');
  } finally {
    await boundary.close();
  }
  console.log('claude reconnect smoke ok');
}

void main();
