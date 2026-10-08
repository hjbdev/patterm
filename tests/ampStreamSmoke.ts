import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

async function main(): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-amp-stream-'));
  const executable = path.join(directory, 'amp');
  const socketPath = path.join(directory, 'host.sock');
  const mcpConfigPath = path.join(directory, 'mcp.json');
  const configPath = path.join(directory, 'host.json');
  fs.writeFileSync(executable, `#!/usr/bin/env node
const frame = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const record = (value) => require('node:fs').appendFileSync(process.env.AMP_RECORD, JSON.stringify(value) + '\\n');
record({argv: process.argv.slice(2)});
frame({type:'system',subtype:'init',session_id:'T-test'});
let buffer = '';
let turn = 0;
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (let end; (end = buffer.indexOf('\\n')) >= 0;) {
    const line = buffer.slice(0,end); buffer = buffer.slice(end+1);
    const input = JSON.parse(line);
    record({input});
    const toolId = 'tool_' + ++turn;
    const send = () => {
      frame({type:'user',message:{content:input.message.content.filter(part => part.type !== 'image')}}); // Amp omits images and requestId from stdout.
      frame({type:'assistant',message:{content:[{type:'tool_use',id:toolId,name:'Bash',input:{cmd:'echo ok'}}]}});
      frame({type:'user',message:{content:[{type:'tool_result',tool_use_id:toolId,content:turn === 3 ? [{type:'text',text:'Captured'},{type:'image',source:{type:'base64',media_type:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='}}] : 'ok'}]}});
      frame({type:'assistant',message:{content:[{type:'thinking',thinking:'Considering'},{type:'text',text:'Done'}]}});
      const failed = JSON.stringify(input).includes('Fail this turn');
      const approval = JSON.stringify(input).includes('Needs approval');
      frame({type:'result',is_error:failed || approval,...(failed ? {error:'Model overloaded'} : approval ? {error:'The following tools require user approval, which is not supported in stream JSON mode: shell_command'} : {}),permission_denials:turn === 2 ? ['Bash: git push'] : []});
    };
    if (turn === 1 || JSON.stringify(input).includes('Slow')) setTimeout(send, 150); else send();
  }
});
`, { mode: 0o755 });
  fs.writeFileSync(mcpConfigPath, '{}');
  fs.writeFileSync(configPath, JSON.stringify({ socketPath, executable, cwd: directory, sessionId: 'T-test', context: 'Project orientation', mcpConfigPath, imageDirectory: path.join(directory, 'images') }));
  const recordPath = path.join(directory, 'record.jsonl');
  const host = spawn(process.execPath, [path.resolve(__dirname, '../app/Runtime/AmpIntegratedHost.js'), configPath], { stdio: 'ignore', env: { ...process.env, AMP_RECORD: recordPath } });
  const recorded = (): Array<{ argv?: string[]; input?: Record<string, unknown> }> => fs.readFileSync(recordPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  try {
    for (let i = 0; !fs.existsSync(socketPath) && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(socketPath));
    await waitUntil(async () => (await call(socketPath, 'conversation', {})).status === 'idle');
    const first = call(socketPath, 'prompt', { text: 'First', clientMessageId: 'first' });
    assert.equal((await call(socketPath, 'delivery', { clientMessageId: 'first' })).state, 'unknown', 'pipe write is not native admission');
    await first;
    await waitUntil(async () => (await call(socketPath, 'delivery', { clientMessageId: 'first' })).state === 'accepted');
    await call(socketPath, 'prompt', { text: 'Second', clientMessageId: 'second' });
    await waitUntil(async () => (await call(socketPath, 'delivery', { clientMessageId: 'second' })).state === 'accepted');
    await call(socketPath, 'prompt', { text: '', images: [{ media_type: 'image/png', data: 'iVBORw0KGgo=' }], attachments: [{ type: 'image', name: 'capture.png', mime: 'image/png' }], clientMessageId: 'image' });
    await waitUntil(async () => (await call(socketPath, 'delivery', { clientMessageId: 'image' })).state === 'accepted');
    const conversation = await call(socketPath, 'conversation', {});
    const messages = (conversation.messages as { data: Array<Record<string, unknown>> }).data;
    assert.deepEqual(messages.filter((item) => item.role === 'user').map((item) => item.text), ['First', 'Second', '']);
    assert.deepEqual(messages.find((item) => item.id === 'user_image')?.attachments, [{ type: 'image', name: 'capture.png', mime: 'image/png' }]);
    assert.equal(messages.filter((item) => item.role === 'assistant' && item.kind === 'tool').length, 3);
    assert.equal((messages.find((item) => item.id === 'tool_1')?.tool as { state: { status: string } }).state.status, 'completed');
    assert.equal(messages.find((item) => item.id === 'tool_2')?.text, 'ok');
    const imageTool = messages.find((item) => item.id === 'tool_3')!;
    assert.equal(imageTool.text, 'Captured', 'image blocks are not stringified into tool output');
    const toolImage = (imageTool.tool as { images?: Array<{ sha256: string; mime: string }> }).images?.[0];
    assert.equal(toolImage?.mime, 'image/png');
    assert.ok(fs.existsSync(path.join(directory, 'images', `${toolImage?.sha256}.png`)), 'the tool image is stored by hash');
    assert.equal(messages.filter((item) => item.text === 'Done').length, 3);
    assert.ok(messages.some((item) => item.text === 'Amp denied: Bash: git push'));
    const activity = (conversation.usage as { lastModelActivityAt?: string }).lastModelActivityAt;
    assert.ok(Date.now() - Date.parse(String(activity)) < 60_000, 'an assistant frame stamps the latest model activity');
    assert.ok(recorded()[0]?.argv?.includes('--stream-json-thinking'), 'thinking blocks are requested');
    assert.ok(messages.some((item) => item.kind === 'reasoning' && item.text === 'Considering'), 'Amp thinking is shown as reasoning');
    // Host times: whole rows finish on arrival, a tool with its result, and a
    // thought begins no later than the frame before it.
    const timed = messages as Array<{ id: string; kind: string; created_at?: string; completed_at?: string }>;
    const tool = timed.find((item) => item.id === 'tool_1');
    assert.ok(tool?.created_at && tool.completed_at, 'a tool row finishes when its result arrives');
    for (const item of timed.filter((row) => row.kind !== 'tool')) {
      assert.ok(item.created_at && item.completed_at && Date.parse(item.completed_at) >= Date.parse(item.created_at), `${item.id} has a start and a finish`);
    }
    const inputs = recorded().flatMap((entry) => entry.input ? [entry.input] : []);
    assert.deepEqual(inputs.slice(0, 3).map((input) => input.request_id), ['first', 'second', 'image'], 'Amp reads the snake_case request_id');
    assert.ok(inputs.every((input) => !('requestId' in input)));
    assert.ok(inputs.slice(0, 3).every((input) => !('steer' in input)), 'an idle session sends a normal message');
    // A failed turn is an error state, and the same process takes the next prompt.
    await call(socketPath, 'prompt', { text: 'Fail this turn', clientMessageId: 'fail' });
    await waitUntil(async () => (await call(socketPath, 'conversation', {})).status === 'error');
    await call(socketPath, 'prompt', { text: 'Recover', clientMessageId: 'recover' });
    await waitUntil(async () => (await call(socketPath, 'conversation', {})).status === 'idle');
    // Stream mode denies tools that need approval; the error explains what to do.
    await call(socketPath, 'prompt', { text: 'Needs approval', clientMessageId: 'approval' });
    await waitUntil(async () => (await call(socketPath, 'conversation', {})).status === 'error');
    const denied = ((await call(socketPath, 'conversation', {})).messages as { data: Array<{ text: string }> }).data.at(-1)!.text;
    assert.match(denied, /amp permissions add/, 'an approval failure points at Amp permissions or terminal mode');
    // A message sent during a turn steers it, as typing does in the Amp TUI.
    const slow = call(socketPath, 'prompt', { text: 'Slow turn', clientMessageId: 'slow' });
    await waitUntil(async () => (await call(socketPath, 'conversation', {})).status === 'working');
    const steered = call(socketPath, 'prompt', { text: 'Steer it', clientMessageId: 'steer' });
    await Promise.all([slow, steered]);
    assert.equal(recorded().find((entry) => entry.input?.request_id === 'steer')?.input?.steer, true);
    await call(socketPath, 'stop', {});
    console.log('Amp Integrated stream smoke passed');
  } finally {
    host.kill('SIGTERM');
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function call(socketPath: string, method: string, params: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', reject);
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: method, method, params })}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      socket.end();
      const response = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))) as { result?: Record<string, unknown>; error?: string };
      if (response.error) reject(new Error(response.error)); else resolve(response.result ?? {});
    });
  });
}

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Amp stream did not reach expected state');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
