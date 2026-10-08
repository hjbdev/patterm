import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sniffMime } from '../Http/UploadService';

export const MAX_TRANSCRIPT_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_STORED_BYTES = 256 * 1024 * 1024;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// Pruning walks the directory, so it runs on the first store and then
// periodically instead of on every image.
const PRUNE_EVERY = 50;
const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const SHA256 = /^[0-9a-f]{64}$/;

// A transcript row carries this small reference instead of image bytes, so
// base64 never travels through conversation events or snapshots.
export interface TranscriptImageRef {
  type: 'image';
  sha256: string;
  mime: string;
  size: number;
  name?: string;
  width?: number;
  height?: number;
}

export function isTranscriptImageHash(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

// Temporary, content-addressed copies of images shown in Integrated
// transcripts: user uploads and images returned by tools. Only bytes a user or
// agent already handled are stored, and they are served by hash, never by a
// server path. The same screenshot read twice is stored once.
export class TranscriptImageStore {
  private stored = 0;
  // Snapshots re-project the same viewed file; an unchanged file is not read
  // and hashed again.
  private readonly files = new Map<string, TranscriptImageRef>();

  constructor(readonly directory: string) {}

  fromBase64(data: unknown, name?: string): TranscriptImageRef | null {
    if (typeof data !== 'string' || !data || data.length > Math.ceil(MAX_TRANSCRIPT_IMAGE_BYTES / 3) * 4) return null;
    return this.fromBuffer(Buffer.from(data, 'base64'), name);
  }

  fromDataUrl(url: unknown, name?: string): TranscriptImageRef | null {
    if (typeof url !== 'string') return null;
    const match = /^data:[^;,]*;base64,/.exec(url);
    return match ? this.fromBase64(url.slice(match[0].length), name) : null;
  }

  fromFile(filename: unknown, name?: string): TranscriptImageRef | null {
    if (typeof filename !== 'string' || !filename || filename.includes('\0')) return null;
    try {
      const stat = fs.statSync(filename);
      if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_IMAGE_BYTES) return null;
      const key = `${filename}\0${stat.size}\0${stat.mtimeMs}\0${name ?? ''}`;
      const cached = this.files.get(key);
      if (cached && fs.existsSync(path.join(this.directory, `${cached.sha256}.${EXTENSIONS[cached.mime]}`))) return cached;
      const image = this.fromBuffer(fs.readFileSync(filename), name ?? path.basename(filename));
      if (image) {
        this.files.set(key, image);
        if (this.files.size > 200) this.files.delete(this.files.keys().next().value!);
      }
      return image;
    } catch {
      return null;
    }
  }

  fromBuffer(buffer: Buffer, name?: string): TranscriptImageRef | null {
    if (!buffer.length || buffer.length > MAX_TRANSCRIPT_IMAGE_BYTES) return null;
    const mime = sniffMime(buffer);
    const extension = mime ? EXTENSIONS[mime] : undefined;
    if (!mime || !extension) return null;
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    try {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const filename = path.join(this.directory, `${sha256}.${extension}`);
      // A repeat keeps the existing copy fresh for retention.
      try { const now = new Date(); fs.utimesSync(filename, now, now); }
      catch { fs.writeFileSync(filename, buffer, { mode: 0o600 }); }
      if (this.stored++ % PRUNE_EVERY === 0) this.prune();
    } catch {
      return null;
    }
    const label = name?.replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).pop()?.trim().slice(0, 255);
    return { type: 'image', sha256, mime, size: buffer.length, ...(label ? { name: label } : {}) };
  }

  read(sha256: string): { mime: string; data: string } | null {
    if (!isTranscriptImageHash(sha256)) return null;
    for (const [mime, extension] of Object.entries(EXTENSIONS)) {
      let buffer: Buffer;
      try { buffer = fs.readFileSync(path.join(this.directory, `${sha256}.${extension}`)); }
      catch { continue; }
      // The stored type is checked again so a replaced file cannot be served
      // as something else.
      return sniffMime(buffer) === mime ? { mime, data: buffer.toString('base64') } : null;
    }
    return null;
  }

  prune(now = Date.now()): void {
    let entries: Array<{ filename: string; size: number; mtime: number }>;
    try {
      entries = fs.readdirSync(this.directory, { withFileTypes: true }).flatMap((entry) => {
        if (!entry.isFile()) return [];
        const filename = path.join(this.directory, entry.name);
        try {
          const stat = fs.statSync(filename);
          return [{ filename, size: stat.size, mtime: stat.mtimeMs }];
        } catch {
          return [];
        }
      });
    } catch {
      return;
    }
    let total = 0;
    const kept = entries.filter((entry) => {
      if (now - entry.mtime <= RETENTION_MS) { total += entry.size; return true; }
      fs.rmSync(entry.filename, { force: true });
      return false;
    }).sort((left, right) => left.mtime - right.mtime);
    for (const entry of kept) {
      if (total <= MAX_STORED_BYTES) break;
      fs.rmSync(entry.filename, { force: true });
      total -= entry.size;
    }
  }
}
