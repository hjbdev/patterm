import fs from 'node:fs';
import path from 'node:path';

const MAX_DEBUG_LOG_BYTES = 10 * 1024 * 1024;
const MAX_DEBUG_LOG_ENTRY_BYTES = 64 * 1024;

export interface DebugLogEvent {
  source: string;
  event: string;
  data?: unknown;
}

export class DebugLogService {
  readonly filePath: string;
  private stream: fs.WriteStream | null = null;
  private bytesWritten = 0;

  constructor(appDataPath: string) {
    this.filePath = path.join(appDataPath, 'debug.log');
  }

  initialize(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    let existingSize = fs.existsSync(this.filePath) ? fs.statSync(this.filePath).size : 0;
    if (existingSize >= MAX_DEBUG_LOG_BYTES - MAX_DEBUG_LOG_ENTRY_BYTES) {
      fs.truncateSync(this.filePath, 0);
      existingSize = 0;
    }
    this.bytesWritten = existingSize;
    this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
    this.write('app', 'debug-log.started', { filePath: this.filePath, pid: process.pid });
  }

  write(source: string, event: string, data?: unknown): void {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      source,
      event,
      data: sanitizeForJson(data)
    });
    const bytes = Buffer.byteLength(line) + 1;
    if (bytes > MAX_DEBUG_LOG_ENTRY_BYTES || this.bytesWritten + bytes > MAX_DEBUG_LOG_BYTES) return;

    this.stream?.write(`${line}\n`);
    this.bytesWritten += bytes;
  }

  writeMany(events: DebugLogEvent[]): void {
    for (const event of events) {
      this.write(event.source, event.event, event.data);
    }
  }

  dispose(): void {
    this.write('app', 'debug-log.stopped', { filePath: this.filePath });
    this.stream?.end();
    this.stream = null;
    this.bytesWritten = 0;
  }
}

function sanitizeForJson(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { type: 'Uint8Array', byteLength: value.byteLength };
  }
  if (Buffer.isBuffer(value)) {
    return { type: 'Buffer', byteLength: value.byteLength };
  }
  return value;
}
