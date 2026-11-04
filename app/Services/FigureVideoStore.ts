import { createHash, randomUUID } from 'node:crypto';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';

export const MAX_FIGURE_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_STORED_BYTES = 1024 * 1024 * 1024;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const HEADER_BYTES = 64;
const EXTENSIONS: Record<string, string> = { 'video/mp4': 'mp4', 'video/webm': 'webm' };
const SHA256 = /^[0-9a-f]{64}$/;
// HEIF and AVIF stills share MP4's container.
const STILL_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1', 'avif', 'avis']);

export interface FigureVideoRef { sha256: string; mime: string; size: number }

// The container a file's first bytes declare: MP4 (ISO base media) or WebM.
// The codecs inside are the browser's to play or refuse.
export function sniffVideo(header: Buffer): string | null {
  if (header.length >= 12 && header.subarray(4, 8).toString('ascii') === 'ftyp') {
    return STILL_BRANDS.has(header.subarray(8, 12).toString('ascii')) ? null : 'video/mp4';
  }
  if (header.length >= 4 && header.readUInt32BE(0) === 0x1a45dfa3) {
    // The EBML header names its DocType near the start.
    const doctype = header.indexOf(Buffer.from([0x42, 0x82]));
    if (doctype > 0 && doctype + 3 < header.length) {
      const length = header[doctype + 2]! & 0x7f;
      if (header.subarray(doctype + 3, doctype + 3 + length).toString('ascii') === 'webm') return 'video/webm';
    }
  }
  return null;
}

// Temporary, content-addressed copies of local videos agents show in HTML
// figures. Videos are far larger than transcript images, so they have their
// own directory and budget, are copied and hashed as streams instead of read
// whole, and are served as bytes rather than base64.
export class FigureVideoStore {
  private stored = 0;
  private readonly files = new Map<string, FigureVideoRef>();

  constructor(readonly directory: string) {}

  async fromFile(filename: string): Promise<FigureVideoRef | null> {
    if (!filename || filename.includes('\0')) return null;
    let source: FileHandle;
    try { source = await fs.open(filename, 'r'); } catch { return null; }
    let temporary: string | null = null;
    try {
      const stat = await source.stat();
      if (!stat.isFile() || !stat.size || stat.size > MAX_FIGURE_VIDEO_BYTES) return null;
      const key = `${filename}\0${stat.size}\0${stat.mtimeMs}`;
      const cached = this.files.get(key);
      if (cached && await this.touch(cached)) return cached;
      const header = Buffer.alloc(HEADER_BYTES);
      const { bytesRead } = await source.read(header, 0, HEADER_BYTES, 0);
      const mime = sniffVideo(header.subarray(0, bytesRead));
      if (!mime) return null;
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      // The copy is hashed as it is written, so the stored bytes are the
      // hashed ones even if the source changes meanwhile.
      temporary = path.join(this.directory, `.${randomUUID()}.part`);
      const target = await fs.open(temporary, 'wx', 0o600);
      const hash = createHash('sha256');
      let size = 0;
      try {
        for await (const chunk of source.createReadStream({ highWaterMark: 1024 * 1024, autoClose: false }) as AsyncIterable<Buffer>) {
          size += chunk.length;
          if (size > MAX_FIGURE_VIDEO_BYTES) return null;
          hash.update(chunk);
          await target.write(chunk);
        }
      } finally {
        await target.close();
      }
      const video = { sha256: hash.digest('hex'), mime, size };
      if (!await this.touch(video)) await fs.rename(temporary, this.filename(video.sha256, mime));
      this.files.set(key, video);
      if (this.files.size > 200) this.files.delete(this.files.keys().next().value!);
      if (this.stored++ % 20 === 0) await this.prune();
      return video;
    } catch {
      return null;
    } finally {
      await source.close().catch(() => {});
      if (temporary) await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  // Where a stored video is, checked again so a replaced file is not served
  // as something else.
  async locate(sha256: string): Promise<{ filename: string; mime: string; size: number } | null> {
    if (typeof sha256 !== 'string' || !SHA256.test(sha256)) return null;
    for (const mime of Object.keys(EXTENSIONS)) {
      const filename = this.filename(sha256, mime);
      let handle: FileHandle;
      try { handle = await fs.open(filename, 'r'); } catch { continue; }
      try {
        const stat = await handle.stat();
        const header = Buffer.alloc(HEADER_BYTES);
        const { bytesRead } = await handle.read(header, 0, HEADER_BYTES, 0);
        return stat.isFile() && stat.size <= MAX_FIGURE_VIDEO_BYTES && sniffVideo(header.subarray(0, bytesRead)) === mime ? { filename, mime, size: stat.size } : null;
      } finally {
        await handle.close();
      }
    }
    return null;
  }

  async read(sha256: string): Promise<{ mime: string; bytes: Buffer } | null> {
    const video = await this.locate(sha256);
    if (!video) return null;
    const bytes = await fs.readFile(video.filename).catch(() => null);
    return bytes && sniffVideo(bytes.subarray(0, HEADER_BYTES)) === video.mime ? { mime: video.mime, bytes } : null;
  }

  async prune(now = Date.now()): Promise<void> {
    let names: string[];
    try { names = await fs.readdir(this.directory); } catch { return; }
    const entries: Array<{ filename: string; size: number; mtime: number }> = [];
    for (const name of names) {
      const filename = path.join(this.directory, name);
      try {
        const stat = await fs.stat(filename);
        if (stat.isFile()) entries.push({ filename, size: stat.size, mtime: stat.mtimeMs });
      } catch { /* Removed meanwhile. */ }
    }
    let total = 0;
    const kept: typeof entries = [];
    for (const entry of entries) {
      // A partial copy older than a day was abandoned by a crash.
      const limit = entry.filename.endsWith('.part') ? 24 * 60 * 60 * 1000 : RETENTION_MS;
      if (now - entry.mtime > limit) await fs.rm(entry.filename, { force: true });
      else { total += entry.size; kept.push(entry); }
    }
    for (const entry of kept.sort((left, right) => left.mtime - right.mtime)) {
      if (total <= MAX_STORED_BYTES) break;
      if (entry.filename.endsWith('.part')) continue;
      await fs.rm(entry.filename, { force: true });
      total -= entry.size;
    }
  }

  private filename(sha256: string, mime: string): string {
    return path.join(this.directory, `${sha256}.${EXTENSIONS[mime]}`);
  }

  // A repeat keeps the existing copy fresh for retention.
  private async touch(video: FigureVideoRef): Promise<boolean> {
    try { const now = new Date(); await fs.utimes(this.filename(video.sha256, video.mime), now, now); return true; }
    catch { return false; }
  }
}
