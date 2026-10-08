import './HostEnvironment';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import { TranscriptImageStore } from '../Services/TranscriptImageStore';

type Row = Record<string, unknown>;
interface Config {
  socketPath: string;
  executable: string;
  cwd: string;
  sessionId: string;
  context: string;
  mcpConfigPath: string;
  model?: string | null;
  imageDirectory?: string;
}

const config = JSON.parse(fs.readFileSync(process.argv[2]!, 'utf8')) as Config;
const images = config.imageDirectory ? new TranscriptImageStore(config.imageDirectory) : null;
const messages: Row[] = [];
const admitted = new Set<string>();
const pending: string[] = [];
const attachments = new Map<string, Row[]>();
const acknowledgements = new Map<string, { socket: net.Socket; id: unknown }>();
const subscribers = new Set<net.Socket>();
let revision = 0;
let status = 'starting';
let child: ChildProcessWithoutNullStreams | null = null;
let buffer = '';
let turn = 0;
let stopping = false;
let interrupted = false;
let oriented = false;
// Why the last turn failed, for the error banner.
let statusDetail: string | null = null;
// When the previous native frame arrived. Amp sends whole messages, so a
// thought began no later than the frame before the one that carries it.
let lastFrameAt = new Date().toISOString();
// Native frame types this host does not project, for the debug log.
const unhandled: Record<string, number> = {};
// Shared usage telemetry from each assistant frame's native usage. Amp's
// stream does not report the context window.
const usage: Row = {};

try { fs.unlinkSync(config.socketPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const server = net.createServer((socket) => {
  let incoming = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    incoming += chunk;
    for (let index; (index = incoming.indexOf('\n')) >= 0;) {
      const line = incoming.slice(0, index);
      incoming = incoming.slice(index + 1);
      try { void handle(socket, JSON.parse(line) as Row).catch((error) => reply(socket, null, undefined, error)); }
      catch (error) { reply(socket, null, undefined, error); }
    }
  });
});
server.listen(config.socketPath, () => fs.chmodSync(config.socketPath, 0o600));
start();

async function handle(socket: net.Socket, request: Row): Promise<void> {
  const params = record(request.params);
  switch (request.method) {
    case 'conversation':
      reply(socket, request.id, { messages: { data: messages }, permissions: { data: [] }, questions: { data: [] }, usage, status, revision, diagnostics: { unhandled },
        ...((status === 'error' || status === 'failed') && statusDetail ? { status_detail: statusDetail } : {}) });
      return;
    case 'subscribe':
      subscribers.add(socket);
      socket.once('close', () => subscribers.delete(socket));
      reply(socket, request.id, { revision });
      // Hand the client a fresh boundary, as the Claude host does, so a turn
      // that ended while it was disconnected is re-read from the snapshot.
      publish({ kind: 'pending' });
      return;
    case 'delivery':
      reply(socket, request.id, { state: admitted.has(String(params.clientMessageId)) ? 'accepted' : 'unknown' });
      return;
    case 'prompt': {
      if (!child?.stdin.writable || status === 'failed') throw new Error('Amp process is not running');
      const text = String(params.text ?? '').trim();
      const images = (Array.isArray(params.images) ? params.images : []).map(record).map((image) => ({
        type: 'image', source: { type: 'base64', media_type: image.media_type, data: image.data }
      }));
      if (!text && !images.length) throw new Error('Message is empty');
      const requestId = String(params.clientMessageId ?? randomUUID());
      const nativeText = !oriented && config.context ? `${config.context}\n\n${text}` : text;
      oriented = true;
      const content = [...(nativeText ? [{ type: 'text', text: nativeText }] : []), ...images];
      // Amp reads `request_id` (it derives the native message id from it) and
      // `steer`. A message sent while a turn runs steers it, as typing does in
      // the Amp TUI, instead of waiting in the queue until the turn ends.
      const steer = status === 'working';
      const line = JSON.stringify({ type: 'user', request_id: requestId, ...(steer ? { steer } : {}), message: { role: 'user', content } });
      // Do not claim native admission on a successful pipe write. Only Amp's
      // echoed user frame confirms the request ID in its thread.
      child.stdin.write(`${line}\n`);
      pending.push(requestId);
      attachments.set(requestId, (Array.isArray(params.attachments) ? params.attachments : []).map(record));
      acknowledgements.set(requestId, { socket, id: request.id });
      setStatus('working');
      return;
    }
    case 'interrupt':
      // The stream has no interrupt input. A fresh execute process continues
      // the same native thread after the old one exits.
      if (child && status === 'working') { interrupted = true; child.kill('SIGTERM'); }
      reply(socket, request.id, {});
      return;
    case 'stop':
      stopping = true;
      reply(socket, request.id, {});
      child?.kill('SIGTERM');
      for (const subscriber of subscribers) subscriber.destroy();
      server.close(() => process.exit(0));
      return;
    default:
      throw new Error(`Unknown Amp host method: ${String(request.method)}`);
  }
}

function start(): void {
  buffer = '';
  const args = ['threads', 'continue', config.sessionId, '--execute', '--stream-json', '--stream-json-thinking', '--stream-json-input',
    '--no-archive-after-execute', '--mcp-config', config.mcpConfigPath,
    ...(config.model ? ['--mode', config.model] : [])];
  const next = spawn(config.executable, args, { cwd: config.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  child = next;
  setStatus('starting');
  let stderr = '';
  next.stdout.setEncoding('utf8');
  next.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    for (let index; (index = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try { receive(JSON.parse(line) as Row); } catch { /* Only complete JSON frames are projected. */ }
    }
  });
  next.stderr.setEncoding('utf8');
  next.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
  next.stdin.on('error', () => {});
  next.on('error', (error) => { stderr = error.message; });
  next.on('close', () => {
    if (child !== next || stopping) return;
    child = null;
    if (interrupted) {
      // An interrupted turn has no final result; resume the native thread.
      interrupted = false;
      pending.length = 0;
      attachments.clear();
      acknowledgements.clear();
      setStatus('idle');
      start();
    } else {
      setStatus('failed');
      put({ id: `error_${++turn}`, role: 'assistant', kind: 'notice', level: 'error', text: stderr || 'Amp stream exited unexpectedly' });
    }
  });
}

function receive(frame: Row): void {
  const previousFrameAt = lastFrameAt;
  lastFrameAt = new Date().toISOString();
  if (frame.type === 'system' && frame.subtype === 'init') {
    setStatus('idle');
    return;
  }
  if (frame.type === 'user') {
    const parts = record(frame.message).content;
    if (!Array.isArray(parts)) return;
    for (const raw of parts) {
      const part = record(raw);
      if (part.type !== 'tool_result') continue;
      const index = messages.findIndex((message) => message.id === part.tool_use_id);
      if (index < 0) continue;
      const message = messages[index]!;
      // Image blocks become stored references instead of base64 in the output.
      const blocks = Array.isArray(part.content) ? part.content.map(record) : [];
      const shown = blocks.slice(0, 20).flatMap((block) => {
        const source = record(block.source);
        const image = block.type === 'image' && source.type === 'base64' ? images?.fromBase64(source.data) : null;
        return image ? [image] : [];
      });
      const output = typeof part.content === 'string' ? part.content
        : blocks.some((block) => block.type === 'image') ? blocks.flatMap((block) => typeof block.text === 'string' ? [block.text] : []).join('\n')
          : JSON.stringify(part.content ?? '');
      const updated = { ...message, completed_at: typeof message.completed_at === 'string' ? message.completed_at : new Date().toISOString(), text: output.slice(0, 200_000), tool: { ...record(message.tool), ...(shown.length ? { images: shown } : {}), state: {
        status: part.is_error ? 'error' : 'completed', ...(part.is_error ? { error: { message: output } } : {})
      } } };
      messages[index] = updated;
      publish({ kind: 'replace', message: updated });
    }
    if (parts.some((part) => record(part).type === 'tool_result')) return;
    if (!parts.some((part) => record(part).type === 'text') && !pending.length) return;
    // Amp does not echo the request id, so admissions match in send order.
    const requestId = pending.shift() ?? null;
    if (requestId && pending[0] === requestId) pending.shift();
    if (requestId) {
      admitted.add(requestId);
      if (admitted.size > 500) admitted.delete(admitted.values().next().value!);
      const acknowledgement = acknowledgements.get(requestId);
      if (acknowledgement) reply(acknowledgement.socket, acknowledgement.id, { id: `user_${requestId}` });
      acknowledgements.delete(requestId);
    }
    const text = parts.map(record).filter((part) => part.type === 'text').map((part) => String(part.text ?? '')).join('\n');
    const displayAttachments = requestId ? attachments.get(requestId) ?? [] : [];
    if (requestId) attachments.delete(requestId);
    if (text || displayAttachments.length) put({ id: requestId ? `user_${requestId}` : `user_${++turn}`, role: 'user', kind: 'text', text: requestId && config.context && text.startsWith(config.context) ? text.slice(config.context.length).trim() : text,
      ...(displayAttachments.length ? { attachments: displayAttachments } : {}) });
    return;
  }
  if (frame.type === 'assistant') {
    recordUsage(record(record(frame.message).usage));
    const parts = record(frame.message).content;
    if (!Array.isArray(parts)) return;
    const prefix = `amp_${++turn}`;
    for (const [index, raw] of parts.entries()) {
      const part = record(raw);
      if (part.type === 'text' && typeof part.text === 'string') put({ id: `${prefix}_${index}`, role: 'assistant', kind: 'text', text: part.text });
      if ((part.type === 'thinking' || part.type === 'redacted_thinking') && typeof part.thinking === 'string') put({ id: `${prefix}_${index}`, role: 'assistant', kind: 'reasoning', text: part.thinking, created_at: previousFrameAt });
      if (part.type === 'tool_use') put({ id: String(part.id ?? `${prefix}_${index}`), role: 'assistant', kind: 'tool', text: '', tool: { name: part.name, input: part.input, state: { status: 'running' } } });
    }
    return;
  }
  if (frame.type !== 'result') {
    const type = `${String(frame.type ?? 'unknown')}${frame.subtype ? `/${String(frame.subtype)}` : ''}`;
    if (Object.keys(unhandled).length < 100 || unhandled[type] !== undefined) unhandled[type] = (unhandled[type] ?? 0) + 1;
    return;
  }
  // A failed turn leaves the process running and ready for the next prompt,
  // so it is an error state, not the `failed` process state.
  setStatus(frame.is_error ? 'error' : 'idle');
  if (frame.is_error) {
    const error = String(frame.error ?? 'Amp execution failed');
    statusDetail = error;
    // Stream mode denies any tool that needs approval and ends the turn.
    const approval = /requires? user approval, which is not supported in stream JSON mode/.test(error);
    put({ id: `error_${++turn}`, role: 'assistant', kind: 'notice', level: 'error', text: approval
      ? `${error}\n\nAmp cannot ask for approval in Integrated mode. Allow the tool with \`amp permissions add\`, or continue this thread in terminal mode.`
      : error });
  }
  if (Array.isArray(frame.permission_denials) && frame.permission_denials.length) {
    put({ id: `denials_${++turn}`, role: 'assistant', kind: 'notice', level: 'warning', text: `Amp denied: ${frame.permission_denials.join(', ')}` });
  }
}

function recordUsage(value: Row): void {
  usage.lastModelActivityAt = new Date().toISOString();
  const number = (key: string): number => typeof value[key] === 'number' ? value[key] as number : 0;
  const context = number('input_tokens') + number('cache_read_input_tokens') + number('cache_creation_input_tokens');
  if (context > 0) {
    usage.contextTokens = context;
    usage.inputTokens = (typeof usage.inputTokens === 'number' ? usage.inputTokens : 0) + context;
  }
  if (number('output_tokens') > 0) usage.outputTokens = (typeof usage.outputTokens === 'number' ? usage.outputTokens : 0) + number('output_tokens');
}

function record(value: unknown): Row { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}; }
function reply(socket: net.Socket, id: unknown, result?: unknown, error?: unknown): void {
  socket.write(`${JSON.stringify(error ? { id, error: String(error) } : { id, result })}\n`);
}
function publish(event: Row): void {
  revision++;
  for (const socket of subscribers) socket.write(`${JSON.stringify({ event: { ...event, revision } })}\n`);
}
// Amp frames carry no native times. Every row but a running tool is whole when
// it arrives, so it finishes then; a tool finishes with its result.
function put(message: Row): void {
  const now = new Date().toISOString();
  const running = message.kind === 'tool';
  const row = { ...message, created_at: typeof message.created_at === 'string' ? message.created_at : now, ...(running ? {} : { completed_at: now }) };
  messages.push(row);
  if (messages.length > 400) messages.shift();
  publish({ kind: 'replace', message: row });
}
function setStatus(value: string): void {
  if (status === value) return;
  status = value;
  publish({ kind: 'status', status: value === 'failed' || value === 'error' ? 'error' : value === 'idle' ? 'idle' : 'working' });
}
process.on('exit', () => {
  for (const file of [config.socketPath, config.mcpConfigPath, process.argv[2]!]) {
    try { fs.unlinkSync(file); } catch {}
  }
});
process.on('SIGTERM', () => {
  stopping = true;
  child?.kill('SIGTERM');
  server.close(() => process.exit(0));
});
