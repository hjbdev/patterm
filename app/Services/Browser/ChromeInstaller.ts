import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import yauzl from 'yauzl';

// Chrome for Testing is published under Google's Chrome terms, so Patterm
// downloads it from Google on first use instead of shipping it.
export const CHROME_VERSIONS_URL = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';

export type ChromeInstallState =
  | { status: 'absent' }
  | { status: 'downloading'; version: string; receivedBytes: number; totalBytes: number }
  | { status: 'extracting'; version: string }
  | { status: 'installed'; version: string }
  | { status: 'error'; error: string };

export interface InstalledChrome { version: string; executable: string }

const MARKER = 'installed.json';
const PROGRESS_INTERVAL_MS = 500;

// Chrome for Testing's name for this machine, or null where none is built.
export function chromePlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  if (platform === 'linux') return arch === 'x64' ? 'linux64' : arch === 'arm64' ? 'linux-arm64' : null;
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (platform === 'win32') return arch === 'x64' ? 'win64' : arch === 'ia32' ? 'win32' : null;
  return null;
}

// Where the executable sits inside the extracted archive.
export function chromeExecutable(directory: string, platform: string): string {
  if (platform.startsWith('mac')) return path.join(directory, `chrome-${platform}`, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
  if (platform.startsWith('win')) return path.join(directory, `chrome-${platform}`, 'chrome.exe');
  return path.join(directory, `chrome-${platform}`, 'chrome');
}

// Downloads the current stable Chrome for Testing once, verifies it against
// the MD5 Google's storage reports for it, and extracts it beside a marker
// written last, so an interrupted install never looks installed.
export class ChromeInstaller {
  private current: ChromeInstallState;
  private running: Promise<InstalledChrome> | null = null;

  constructor(
    private readonly directory: string,
    private readonly onChange: () => void,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly platform: string | null = chromePlatform()
  ) {
    const installed = this.installedOnDisk();
    this.current = installed ? { status: 'installed', version: installed.version } : { status: 'absent' };
  }

  state(): ChromeInstallState {
    return this.current;
  }

  installed(): InstalledChrome | null {
    return this.installedOnDisk();
  }

  // The installed Chrome, downloading it first if needed. Concurrent callers
  // share one download.
  ensure(): Promise<InstalledChrome> {
    const installed = this.installedOnDisk();
    if (installed) return Promise.resolve(installed);
    this.running ??= this.download()
      .then((chrome) => { this.set({ status: 'installed', version: chrome.version }); return chrome; })
      .catch((error: unknown) => { this.set({ status: 'error', error: errorMessage(error) }); throw error; })
      .finally(() => { this.running = null; });
    return this.running;
  }

  private async download(): Promise<InstalledChrome> {
    const platform = this.platform;
    if (!platform) throw new Error(`Chrome for Testing is not available for ${process.platform} ${process.arch}`);
    const versions = await this.fetchImpl(CHROME_VERSIONS_URL);
    if (!versions.ok) throw new Error(`Could not read Chrome versions: HTTP ${versions.status}`);
    const stable = (await versions.json() as { channels?: { Stable?: { version?: string; downloads?: { chrome?: Array<{ platform: string; url: string }> } } } }).channels?.Stable;
    const url = stable?.downloads?.chrome?.find((download) => download.platform === platform)?.url;
    if (!stable?.version || !/^[\d.]+$/.test(stable.version) || !url) throw new Error(`No stable Chrome for Testing download for ${platform}`);
    const version = stable.version;

    await fs.promises.mkdir(this.directory, { recursive: true });
    const archive = path.join(this.directory, `chrome-${version}.zip.partial`);
    const target = path.join(this.directory, version);
    const staging = `${target}.partial`;
    try {
      const response = await this.fetchImpl(url, { redirect: 'follow' });
      if (!response.ok || !response.body) throw new Error(`Chrome download failed with HTTP ${response.status}`);
      const total = Number(response.headers.get('content-length')) || 0;
      const expectedMd5 = googleMd5(response.headers);
      const hash = createHash('md5');
      const file = await fs.promises.open(archive, 'w');
      let received = 0, reported = 0;
      this.set({ status: 'downloading', version, receivedBytes: 0, totalBytes: total });
      try {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          hash.update(value);
          for (let offset = 0; offset < value.byteLength;) offset += (await file.write(value, offset)).bytesWritten;
          if (Date.now() - reported >= PROGRESS_INTERVAL_MS) {
            reported = Date.now();
            this.set({ status: 'downloading', version, receivedBytes: received, totalBytes: total });
          }
        }
      } finally {
        await file.close();
      }
      if (total && received !== total) throw new Error(`The Chrome download stopped at ${received} of ${total} bytes`);
      if (expectedMd5 && hash.digest('base64') !== expectedMd5) throw new Error('The Chrome download does not match its published MD5');
      this.set({ status: 'extracting', version });
      await fs.promises.rm(staging, { recursive: true, force: true });
      await extractZip(archive, staging);
      await fs.promises.rm(target, { recursive: true, force: true });
      await fs.promises.rename(staging, target);
      const executable = chromeExecutable(target, platform);
      await fs.promises.access(executable, fs.constants.X_OK);
      // A torn marker fails to parse and reads as not installed.
      await fs.promises.writeFile(path.join(this.directory, MARKER), JSON.stringify({ version, platform, installedAt: new Date().toISOString() }));
      await this.removeOtherVersions(version);
      return { version, executable };
    } finally {
      await fs.promises.rm(archive, { force: true });
      await fs.promises.rm(staging, { recursive: true, force: true });
    }
  }

  private async removeOtherVersions(keep: string): Promise<void> {
    for (const entry of await fs.promises.readdir(this.directory, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== keep && /^[\d.]+$/.test(entry.name)) {
        await fs.promises.rm(path.join(this.directory, entry.name), { recursive: true, force: true });
      }
    }
  }

  private installedOnDisk(): InstalledChrome | null {
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(this.directory, MARKER), 'utf8')) as { version?: unknown; platform?: unknown };
      if (typeof marker.version !== 'string' || !/^[\d.]+$/.test(marker.version) || !this.platform || marker.platform !== this.platform) return null;
      const executable = chromeExecutable(path.join(this.directory, marker.version), this.platform);
      return fs.existsSync(executable) ? { version: marker.version, executable } : null;
    } catch {
      return null;
    }
  }

  private set(state: ChromeInstallState): void {
    this.current = state;
    this.onChange();
  }
}

// Google's storage reports `x-goog-hash: crc32c=…, md5=…`, sometimes as
// separate headers that fetch joins with a comma.
function googleMd5(headers: Headers): string | null {
  const match = /(?:^|[,\s])md5=([A-Za-z0-9+/=]+)/.exec(headers.get('x-goog-hash') ?? '');
  return match?.[1] ?? null;
}

// Extracts a zip, keeping executable bits and the symbolic links macOS app
// bundles use, and refusing anything that would land outside `destination`.
// A link may only point down from its own folder, as Chrome's do: no
// absolute target and no `..`, so no chain of links can climb out. Links are
// checked as they are read and made last, so no file is written through one.
export async function extractZip(archive: string, destination: string): Promise<void> {
  await fs.promises.mkdir(destination, { recursive: true });
  const root = await fs.promises.realpath(destination);
  const within = (candidate: string) => candidate === root || candidate.startsWith(root + path.sep);
  const links = await new Promise<Array<{ name: string; target: string; link: string }>>((resolve, reject) => {
    const found: Array<{ name: string; target: string; link: string }> = [];
    yauzl.open(archive, { lazyEntries: true, autoClose: true }, (openError, zip) => {
      if (openError || !zip) { reject(openError ?? new Error('Could not open the archive')); return; }
      const fail = (error: unknown) => { zip.close(); reject(error); };
      zip.on('error', fail);
      zip.on('end', () => resolve(found));
      zip.on('entry', (entry: yauzl.Entry) => {
        const target = path.resolve(root, entry.fileName);
        if (!within(target)) { fail(new Error(`Archive entry escapes its folder: ${entry.fileName}`)); return; }
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if (entry.fileName.endsWith('/')) {
          fs.promises.mkdir(target, { recursive: true }).then(() => zip.readEntry(), fail);
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) { fail(streamError ?? new Error('Could not read the archive')); return; }
          void (async () => {
            if ((mode & 0o170000) === 0o120000) {
              const chunks: Buffer[] = [];
              for await (const chunk of stream) chunks.push(chunk as Buffer);
              const link = Buffer.concat(chunks).toString('utf8');
              if (!pointsDown(link)) throw new Error(`Archive link leaves its folder: ${entry.fileName}`);
              found.push({ name: entry.fileName, target, link });
              return;
            }
            await fs.promises.mkdir(path.dirname(target), { recursive: true });
            await new Promise<void>((done, failed) => {
              const out = fs.createWriteStream(target, { mode: (mode & 0o777) || 0o644 });
              stream.on('error', failed);
              out.on('error', failed);
              out.on('close', () => done());
              stream.pipe(out);
            });
          })().then(() => zip.readEntry(), fail);
        });
      });
      zip.readEntry();
    });
  });
  for (const { name, target, link } of links) {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    if (!within(await fs.promises.realpath(path.dirname(target)))) throw new Error(`Archive link escapes its folder: ${name}`);
    await fs.promises.symlink(link, target);
  }
}

// A relative link target that only descends from the link's own folder.
function pointsDown(link: string): boolean {
  return link.length > 0 && !path.isAbsolute(link) && !/^[A-Za-z]:/.test(link) && !link.split(/[\\/]/).includes('..');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
