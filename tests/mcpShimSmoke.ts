import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { buildSync } from 'esbuild';

const descriptors: Array<{ name: string; namespace: string; description: string; inputSchema: Record<string, unknown>; changes?: string[] }> = [
  { name: 'whoami', namespace: 'cli.meta', description: 'Return caller identity.', inputSchema: { type: 'object', additionalProperties: false } },
  { name: 'spawn_process', namespace: 'cli.process', description: 'Start a process.', inputSchema: { type: 'object', properties: { argv: { type: 'array', items: { type: 'string' } } } } },
  { name: 'todo.create', namespace: 'todo', description: 'Create a todo.', inputSchema: { type: 'object', properties: { title: { type: 'string', minLength: 1 } }, required: ['title'] } },
  { name: 'help', namespace: 'meta', description: 'Describe a tool.', inputSchema: { type: 'object', properties: { tool: { type: 'string' } }, required: ['tool'] } }
];

async function main(): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-shim-'));
  const socketPath = path.join(directory, 'mcp.sock');
  const executable = path.join(directory, 'shim.cjs');
  let catalogue = descriptors;
  const calls: Array<{ tool: string; args: unknown; version: number }> = [];
  const sockets = new Set<net.Socket>();
  const opened: Array<{ url: string; identity: string }> = [];
  let receiveInterrupted!: (socket: net.Socket) => void;
  const received = new Promise<net.Socket>((resolve) => { receiveInterrupted = resolve; });
  const registry = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    // A shim that exits mid catalogue refresh resets its connection.
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer.split('\n')[0]!) as { op?: string; tool?: string; args?: unknown; version: number; url?: string; identity?: string };
      assert.equal(request.version, 2, 'new shims identify direct public requests');
      if (request.op === 'catalog') socket.end(`${JSON.stringify({ result: catalogue })}\n`);
      else if (request.op === 'open-url') {
        opened.push({ url: request.url!, identity: request.identity! });
        socket.end(`${JSON.stringify(request.url!.startsWith('file:') ? { error: 'Patterm does not open file: links' } : { result: { opened: true } })}\n`);
      }
      else {
        calls.push({ tool: request.tool!, args: request.args, version: request.version });
        if (request.tool === 'spawn_process') receiveInterrupted(socket);
        else socket.end(`${JSON.stringify({ result: { connected: true, tool: request.tool, args: request.args } })}\n`);
      }
    });
  });
  const listen = () => new Promise<void>((resolve, reject) => {
    registry.once('error', reject);
    registry.listen(socketPath, () => { registry.off('error', reject); resolve(); });
  });
  const close = () => new Promise<void>((resolve, reject) => {
    for (const socket of sockets) socket.destroy();
    registry.close((error) => error ? reject(error) : resolve());
  });

  const modern = new Client({ name: 'shim-modern-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  const modernTransport = new StdioClientTransport({ command: process.execPath, args: [executable], env: { PATTERM_MCP_SOCKET: socketPath, PATTERM_MCP_CATALOGUE_REFRESH_MS: '100' }, stderr: 'pipe' });
  const legacy = new LegacyClient({ name: 'shim-legacy-test', version: '1' });
  const legacyTransport = new LegacyTransport({ command: process.execPath, args: [executable], env: { PATTERM_MCP_SOCKET: socketPath, PATTERM_MCP_CATALOGUE_REFRESH_MS: '100' }, stderr: 'pipe' });
  try {
    buildSync({ entryPoints: ['mcp/shim.ts'], outfile: executable, bundle: true, platform: 'node', format: 'cjs' });
    await listen();
    await modern.connect(modernTransport);
    assert.equal(modern.getProtocolEra(), 'modern', 'modern clients use the 2026-07-28 protocol');
    const list = await modern.listTools();
    assert.deepEqual(list.tools.map(({ name }) => name), descriptors.map(({ name }) => name), 'every public registry tool is directly listed');
    assert.deepEqual(list.tools.find(({ name }) => name === 'todo.create')?.inputSchema.required, ['title']);
    const created = await modern.callTool({ name: 'todo.create', arguments: { title: 'Direct MCP' } });
    assert.equal(created.isError, undefined);
    assert.match(JSON.stringify(created), /Direct MCP/);
    const missing = await modern.callTool({ name: 'todo.create', arguments: {} });
    assert.equal(missing.isError, true, 'advertised schemas validate before forwarding');
    assert.equal(calls.some(({ tool, args }) => tool === 'todo.create' && !Object.keys(args as object).length), false);

    // The shim doubles as xdg-open in agent terminals.
    const openEnv = { ...process.env, PATTERM_MCP_SOCKET: socketPath, PATTERM_MCP_IDENTITY: 'mcp_opener' };
    const runOpener = (url: string) => new Promise<{ status: number | null; stderr: string }>((resolve) => {
      execFile(process.execPath, [executable, '--open', url], { env: openEnv, timeout: 5_000 }, (error, _stdout, stderr) => {
        resolve({ status: error ? (typeof error.code === 'number' ? error.code : null) : 0, stderr });
      });
    });
    const open = await runOpener('https://example.com/pulls/87');
    assert.equal(open.status, 0, open.stderr);
    assert.deepEqual(opened, [{ url: 'https://example.com/pulls/87', identity: 'mcp_opener' }]);
    const refused = await runOpener('file:///etc/passwd');
    assert.equal(refused.status, 1, 'a refused open fails so the CLI can fall back');
    assert.match(refused.stderr, /^xdg-open: Patterm does not open file: links/);

    const pid = modernTransport.pid;
    const initial = await modern.callTool({ name: 'whoami', arguments: {} }, { timeout: 2_000 });
    assert.notEqual(initial.isError, true, 'a complete response succeeds when its socket closes');
    const interrupted = modern.callTool({ name: 'spawn_process', arguments: { argv: ['sleep', '10'] } }, { timeout: 2_000 });
    await received;
    await close();
    const failure = await interrupted;
    assert.equal(failure.isError, true, 'a registry disconnect returns an explicit MCP failure');
    assert.match(JSON.stringify(failure), /command may have run and was not retried/);
    await listen();
    const recovered = await modern.callTool({ name: 'whoami', arguments: {} }, { timeout: 2_000 });
    assert.notEqual(recovered.isError, true, 'the next request reconnects to the restarted registry');
    assert.equal(modernTransport.pid, pid, 'recovery keeps the same shim process');
    assert.deepEqual(calls.map(({ tool }) => tool), ['todo.create', 'whoami', 'spawn_process', 'whoami']);

    await legacy.connect(legacyTransport);
    assert.deepEqual((await legacy.listTools()).tools.map(({ name }) => name), descriptors.map(({ name }) => name), 'legacy initialize clients see the same direct tools');
    assert.notEqual((await legacy.callTool({ name: 'whoami', arguments: {} })).isError, true);

    // A redeployed app's catalogue reaches running shims. Clients that honour
    // tools/list_changed re-list; others get a one-time note on their next
    // tool response, even one the SDK rejects.
    let listChanged = 0;
    legacy.setNotificationHandler(ToolListChangedNotificationSchema, () => { listChanged += 1; });
    const announced = async (count: number) => {
      const deadline = Date.now() + 5_000;
      while (listChanged < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(listChanged >= count, 'the shim announces a changed catalogue');
      // Past the refresh that sent it and the re-list grace period.
      await new Promise((resolve) => setTimeout(resolve, 300));
    };
    const texts = (result: unknown) => ((result as { content: Array<{ text: string }> }).content).map(({ text }) => text);
    catalogue = descriptors.filter(({ name }) => name !== 'help').map((tool) =>
      tool.name === 'todo.create' ? { ...tool, inputSchema: { type: 'object', properties: { title: { type: 'string' }, priority: { type: 'number' } }, required: ['title', 'priority'] } }
        : tool.name === 'spawn_process' ? { ...tool, changes: ['context'] } : tool);
    await announced(1);
    const rejectedCall = await legacy.callTool({ name: 'todo.create', arguments: { title: 'Old schema' } });
    assert.equal(rejectedCall.isError, true, 'a call the new schema refuses still fails');
    assert.match(texts(rejectedCall).at(-1)!, /\(changed: todo\.create; removed: help\)\. This session cannot see the changes/, 'and carries the note; unadvertised fields are not changes');
    assert.equal(texts(await legacy.callTool({ name: 'whoami', arguments: {} })).length, 1, 'the note is not repeated');

    const seen = listChanged;
    catalogue = [
      ...catalogue.map((tool) => tool.name === 'whoami' ? { ...tool, description: 'Return caller identity and role.' } : tool),
      { name: 'routine.schedule_once', namespace: 'routine', description: 'Run a routine once.', inputSchema: { type: 'object', properties: { at: { type: 'string' } }, required: ['at'] } }
    ];
    await announced(seen + 1);
    await assert.rejects(legacy.callTool({ name: 'help', arguments: { tool: 'whoami' } }),
      /new: routine\.schedule_once; changed: whoami, todo\.create; removed: help/, 'a call to a removed tool carries the next note');

    const relisted = await modern.listTools();
    assert.deepEqual(relisted.tools.map(({ name }) => name), catalogue.map(({ name }) => name), 'a re-list sees added and removed tools');
    assert.equal(relisted.tools.find(({ name }) => name === 'whoami')?.description, 'Return caller identity and role.', 'and changed descriptions');
    assert.equal(texts(await modern.callTool({ name: 'routine.schedule_once', arguments: { at: 'tomorrow' } })).length, 1, 'a client that re-listed gets no note');
    assert.equal((await modern.callTool({ name: 'routine.schedule_once', arguments: {} })).isError, true, 'new tools validate against their schema');
    assert.deepEqual(calls.at(-1), { tool: 'routine.schedule_once', args: { at: 'tomorrow' }, version: 2 });
  } finally {
    await modern.close();
    await legacy.close();
    if (registry.listening) await close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

void main().then(() => console.log('mcp shim smoke ok')).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
