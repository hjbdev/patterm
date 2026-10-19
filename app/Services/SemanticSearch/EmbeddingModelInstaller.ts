import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EMBEDDING_MODEL, embeddingModelDirectory } from './EmbeddingModel';

export interface EmbeddingModelManifest { id: string; fileName: string; url: string; bytes: number; sha256: string; }

export type ModelInstallState =
  | { status: 'absent' }
  | { status: 'downloading'; receivedBytes: number; totalBytes: number }
  | { status: 'verifying' }
  | { status: 'installed' }
  | { status: 'error'; error: string };

const MARKER = 'installed.json';
const PROGRESS_INTERVAL_MS = 500;

// Downloads the pinned model on request only. The file is written beside its
// final name, checked against the pinned size and SHA-256, flushed, and then
// renamed into place, so a crash or a cancelled download never leaves a
// file that looks installed.
export class EmbeddingModelInstaller {
  private current: ModelInstallState;
  private abort: AbortController | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly appDataPath: string,
    private readonly onChange: () => void,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly manifest: EmbeddingModelManifest = EMBEDDING_MODEL
  ) {
    this.current = this.installedOnDisk() ? { status: 'installed' } : { status: 'absent' };
  }

  get directory(): string {
    return embeddingModelDirectory(this.appDataPath);
  }

  get modelPath(): string {
    return path.join(this.directory, this.manifest.fileName);
  }

  state(): ModelInstallState {
    return this.current;
  }

  get installed(): boolean {
    return this.current.status === 'installed';
  }

  // Starts a download unless one is running or the model is installed.
  install(): ModelInstallState {
    if (this.running || this.installed) return this.current;
    const abort = new AbortController();
    this.abort = abort;
    this.set({ status: 'downloading', receivedBytes: 0, totalBytes: this.manifest.bytes });
    this.running = this.download(abort.signal)
      .then(() => this.set({ status: 'installed' }))
      .catch((error: unknown) => {
        this.set(abort.signal.aborted ? { status: 'absent' } : { status: 'error', error: errorMessage(error) });
      })
      .finally(() => {
        this.running = null;
        this.abort = null;
      });
    return this.current;
  }

  cancel(): ModelInstallState {
    this.abort?.abort();
    return this.current;
  }

  // Resolves once any running download has stopped.
  async settled(): Promise<void> {
    await this.running;
  }

  async remove(): Promise<void> {
    this.abort?.abort();
    await this.running;
    await fs.promises.rm(this.directory, { recursive: true, force: true });
    this.set({ status: 'absent' });
  }

  private async download(signal: AbortSignal): Promise<void> {
    await fs.promises.mkdir(this.directory, { recursive: true });
    const partial = `${this.modelPath}.partial`;
    await fs.promises.rm(path.join(this.directory, MARKER), { force: true });
    try {
      const response = await this.fetchImpl(this.manifest.url, { signal, redirect: 'follow' });
      if (!response.ok || !response.body) throw new Error(`Download failed with HTTP ${response.status}`);
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > 0 && declared !== this.manifest.bytes) {
        throw new Error(`The download is ${declared} bytes; expected ${this.manifest.bytes}`);
      }
      const hash = createHash('sha256');
      const file = await fs.promises.open(partial, 'w');
      let received = 0;
      let reported = 0;
      try {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > this.manifest.bytes) throw new Error('The download is larger than the pinned model');
          hash.update(value);
          // A write may persist only part of the chunk; the hash covers all of it.
          for (let offset = 0; offset < value.byteLength;) offset += (await file.write(value, offset)).bytesWritten;
          if (Date.now() - reported >= PROGRESS_INTERVAL_MS) {
            reported = Date.now();
            this.set({ status: 'downloading', receivedBytes: received, totalBytes: this.manifest.bytes });
          }
        }
        await file.sync();
      } finally {
        await file.close();
      }
      this.set({ status: 'verifying' });
      if (received !== this.manifest.bytes) throw new Error(`The download stopped at ${received} of ${this.manifest.bytes} bytes`);
      const digest = hash.digest('hex');
      if (digest !== this.manifest.sha256) throw new Error('The downloaded model does not match its pinned SHA-256');
      // Windows cannot rename over an unverified leftover.
      await fs.promises.rm(this.modelPath, { force: true });
      await fs.promises.rename(partial, this.modelPath);
      await writeFileAtomic(path.join(this.directory, MARKER), JSON.stringify({ id: this.manifest.id, sha256: digest, bytes: received, installedAt: new Date().toISOString() }));
    } catch (error) {
      await fs.promises.rm(partial, { force: true });
      throw error;
    }
  }

  // The marker is written only after the hash check, so a matching marker
  // and file size mean the bytes were verified when installed.
  private installedOnDisk(): boolean {
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(this.directory, MARKER), 'utf8')) as { id?: unknown; sha256?: unknown };
      return marker.id === this.manifest.id && marker.sha256 === this.manifest.sha256 && fs.statSync(this.modelPath).size === this.manifest.bytes;
    } catch {
      return false;
    }
  }

  private set(state: ModelInstallState): void {
    this.current = state;
    this.onChange();
  }
}

async function writeFileAtomic(target: string, contents: string): Promise<void> {
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await fs.promises.writeFile(temporary, contents, { flag: 'w' });
    await fs.promises.rename(temporary, target);
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
