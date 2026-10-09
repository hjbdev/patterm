// Opt-in native CLI probe: no live model, Patterm database, or service involved.
// Run: node tests/manual/codexMemoryVisibility.mjs [path-to-codex]
// Offline: node tests/manual/codexMemoryVisibility.mjs --verify <results.json>
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';

const executable = process.argv[2] ?? 'codex';
const markers = ['PATTERM_MEMORY_A_813af0', 'PATTERM_MEMORY_B_915bc2', 'PATTERM_CONTEXT_C_c801a3', 'PATTERM_CONTEXT_D_82adf1'];
if (process.argv[2] === '--verify') {
  verify(JSON.parse(fs.readFileSync(process.argv[3], 'utf8')).observations);
  console.log('Captured visibility checks passed.');
  process.exit(0);
}
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-memory-visibility-'));
const requests = [];
let phase = '';
let providerKind = 'local';
let nextInputTokens = 100;
let serial = 0;
const midTurnCalls = new Set();

function verify(observations) {
  assert.equal(observations.length, 34, 'All visibility scenarios must be captured');
  for (const kind of ['local', 'remote']) {
    const inference = label => {
      const rows = observations.filter(row => row.phase === `${kind}:${label}` && !row.compaction);
      assert.equal(rows.length, 1, `${kind}:${label} must have one inference request`);
      return rows[0];
    };
    const assertMarkers = (row, expected) => {
      for (const [index, marker] of markers.entries()) {
        assert.deepEqual(row.markers[marker], expected.includes(index) ? ['developer'] : [], `${row.phase}: ${marker}`);
      }
    };
    assertMarkers(inference('fresh-A'), [0]);
    assertMarkers(inference('resume-B'), [0]);
    for (const label of ['after-manual-compaction', 'after-second-compaction', 'fresh-B']) assertMarkers(inference(label), [1]);
    assertMarkers(inference('additional-C'), [1, 2]);
    assertMarkers(inference('additional-D'), [1, 2, 3]);
    assertMarkers(inference('additional-unchanged'), [1, 2, 3]);
    assertMarkers(inference('auto-seed-A'), [0]);
    const automatic = observations.filter(row => row.phase === `${kind}:auto-resume-B`);
    assert.equal(automatic.length, 2, `${kind}: native pre-turn compaction followed by inference`);
    assert.equal(automatic[0].compaction, true);
    assert.equal(automatic[1].compaction, false);
    assertMarkers(automatic[0], [0]);
    assertMarkers(automatic[1], [1]);
    for (const [label, marker] of [['manual-compaction', 0], ['second-manual-compaction', 1]]) {
      const rows = observations.filter(row => row.phase === `${kind}:${label}`);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].compaction, true);
      assertMarkers(rows[0], [marker]);
    }
    const mid = observations.filter(row => row.phase === `${kind}:mid-resume-B`);
    assertMarkers(inference('mid-seed-A'), [0]);
    assert.equal(mid.length, 3, `${kind}: inference, native mid-turn compaction, then follow-up inference`);
    assert.deepEqual(mid.map(row => row.compaction), [false, true, false]);
    assertMarkers(mid[0], [0]);
    assertMarkers(mid[1], [0]);
    assertMarkers(mid[2], [1]);
  }
}

function countMarkers(body) {
  const messages = body.input ?? [];
  return Object.fromEntries(markers.map(marker => [marker, messages.filter(item =>
    item.type === 'message' && JSON.stringify(item.content).includes(marker)
  ).map(item => item.role)]));
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method !== 'POST') {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let bytes = Buffer.concat(chunks);
    if (request.headers['content-encoding'] === 'zstd') bytes = zlib.zstdDecompressSync(bytes);
    if (request.headers['content-encoding'] === 'gzip') bytes = zlib.gunzipSync(bytes);
    const body = JSON.parse(bytes.toString());
    const isCompaction = body.client_metadata?.['x-codex-turn-metadata']?.includes('compaction') ||
      request.headers['x-codex-turn-metadata']?.includes('compaction') ||
      JSON.stringify(body).includes('Summarize the conversation');
    requests.push({ phase, url: request.url, compaction: Boolean(isCompaction), markers: countMarkers(body) });
    const id = `probe_response_${++serial}`;
    let item = isCompaction && providerKind === 'remote'
      ? { type: 'compaction', encrypted_content: 'synthetic-compaction-fixture' }
      : { type: 'message', role: 'assistant', id: `probe_message_${serial}`, content: [{ type: 'output_text', text: 'Synthetic response; no memory markers retained.' }] };
    let tokens = nextInputTokens;
    nextInputTokens = 100;
    if (phase.endsWith(':mid-resume-B') && !isCompaction && !midTurnCalls.has(phase)) {
      midTurnCalls.add(phase);
      // A synthetic native plan update creates a follow-up without shell/MCP work.
      item = { type: 'function_call', name: 'update_plan', call_id: `probe_plan_${serial}`,
        arguments: JSON.stringify({ plan: [{ step: 'Synthetic visibility fixture', status: 'completed' }] }) };
      tokens = 20_000;
    }
    const events = [
      { type: 'response.created', response: { id } },
      { type: 'response.output_item.done', item },
      { type: 'response.completed', response: { id, usage: { input_tokens: tokens, output_tokens: 1, total_tokens: tokens + 1 } } }
    ];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  } catch (error) {
    response.writeHead(500).end(String(error));
  }
});
// This fixture is a local-only model endpoint, not a browser/dev server.
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const endpoint = `http://127.0.0.1:${server.address().port}/v1`;

class AppServer {
  constructor(kind, autoLimit = 100_000) {
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.stderr = '';
    const config = {
      model_provider: 'patterm_visibility_fixture',
      'model_providers.patterm_visibility_fixture.name': kind === 'remote' ? 'OpenAI' : 'Patterm local fixture',
      'model_providers.patterm_visibility_fixture.base_url': endpoint,
      'model_providers.patterm_visibility_fixture.wire_api': 'responses',
      'model_providers.patterm_visibility_fixture.requires_openai_auth': false,
      'model_providers.patterm_visibility_fixture.supports_websockets': false,
      'model_providers.patterm_visibility_fixture.request_max_retries': 0,
      'model_providers.patterm_visibility_fixture.stream_max_retries': 0,
      model_auto_compact_token_limit: autoLimit,
      model_auto_compact_token_limit_scope: 'total',
      sqlite_home: directory,
      log_dir: directory,
      'features.plugins': false,
      'features.skills': false,
      'otel.exporter': 'none'
    };
    // Disable configured MCPs per launch without changing the user's settings.
    const configFile = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'config.toml');
    const text = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
    for (const match of text.matchAll(/^\[mcp_servers\.([^\]]+)\]$/gm)) config[`mcp_servers.${match[1]}.enabled`] = false;
    const args = Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]);
    this.child = spawn(executable, [...args, 'app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-8000); });
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== undefined && (message.result !== undefined || message.error)) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      } else if (message.id !== undefined) {
        // The fixture never executes or approves tools.
        this.child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'No tools in visibility probe' } }) + '\n');
      } else this.events.push(message);
    });
    this.child.on('exit', code => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`app-server exited ${code}: ${this.stderr}`));
      }
      this.pending.clear();
    });
  }

  async initialise() {
    await this.rpc('initialize', { clientInfo: { name: 'patterm_memory_visibility_probe', version: '1' }, capabilities: { experimentalApi: true } });
    this.child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  }

  rpc(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out: ${this.stderr}`)); }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  async operation(method, params) {
    console.error(`Probe ${phase}: ${method}`);
    const from = this.events.length;
    await this.rpc(method, params);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const completed = this.events.slice(from).find(event => event.method === 'turn/completed' && event.params.threadId === params.threadId);
      if (completed) {
        assert.equal(completed.params.turn.status, 'completed', JSON.stringify(completed.params.turn));
        const errors = this.events.slice(from).filter(event => event.method === 'error');
        assert.equal(errors.length, 0, JSON.stringify(errors));
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`${method} completion timed out: ${JSON.stringify(this.events.slice(from).slice(-5))}\n${this.stderr}`);
  }

  async stop() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.lines.close();
    this.child.stdin.end();
    const stopped = once(this.child, 'exit');
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    await stopped;
    clearTimeout(timer);
  }
}

function threadParams(marker) {
  return { model: 'gpt-6.1-sol', cwd: directory, approvalPolicy: 'never', sandbox: 'read-only',
    baseInstructions: 'Synthetic context visibility probe. Never call tools.', developerInstructions: marker };
}

async function probe(kind) {
  providerKind = kind;
  let client = new AppServer(kind);
  const threads = [];
  try {
    await client.initialise();
    phase = `${kind}:fresh-A`;
    const fresh = await client.rpc('thread/start', { ...threadParams(markers[0]), ephemeral: false });
    const id = fresh.thread.id;
    threads.push(id);
    await client.operation('turn/start', { threadId: id, input: [{ type: 'text', text: 'First probe turn.' }] });
    await client.stop();

    client = new AppServer(kind);
    await client.initialise();
    phase = `${kind}:resume-B`;
    await client.rpc('thread/resume', { ...threadParams(markers[1]), threadId: id, excludeTurns: true });
    await client.operation('turn/start', { threadId: id, input: [{ type: 'text', text: 'Probe after process restart and resume.' }] });

    phase = `${kind}:manual-compaction`;
    await client.operation('thread/compact/start', { threadId: id });
    phase = `${kind}:after-manual-compaction`;
    await client.operation('turn/start', { threadId: id, input: [{ type: 'text', text: 'Probe after compaction.' }] });
    phase = `${kind}:second-manual-compaction`;
    await client.operation('thread/compact/start', { threadId: id });
    phase = `${kind}:after-second-compaction`;
    await client.operation('turn/start', { threadId: id, input: [{ type: 'text', text: 'Probe after another compaction.' }] });

    phase = `${kind}:fresh-B`;
    const newer = await client.rpc('thread/start', { ...threadParams(markers[1]), ephemeral: false });
    threads.push(newer.thread.id);
    await client.operation('turn/start', { threadId: newer.thread.id, input: [{ type: 'text', text: 'Fresh conversation probe.' }] });

    // Experimental keyed context is a candidate alternative to launch instructions.
    phase = `${kind}:additional-C`;
    await client.operation('turn/start', { threadId: newer.thread.id, input: [{ type: 'text', text: 'Additional context probe.' }],
      additionalContext: { memory: { value: markers[2], kind: 'application' } } });
    phase = `${kind}:additional-D`;
    await client.operation('turn/start', { threadId: newer.thread.id, input: [{ type: 'text', text: 'Changed additional context probe.' }],
      additionalContext: { memory: { value: markers[3], kind: 'application' } } });
    phase = `${kind}:additional-unchanged`;
    await client.operation('turn/start', { threadId: newer.thread.id, input: [{ type: 'text', text: 'Unchanged additional context probe.' }],
      additionalContext: { memory: { value: markers[3], kind: 'application' } } });
  } finally {
    for (const id of threads) {
      try { await client.rpc('thread/delete', { threadId: id }); }
      catch (error) { console.error(`Probe thread ${id} cleanup: ${error.message}`); }
    }
    await client.stop();
  }
}

async function probeAutomatic(kind) {
  providerKind = kind;
  let client = new AppServer(kind, 10_000);
  let id;
  try {
    await client.initialise();
    phase = `${kind}:auto-seed-A`;
    const thread = await client.rpc('thread/start', { ...threadParams(markers[0]), ephemeral: false });
    id = thread.thread.id;
    nextInputTokens = 20_000; // Fixture usage forces native pre-turn compaction.
    await client.operation('turn/start', { threadId: id, input: [{ type: 'text', text: 'Seed a context over the fixture threshold.' }] });
    await client.stop();
    client = new AppServer(kind, 10_000);
    await client.initialise();
    phase = `${kind}:auto-resume-B`;
    await client.rpc('thread/resume', { ...threadParams(markers[1]), threadId: id, excludeTurns: true });
    await client.operation('turn/start', { threadId: id, input: [{ type: 'text', text: 'Probe automatic compaction after resuming.' }] });
    assert.ok(requests.some(request => request.phase === phase && request.compaction), 'Native automatic compaction must actually run');
  } finally {
    if (id) await client.rpc('thread/delete', { threadId: id });
    await client.stop();
  }
}

async function probeMidTurn(kind) {
  providerKind = kind;
  let client = new AppServer(kind, 10_000);
  let id;
  try {
    await client.initialise();
    phase = `${kind}:mid-seed-A`;
    const thread = await client.rpc('thread/start', { ...threadParams(markers[0]), ephemeral: false });
    id = thread.thread.id;
    await client.operation('turn/start', { threadId: id, input: [{ type: 'text', text: 'Seed the mid-turn compaction fixture.' }] });
    await client.stop();
    client = new AppServer(kind, 10_000);
    await client.initialise();
    phase = `${kind}:mid-resume-B`;
    await client.rpc('thread/resume', { ...threadParams(markers[1]), threadId: id, excludeTurns: true });
    await client.operation('turn/start', { threadId: id, input: [{ type: 'text', text: 'Probe mid-turn compaction and follow-up inference.' }] });
  } finally {
    if (id) await client.rpc('thread/delete', { threadId: id });
    await client.stop();
  }
}

try {
  await probe('local');
  await probe('remote');
  await probeAutomatic('local');
  await probeAutomatic('remote');
  await probeMidTurn('local');
  await probeMidTurn('remote');
  verify(requests);
  console.log(JSON.stringify({ cli: spawnSync(executable, ['--version'], { encoding: 'utf8' }).stdout.trim(), observations: requests }, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(directory, { recursive: true, force: true });
}
