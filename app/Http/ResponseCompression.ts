import zlib from 'node:zlib';
import { promisify } from 'node:util';

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

export type ContentEncoding = 'br' | 'gzip';

// Smaller bodies fit in one packet whether or not they are compressed.
export const MIN_COMPRESSED_BYTES = 1024;

const COMPRESSIBLE_EXTENSIONS = new Set(['.html', '.js', '.css', '.svg', '.json', '.webmanifest', '.map', '.wasm', '.txt']);

export function isCompressibleFile(extension: string): boolean {
  return COMPRESSIBLE_EXTENSIONS.has(extension);
}

// The best encoding the client accepts, preferring Brotli, or null.
export function preferredEncoding(header: string | string[] | undefined): ContentEncoding | null {
  const accepted = new Map<string, number>();
  for (const part of (Array.isArray(header) ? header.join(',') : header ?? '').split(',')) {
    const [name, ...parameters] = part.trim().toLowerCase().split(';');
    if (!name) continue;
    const quality = parameters.map((parameter) => parameter.trim()).find((parameter) => parameter.startsWith('q='));
    accepted.set(name, quality ? Number(quality.slice(2)) : 1);
  }
  const allows = (name: string) => (accepted.get(name) ?? accepted.get('*') ?? 0) > 0;
  return allows('br') ? 'br' : allows('gzip') ? 'gzip' : null;
}

// `fast` suits per-request JSON. `small` suits files compressed once and
// served many times.
export function compress(body: Buffer, encoding: ContentEncoding, effort: 'fast' | 'small'): Promise<Buffer> {
  if (encoding === 'gzip') return gzip(body, { level: effort === 'fast' ? 6 : 9 });
  return brotli(body, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: effort === 'fast' ? 5 : 9,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length
    }
  });
}

// Compressed copies of static files. A file's size and modification time
// identify its contents, so a rebuilt renderer is compressed again.
export class CompressedFileCache {
  private readonly entries = new Map<string, Promise<Buffer>>();

  constructor(private readonly limit = 256) {}

  get(filename: string, stamp: string, body: Buffer, encoding: ContentEncoding): Promise<Buffer> {
    const key = `${filename}\0${stamp}\0${encoding}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = compress(body, encoding, 'small');
      this.entries.set(key, entry);
      entry.catch(() => this.entries.delete(key));
      while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
    }
    return entry;
  }
}
