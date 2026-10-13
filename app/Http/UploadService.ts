import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathContains } from '../Platform/PathIdentity';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_STORED_BYTES = 256 * 1024 * 1024;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/;
const TEXT_MIME = /^text\/|^application\/(json|ld\+json|toml|x-toml|yaml|x-yaml|xml)$/;

export interface StoredUpload {
  path: string;
  name: string;
  mime: string;
  size: number;
  // Base64 content for inline transports, so they send the exact bytes that
  // were validated instead of re-reading a path that may have changed.
  data?: string | undefined;
}

export function isSupportedAttachmentMime(mime: string): boolean {
  return IMAGE_MIME.test(mime) || TEXT_MIME.test(mime) || mime === 'application/pdf';
}

// Full bounded content decides the type. A NUL byte anywhere or invalid UTF-8
// rejects text, so provider-side binary drops cannot happen silently. A `.png`
// that actually holds SVG, HTML, or a ZIP must not become an image attachment.
export function sniffMime(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  const header = buffer.length >= 6 ? buffer.subarray(0, 6).toString('ascii') : '';
  if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  // Archive and executable containers stay rejected regardless of extension.
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && [0x03, 0x05, 0x07].includes(buffer[2]!)) return null;
  if (buffer.length >= 4 && buffer[0] === 0x7f && buffer.subarray(1, 4).toString('ascii') === 'ELF') return null;
  if (looksLikeUtf8Text(buffer)) return 'text/plain';
  return null;
}

export class UploadService {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly directory: string) {}

  save(name: string, body: Buffer): Promise<string> {
    const result = this.queue.then(() => this.store(name, body));
    this.queue = result.catch(() => {});
    return result;
  }

  // Describe a previously stored upload for provider delivery. The store is
  // shared by the same owner across Patterm sessions; containment and content
  // validation happen here rather than trusting renderer-supplied paths or MIME.
  async describe(candidate: string, suppliedName?: string): Promise<StoredUpload> {
    if (typeof candidate !== 'string' || !candidate || candidate.includes('\0')) throw new Error('Invalid attachment');
    const root = await fs.realpath(this.directory).catch(() => null);
    if (!root) throw new Error('Attachment storage is unavailable');
    const real = await fs.realpath(candidate).catch(() => null);
    if (!real || !pathContains(root, real)) throw new Error('Attachment is not a managed upload');
    const stat = await fs.stat(real);
    if (!stat.isFile()) throw new Error('Attachment is not a file');
    if (stat.size > MAX_UPLOAD_BYTES) throw new Error('Attachments must be at most 10 MiB');
    const buffer = await fs.readFile(real);
    const mime = sniffMime(buffer);
    if (!mime) throw new Error('Attachment content is not text or a supported image or PDF');
    if (!isSupportedAttachmentMime(mime)) throw new Error('Attachment content is not a supported type');
    const name = suppliedName?.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255) || path.basename(real);
    return { path: real, name, mime, size: stat.size, data: buffer.toString('base64') };
  }

  private async store(name: string, body: Buffer): Promise<string> {
    if (body.length > MAX_UPLOAD_BYTES) throw new Error('Files must be at most 10 MiB');
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    let total = 0;
    let count = 0;
    for (const entry of await fs.readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const filename = path.join(this.directory, entry.name);
      const stat = await fs.stat(filename);
      if (Date.now() - stat.mtimeMs > RETENTION_MS) await fs.unlink(filename);
      else { total += stat.size; count++; }
    }
    if (total + body.length > MAX_STORED_BYTES || count >= 1000) {
      throw new Error('Upload storage is full. Remove unused files from the server uploads directory.');
    }
    const safeName = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'attachment';
    const filename = path.join(this.directory, `${randomUUID()}-${safeName}`);
    await fs.writeFile(filename, body, { flag: 'wx', mode: 0o600 });
    return filename;
  }
}

function looksLikeUtf8Text(buffer: Buffer): boolean {
  // Trust the whole bounded buffer: NUL or invalid UTF-8 anywhere means binary.
  if (buffer.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}
