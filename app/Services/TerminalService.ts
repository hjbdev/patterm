import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { withEnv } from '../Platform/Environment';
import { resolveCommand } from '../Platform/Executable';
import type { DebugLogService } from './DebugLogService';
import { TerminalHostService, type TerminalHostOptions } from './TerminalHostService';

const FRAME_CONTROL_RESPONSE = 0x01;
const FRAME_TERMINAL_DAMAGE = 0x05;
const FRAME_TERMINAL_LIFECYCLE = 0x06;

interface PendingRequest {
  timer: ReturnType<typeof setTimeout>;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export interface TerminalDamageFrame {
  type: 'terminal-damage';
  payload: Uint8Array;
  processId: string | null;
  frameKind: 'snapshot' | 'damage' | null;
  frameSeq: number | null;
  resizeSeq: number | null;
}

export interface TerminalLifecycleFrame {
  type: 'terminal-lifecycle';
  processId: string;
  event: string;
  title?: string;
  status?: string;
  activity?: string;
  exitCode?: number | null;
  mouse?: {
    click?: boolean;
    drag?: boolean;
    motion?: boolean;
    sgr?: boolean;
  };
}

// OSC 52 copy from a terminal program. Kept apart from lifecycle frames so the
// text only reaches the client that controls the process.
export interface TerminalClipboardFrame {
  type: 'terminal-clipboard';
  processId: string;
  text: string;
}

// BEL or an OSC 9, 777, or 99 desktop notification from a terminal program.
export interface TerminalNotificationFrame {
  type: 'terminal-notification';
  processId: string;
  source: 'bell' | 'osc9' | 'osc777' | 'osc99';
  title?: string;
  body?: string;
}

export type TerminalFrame = TerminalDamageFrame | TerminalLifecycleFrame | TerminalClipboardFrame | TerminalNotificationFrame;
type TerminalFrameListener = (frame: TerminalFrame) => void;

export class TerminalService {
  private process: ChildProcessWithoutNullStreams | null = null;
  private socket: net.Socket | null = null;
  private hosts: TerminalHostService | null = null;
  private stopping = false;
  private nextId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly frameListeners = new Set<TerminalFrameListener>();
  private readonly stdoutChunks: Buffer[] = [];
  private stdoutBufferedBytes = 0;
  private visibleDamageProcessId: string | null = null;
  private readonly exitListeners = new Set<() => void>();

  constructor(
    private readonly sidecarPath: string,
    private readonly debugLog: DebugLogService,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly hostOptions?: TerminalHostOptions
  ) {}

  async start(): Promise<void> {
    if (this.hostOptions) {
      this.hosts = new TerminalHostService(this.sidecarPath, this.debugLog, this.env, this.hostOptions,
        (frame) => { for (const listener of this.frameListeners) listener(frame); },
        () => { for (const listener of this.exitListeners) listener(); });
      await this.hosts.start();
      return;
    }
    if (!fs.existsSync(this.sidecarPath)) {
      this.debugLog.write('terminal-service', 'sidecar.missing', { sidecarPath: this.sidecarPath });
      return;
    }

    this.debugLog.write('terminal-service', 'sidecar.spawn', { sidecarPath: this.sidecarPath });
    this.process = spawn(this.sidecarPath, [], {
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    this.process.stdout.on('data', (chunk: Buffer) => this.handleStdout(chunk));
    this.process.stderr.on('data', (chunk: Buffer) => {
      this.debugLog.write('terminal-sidecar', 'stderr', { text: chunk.toString('utf8').trimEnd(), byteLength: chunk.byteLength });
      process.stderr.write(chunk);
    });
    this.process.stdin.on('error', () => { /* Exit rejects pending requests. */ });
    this.process.on('exit', () => {
      this.debugLog.write('terminal-service', 'sidecar.exit', { pendingRequests: this.pending.size });
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('terminal sidecar exited'));
      }
      this.pending.clear();
      this.process = null;
      this.stdoutChunks.length = 0;
      this.stdoutBufferedBytes = 0;
      for (const listener of this.exitListeners) listener();
    });
    await new Promise<void>((resolve, reject) => {
      this.process!.once('spawn', resolve);
      this.process!.once('error', (error) => { this.process = null; reject(error); });
    });
    await this.request('terminal.ping');
  }

  isAvailable(): boolean {
    return this.hosts ? this.hosts.isAvailable() : this.process !== null || this.socket !== null;
  }

  async connect(socketPath: string): Promise<void> {
    const socket = net.createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.handleStdout(chunk));
    socket.on('error', () => socket.destroy());
    socket.once('close', () => {
      this.socket = null;
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('Terminal host connection lost; command was not retried'));
      }
      this.pending.clear();
      this.stdoutChunks.length = 0;
      this.stdoutBufferedBytes = 0;
      for (const listener of this.exitListeners) listener();
    });
  }

  beginShutdown(): void {
    this.stopping = true;
  }

  async shutdown(): Promise<void> {
    this.beginShutdown();
    if (this.hosts) await this.hosts.shutdown();
    else await this.dispose();
  }

  async request(method: string, params: unknown = {}): Promise<unknown> {
    if (this.stopping && (method === 'terminal.process.spawn' || method === 'terminal.process.input')) {
      throw new Error('Patterm is shutting down');
    }
    if (method === 'terminal.process.spawn') params = sidecarSpawnParams(params, this.env);
    if (this.hosts) return this.hosts.request(method, params);
    const input = this.socket ?? this.process?.stdin;
    if (!input) {
      return { ok: false, unavailable: true, method };
    }

    const id = ++this.nextId;
    const payload = JSON.stringify({ id, method, params }) + '\n';
    this.writeTerminalDebug('request.send', { id, method, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Terminal request timed out: ${method}`));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      input.write(payload, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  onExit(listener: () => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  // Frames from a paired host's terminals reach this host's clients like
  // local ones.
  emitRelayedFrame(frame: TerminalFrame): void {
    for (const listener of this.frameListeners) listener(frame);
  }

  onFrame(listener: TerminalFrameListener): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  setVisibleDamageProcess(processId: string, visible: boolean): void {
    if (visible) {
      this.visibleDamageProcessId = processId;
      return;
    }

    if (this.visibleDamageProcessId === processId) {
      this.visibleDamageProcessId = null;
    }
  }

  shouldForwardDamageFrame(frame: TerminalDamageFrame): boolean {
    return Boolean(frame.processId && frame.processId === this.visibleDamageProcessId);
  }

  async dispose(): Promise<void> {
    if (this.hosts) {
      await this.hosts.dispose();
      return;
    }
    if (this.socket) {
      const socket = this.socket;
      await new Promise<void>((resolve) => { socket.once('close', resolve); socket.destroy(); });
      return;
    }
    if (!this.process) {
      return;
    }

    const child = this.process;
    // Standalone desktop hosts own their descendants too. Let the host finish
    // bounded cleanup before terminating its transport process.
    try {
      await this.request('terminal.host.shutdown');
    } finally {
      if (this.process === child) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
          child.once('exit', () => { clearTimeout(timer); resolve(); });
          child.kill('SIGTERM');
        });
      }
    }
  }

  private handleStdout(chunk: Buffer): void {
    this.writeTerminalDebug('stdout.chunk', { byteLength: chunk.byteLength, bufferedBefore: this.stdoutBufferedBytes });
    this.stdoutChunks.push(chunk);
    this.stdoutBufferedBytes += chunk.byteLength;

    while (this.stdoutBufferedBytes >= 4) {
      const header = this.readStdoutBytes(4, false);
      if (!header) return;
      const frameLength = header.readUInt32LE(0);
      if (frameLength < 1 || frameLength > 64 * 1024 * 1024) {
        this.socket?.destroy(new Error('Invalid terminal frame length'));
        this.process?.kill();
        return;
      }
      const totalLength = 4 + frameLength;
      if (this.stdoutBufferedBytes < totalLength) {
        this.writeTerminalDebug('stdout.partial-frame', { frameLength, buffered: this.stdoutBufferedBytes });
        return;
      }

      this.discardStdoutBytes(4);
      const frame = this.readStdoutBytes(frameLength, true);
      if (!frame) return;
      const frameType = frame[0];
      const payload = frame.subarray(1);
      this.writeTerminalDebug('frame.received', { frameType, frameLength, payloadLength: payload.byteLength, remainingBuffer: this.stdoutBufferedBytes });

      this.handleFrame(frameType, payload);
    }
  }

  private readStdoutBytes(length: number, consume: boolean): Buffer | null {
    if (this.stdoutBufferedBytes < length) return null;
    const first = this.stdoutChunks[0];
    if (first && first.byteLength >= length) {
      const value = first.subarray(0, length);
      if (consume) {
        if (first.byteLength === length) {
          this.stdoutChunks.shift();
        } else {
          this.stdoutChunks[0] = first.subarray(length);
        }
        this.stdoutBufferedBytes -= length;
      }
      return value;
    }

    const value = Buffer.allocUnsafe(length);
    let copied = 0;
    for (const chunk of this.stdoutChunks) {
      const take = Math.min(chunk.byteLength, length - copied);
      chunk.copy(value, copied, 0, take);
      copied += take;
      if (copied === length) break;
    }
    if (consume) {
      this.discardStdoutBytes(length);
    }
    return value;
  }

  private discardStdoutBytes(length: number): void {
    let remaining = length;
    while (remaining > 0) {
      const first = this.stdoutChunks[0];
      if (!first) return;
      if (first.byteLength <= remaining) {
        remaining -= first.byteLength;
        this.stdoutBufferedBytes -= first.byteLength;
        this.stdoutChunks.shift();
      } else {
        this.stdoutChunks[0] = first.subarray(remaining);
        this.stdoutBufferedBytes -= remaining;
        remaining = 0;
      }
    }
  }

  private handleFrame(frameType: number | undefined, payload: Buffer): void {
    if (frameType === FRAME_CONTROL_RESPONSE) {
      this.handleControlResponse(payload);
      return;
    }

    if (frameType === FRAME_TERMINAL_DAMAGE) {
      const metadata = decodeDamageFrameMetadata(payload);
      this.writeTerminalDebug('frame.forward.damage', { payloadLength: payload.byteLength, listeners: this.frameListeners.size, metadata });
      const frame = { type: 'terminal-damage' as const, payload: new Uint8Array(payload), ...metadata };
      for (const listener of this.frameListeners) {
        listener(frame);
      }
      return;
    }

    if (frameType === FRAME_TERMINAL_LIFECYCLE) {
      const frame = this.decodeLifecycleFrame(payload);
      if (!frame) {
        this.debugLog.write('terminal-service', 'frame.lifecycle.invalid', { payloadLength: payload.byteLength });
        return;
      }

      this.writeTerminalDebug('frame.forward.lifecycle', frame.type === 'terminal-clipboard'
        ? { processId: frame.processId, textLength: frame.text.length }
        : frame.type === 'terminal-notification' ? { processId: frame.processId, source: frame.source } : frame);
      for (const listener of this.frameListeners) {
        listener(frame);
      }
    }
  }

  private decodeLifecycleFrame(payload: Buffer): TerminalLifecycleFrame | TerminalClipboardFrame | TerminalNotificationFrame | null {
    let raw: unknown;
    try {
      raw = JSON.parse(payload.toString('utf8'));
    } catch {
      return null;
    }

    if (!raw || typeof raw !== 'object') {
      return null;
    }

    const record = raw as Record<string, unknown>;
    if (typeof record.process_id !== 'string' || typeof record.event !== 'string') {
      return null;
    }

    if (record.event === 'clipboard') {
      return typeof record.text === 'string'
        ? { type: 'terminal-clipboard', processId: record.process_id, text: record.text }
        : null;
    }

    if (record.event === 'notification') {
      if (record.source !== 'bell' && record.source !== 'osc9' && record.source !== 'osc777' && record.source !== 'osc99') return null;
      return {
        type: 'terminal-notification',
        processId: record.process_id,
        source: record.source,
        ...(typeof record.title === 'string' ? { title: record.title } : {}),
        ...(typeof record.body === 'string' ? { body: record.body } : {})
      };
    }

    const frame: TerminalLifecycleFrame = {
      type: 'terminal-lifecycle',
      processId: record.process_id,
      event: record.event
    };

    if (typeof record.title === 'string') {
      frame.title = record.title;
    }
    if (typeof record.status === 'string') {
      frame.status = record.status;
    }
    if (typeof record.activity === 'string') {
      frame.activity = record.activity;
    }
    if (typeof record.exit_code === 'number' || record.exit_code === null) {
      frame.exitCode = record.exit_code;
    }
    if (record.mouse && typeof record.mouse === 'object') {
      const mouse = record.mouse as Record<string, unknown>;
      frame.mouse = {
        click: mouse.click === true,
        drag: mouse.drag === true,
        motion: mouse.motion === true,
        sgr: mouse.sgr === true
      };
    }

    return frame;
  }

  private handleControlResponse(payload: Buffer): void {
    let message: { id?: number; result?: unknown; error?: string };
    try {
      message = JSON.parse(payload.toString('utf8')) as { id?: number; result?: unknown; error?: string };
    } catch {
      return;
    }

    if (typeof message.id !== 'number') {
      this.writeTerminalDebug('control-response.missing-id');
      return;
    }

    const request = this.pending.get(message.id);
    if (!request) {
      this.writeTerminalDebug('control-response.unmatched', { id: message.id });
      return;
    }

    this.pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) {
      this.writeTerminalDebug('control-response.error', { id: message.id, error: message.error });
      request.reject(new Error(message.error));
      return;
    }

    this.writeTerminalDebug('control-response.result', { id: message.id });
    request.resolve(message.result);
  }

  private writeTerminalDebug(event: string, data?: unknown): void {
    if (!terminalDebugEnabled()) return;
    this.debugLog.write('terminal-service', event, data);
  }
}

// Damage frames name their PTY in the header, after the version, kind, and
// three sequence fields. A frame relayed from a paired host is renamed to the
// host-qualified ID that this host's clients know it by.
const DAMAGE_PROCESS_ID_OFFSET = 2 + 1 + 4 + 4 + 4;

export function renameDamageFrame(payload: Uint8Array, processId: string): Uint8Array | null {
  const buffer = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  if (buffer.byteLength < DAMAGE_PROCESS_ID_OFFSET + 2) return null;
  const version = buffer.readUInt16LE(0);
  if (version !== 2 && version !== 3) return null;
  const length = buffer.readUInt16LE(DAMAGE_PROCESS_ID_OFFSET);
  const rest = DAMAGE_PROCESS_ID_OFFSET + 2 + length;
  if (rest > buffer.byteLength) return null;
  const id = Buffer.from(processId, 'utf8');
  const out = Buffer.alloc(buffer.byteLength - length + id.byteLength);
  buffer.copy(out, 0, 0, DAMAGE_PROCESS_ID_OFFSET);
  out.writeUInt16LE(id.byteLength, DAMAGE_PROCESS_ID_OFFSET);
  id.copy(out, DAMAGE_PROCESS_ID_OFFSET + 2);
  buffer.copy(out, DAMAGE_PROCESS_ID_OFFSET + 2 + id.byteLength, rest);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

function decodeDamageFrameMetadata(payload: Buffer): Pick<TerminalDamageFrame, 'processId' | 'frameKind' | 'frameSeq' | 'resizeSeq'> {
  let offset = 0;
  const readU8 = (): number | null => {
    if (offset + 1 > payload.byteLength) return null;
    const value = payload.readUInt8(offset);
    offset += 1;
    return value;
  };
  const readU16 = (): number | null => {
    if (offset + 2 > payload.byteLength) return null;
    const value = payload.readUInt16LE(offset);
    offset += 2;
    return value;
  };
  const readU32 = (): number | null => {
    if (offset + 4 > payload.byteLength) return null;
    const value = payload.readUInt32LE(offset);
    offset += 4;
    return value;
  };

  const version = readU16();
  if (version !== 2 && version !== 3) {
    return { processId: null, frameKind: null, frameSeq: null, resizeSeq: null };
  }

  const rawKind = readU8();
  const frameSeq = readU32();
  readU32();
  const resizeSeq = readU32();
  const processIdLength = readU16();
  if (rawKind === null || frameSeq === null || resizeSeq === null || processIdLength === null || offset + processIdLength > payload.byteLength) {
    return { processId: null, frameKind: null, frameSeq: null, resizeSeq: null };
  }

  const processId = payload.subarray(offset, offset + processIdLength).toString('utf8');
  return {
    processId,
    frameKind: rawKind === 0 ? 'snapshot' : rawKind === 1 ? 'damage' : null,
    frameSeq,
    resizeSeq
  };
}

function terminalDebugEnabled(): boolean {
  return process.env.PATTERM_DEBUG_TERMINAL === '1';
}

// ConPTY starts only .exe/.com files. Resolve npm-style .cmd shims to their
// target, or wrap other batch files in cmd.exe with a prebuilt command line.
function sidecarSpawnParams(params: unknown, env: NodeJS.ProcessEnv): unknown {
  if (process.platform !== 'win32' || !params || typeof params !== 'object') return params;
  const spawn = params as { command?: unknown; args?: unknown; env?: unknown };
  if (typeof spawn.command !== 'string') return params;
  const args = Array.isArray(spawn.args) ? spawn.args.filter((arg): arg is string => typeof arg === 'string') : [];
  const extra = spawn.env && typeof spawn.env === 'object' ? spawn.env as NodeJS.ProcessEnv : {};
  const resolved = resolveCommand(spawn.command, args, withEnv(env, extra));
  return { ...spawn, command: resolved.command, args: resolved.args, ...(resolved.verbatim ? { verbatim_args: true } : {}) };
}
