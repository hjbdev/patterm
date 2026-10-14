import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { verifyMinisign } from './Minisign';
import type { SettingsService, UpdateRecord, UpdateSettings } from './SettingsService';

export const RELEASE_REPO = 'hjbdev/patterm';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 30_000;
const FETCH_TIMEOUT_MS = 30_000;
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

// A release package, recognised by the BUILD file and signing key that
// scripts/release/package*.{sh,mjs} put in it. Source checkouts have neither.
export interface ReleaseInstall {
  platform: 'linux' | 'macos' | 'windows';
  arch: string;
  root: string;
  version: string;
  publicKey: string;
}

export function detectReleaseInstall(root: string | undefined, platform: NodeJS.Platform = process.platform, arch: string = process.arch): ReleaseInstall | null {
  if (!root) return null;
  const name = platform === 'linux' ? 'linux' : platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : null;
  if (!name) return null;
  try {
    const version = /^version=(.+)$/m.exec(fs.readFileSync(path.join(root, 'BUILD'), 'utf8'))?.[1]?.trim();
    // The .pub file's last line is the key; the first is a comment.
    const publicKey = fs.readFileSync(path.join(root, 'scripts', 'minisign.pub'), 'utf8').trim().split('\n').at(-1)?.trim();
    if (!version || !VERSION.test(version) || !publicKey) return null;
    return { platform: name, arch, root, version, publicKey };
  } catch {
    return null;
  }
}

// Semantic version precedence, including numeric prerelease identifiers.
// Mirrors version_lt in the installers.
export function compareVersions(left: string, right: string): number {
  const [leftCore = '', leftPre] = splitVersion(left);
  const [rightCore = '', rightPre] = splitVersion(right);
  const core = compareIdentifiers(leftCore, rightCore);
  if (core) return core;
  if (leftPre === rightPre) return 0;
  if (leftPre === undefined) return 1;
  if (rightPre === undefined) return -1;
  return compareIdentifiers(leftPre, rightPre);
}

function splitVersion(version: string): [string, string | undefined] {
  const dash = version.indexOf('-');
  return dash < 0 ? [version, undefined] : [version.slice(0, dash), version.slice(dash + 1)];
}

function compareIdentifiers(left: string, right: string): number {
  const a = left.split('.');
  const b = right.split('.');
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const x = a[index]!;
    const y = b[index]!;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Number(x) < Number(y) ? -1 : 1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return Math.sign(a.length - b.length);
}

// scripts/release/manifest.mjs writes one name and checksum per package.
const manifestInput = z.object({
  version: z.string().regex(VERSION),
  prerelease: z.boolean(),
  commit: z.string(),
  published_at: z.string()
}).passthrough();

export interface ReleaseManifest {
  version: string;
  prerelease: boolean;
  publishedAt: string;
  packages: Record<string, { file: string; sha256: string }>;
}

export function parseManifest(publicKey: string, body: Buffer, signature: string, expectedVersion?: string): ReleaseManifest {
  const trusted = verifyMinisign(publicKey, body, signature);
  const raw = manifestInput.parse(JSON.parse(body.toString('utf8')));
  // The release workflow signs with "patterm <version>" as the trusted comment.
  if (trusted !== `patterm ${raw.version}`) throw new Error('The release signature names a different version');
  if (expectedVersion && raw.version !== expectedVersion) throw new Error(`The manifest is for ${raw.version}, not ${expectedVersion}`);
  const packages: ReleaseManifest['packages'] = {};
  for (const [key, value] of Object.entries(raw)) {
    const sha256 = raw[`${key}-sha256`];
    if (/^(linux|macos|windows)-[a-z0-9]+$/.test(key) && typeof value === 'string' && typeof sha256 === 'string' && /^[0-9a-f]{64}$/.test(sha256)) {
      packages[key] = { file: value, sha256 };
    }
  }
  return { version: raw.version, prerelease: raw.prerelease, publishedAt: raw.published_at, packages };
}

export type UpdateStatus = 'idle' | 'checking' | 'up_to_date' | 'available' | 'installing' | 'error';

export interface UpdateState {
  supported: boolean;
  currentVersion: string | null;
  settings: UpdateSettings;
  status: UpdateStatus;
  checkedAt: string | null;
  error: string | null;
  latest: { version: string; prerelease: boolean; publishedAt: string; notesUrl: string } | null;
  // Whether this install can apply the update itself, and why not.
  canApply: boolean;
  applyUnavailable: string | null;
  // What restarting to update stops, for the confirmation.
  restartDetail: string;
}

// Starts the platform installer for a verified release. See UpdateInstaller.
export interface UpdateApplier {
  unavailable(): string | null;
  // `done` settles when an installer this process waits on finishes.
  apply(release: { version: string; sha256: string }): Promise<{ quit: boolean; log: string; done?: Promise<void> }>;
}

export interface UpdateServiceOptions {
  install: ReleaseInstall | null;
  settings: Pick<SettingsService, 'updateSettings' | 'saveUpdateSettings' | 'updateRecord' | 'saveUpdateRecord'>;
  applier: UpdateApplier | null;
  restartDetail: () => string;
  notify: (release: { version: string; canApply: boolean }) => void;
  changed: () => void;
  fetch?: typeof fetch;
  releasesUrl?: string;
  apiUrl?: string;
  now?: () => Date;
}

export class UpdateService {
  private status: UpdateStatus = 'idle';
  private checkedAt: string | null = null;
  private error: string | null = null;
  private manifest: ReleaseManifest | null = null;
  private checking: Promise<UpdateState> | null = null;
  private firstCheck: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;
  private readonly fetch: typeof fetch;
  private readonly releasesUrl: string;
  private readonly apiUrl: string;
  private readonly now: () => Date;

  constructor(private readonly options: UpdateServiceOptions) {
    this.fetch = options.fetch ?? fetch;
    this.releasesUrl = (options.releasesUrl ?? `https://github.com/${RELEASE_REPO}/releases`).replace(/\/$/, '');
    this.apiUrl = options.apiUrl ?? `https://api.github.com/repos/${RELEASE_REPO}/releases`;
    this.now = options.now ?? (() => new Date());
    this.confirmPendingUpdate();
  }

  // Checks shortly after startup and then every few hours while automatic
  // checks are on. A source checkout never checks.
  start(): void {
    if (!this.options.install) return;
    const tick = () => { if (this.options.settings.updateSettings().autoCheck) void this.check().catch(() => undefined); };
    this.firstCheck = setTimeout(tick, FIRST_CHECK_DELAY_MS);
    this.firstCheck.unref();
    this.interval = setInterval(tick, CHECK_INTERVAL_MS);
    this.interval.unref();
  }

  dispose(): void {
    if (this.firstCheck) clearTimeout(this.firstCheck);
    if (this.interval) clearInterval(this.interval);
    this.firstCheck = this.interval = null;
  }

  state(): UpdateState {
    const install = this.options.install;
    const settings = this.options.settings.updateSettings();
    const manifest = this.status === 'available' || this.status === 'installing' ? this.manifest : null;
    const latest = manifest
      ? { version: manifest.version, prerelease: manifest.prerelease, publishedAt: manifest.publishedAt, notesUrl: `${this.releasesUrl}/tag/v${manifest.version}` }
      : null;
    const applyUnavailable = !install ? 'This copy of Patterm was built from source, so it updates with git.'
      : manifest && !this.packageFor(manifest) ? `This release has no package for ${install.platform}-${install.arch}.`
      : this.options.applier?.unavailable() ?? (this.options.applier ? null : 'This install cannot update itself.');
    return {
      supported: Boolean(install),
      currentVersion: install?.version ?? null,
      settings,
      status: this.status,
      checkedAt: this.checkedAt,
      error: this.error,
      latest,
      canApply: Boolean(latest) && this.status === 'available' && !applyUnavailable,
      applyUnavailable,
      restartDetail: this.options.restartDetail()
    };
  }

  updateSettings(input: unknown): UpdateState {
    const before = this.options.settings.updateSettings();
    const saved = this.options.settings.saveUpdateSettings({ ...before, ...(input as object) });
    // A changed channel makes the last result stale.
    if (saved.channel !== before.channel && this.status !== 'installing') {
      this.manifest = null;
      this.status = 'idle';
      if (saved.autoCheck) void this.check().catch(() => undefined);
    } else if (saved.autoCheck && !before.autoCheck && !this.checkedAt) {
      void this.check().catch(() => undefined);
    }
    return this.state();
  }

  check(): Promise<UpdateState> {
    if (!this.options.install) return Promise.resolve(this.state());
    if (this.status === 'installing') return Promise.resolve(this.state());
    return this.checking ??= this.runCheck().finally(() => { this.checking = null; });
  }

  async apply(): Promise<{ quit: boolean; state: UpdateState }> {
    const install = this.options.install;
    const applier = this.options.applier;
    if (!install || !applier) throw new Error(this.state().applyUnavailable ?? 'This install cannot update itself');
    if (this.status === 'installing') throw new Error('An update is already being installed');
    // Check again so a stale result never installs a release the owner has
    // not seen, or one that has since been replaced.
    await this.check();
    const state = this.state();
    if (state.status !== 'available' || !this.manifest) throw new Error(state.error ?? 'No update is available');
    if (!state.canApply) throw new Error(state.applyUnavailable ?? 'This install cannot update itself');
    const target = this.packageFor(this.manifest)!;
    const version = this.manifest.version;
    this.status = 'installing';
    this.error = null;
    this.options.changed();
    try {
      const startedAt = this.now().toISOString();
      // Recorded first: the installer may stop this process before it returns.
      const record = this.options.settings.updateRecord();
      this.options.settings.saveUpdateRecord({ ...record, pending: { version, from: install.version, startedAt, log: '' } });
      const result = await applier.apply({ version, sha256: target.sha256 });
      this.options.settings.saveUpdateRecord({ ...this.options.settings.updateRecord(), pending: { version, from: install.version, startedAt, log: result.log } });
      result.done?.then(() => {
        // Finished without restarting this process; the next check shows what is installed.
        this.options.settings.saveUpdateRecord({ ...this.options.settings.updateRecord(), pending: null });
        this.status = 'idle';
        this.options.changed();
      }, (error: unknown) => this.failed(version, error));
      return { quit: result.quit, state: this.state() };
    } catch (error) {
      this.failed(version, error);
      throw error;
    }
  }

  private failed(version: string, error: unknown): void {
    this.options.settings.saveUpdateRecord({ ...this.options.settings.updateRecord(), pending: null });
    this.status = 'error';
    this.error = `Could not install Patterm ${version}: ${message(error)}`;
    this.options.changed();
  }

  private async runCheck(): Promise<UpdateState> {
    const install = this.options.install!;
    this.status = 'checking';
    this.options.changed();
    try {
      const { channel } = this.options.settings.updateSettings();
      const manifest = channel === 'prerelease' ? await this.newestManifest(install) : await this.manifestAt(install, `${this.releasesUrl}/latest/download`);
      this.checkedAt = this.now().toISOString();
      this.error = null;
      const newer = manifest && compareVersions(manifest.version, install.version) > 0 && (channel === 'prerelease' || !manifest.prerelease);
      this.manifest = newer ? manifest : null;
      this.status = newer ? 'available' : 'up_to_date';
      if (newer) this.announce(manifest.version);
    } catch (error) {
      this.checkedAt = this.now().toISOString();
      this.status = 'error';
      this.error = `Could not check for updates: ${message(error)}`;
    }
    this.options.changed();
    return this.state();
  }

  // GitHub's latest release skips prereleases, so list releases instead.
  private async newestManifest(install: ReleaseInstall): Promise<ReleaseManifest | null> {
    const response = await this.request(`${this.apiUrl}?per_page=30`, { Accept: 'application/vnd.github+json' });
    const releases = z.array(z.object({ tag_name: z.string(), draft: z.boolean().optional() }).passthrough()).parse(await response.json());
    const versions = releases.filter((release) => !release.draft && /^v/.test(release.tag_name) && VERSION.test(release.tag_name.slice(1)))
      .map((release) => release.tag_name.slice(1))
      .sort(compareVersions);
    const newest = versions.at(-1);
    if (!newest) return null;
    return this.manifestAt(install, `${this.releasesUrl}/download/v${newest}`, newest);
  }

  private async manifestAt(install: ReleaseInstall, base: string, expectedVersion?: string): Promise<ReleaseManifest> {
    const [body, signature] = await Promise.all([
      this.request(`${base}/manifest.json`).then(async (response) => Buffer.from(await response.arrayBuffer())),
      this.request(`${base}/manifest.json.minisig`).then((response) => response.text())
    ]);
    return parseManifest(install.publicKey, body, signature, expectedVersion);
  }

  private async request(url: string, headers: Record<string, string> = {}): Promise<Response> {
    const response = await this.fetch(url, { headers: { 'User-Agent': 'Patterm updater', ...headers }, redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`${new URL(url).pathname} returned ${response.status}`);
    return response;
  }

  private packageFor(manifest: ReleaseManifest | null): { file: string; sha256: string } | null {
    const install = this.options.install;
    if (!install || !manifest) return null;
    return manifest.packages[`${install.platform}-${install.arch}`] ?? null;
  }

  // Each release is announced once, even across restarts.
  private announce(version: string): void {
    const record = this.options.settings.updateRecord();
    if (record.notifiedVersion === version) return;
    this.options.settings.saveUpdateRecord({ ...record, notifiedVersion: version });
    this.options.notify({ version, canApply: this.state().canApply });
  }

  // An installer runs after this process stops, so the next launch learns
  // whether it worked.
  private confirmPendingUpdate(): void {
    const install = this.options.install;
    const record = this.options.settings.updateRecord();
    if (!install || !record.pending) return;
    this.options.settings.saveUpdateRecord({ ...record, pending: null });
    if (compareVersions(install.version, record.pending.version) >= 0) return;
    this.status = 'error';
    this.error = `Patterm ${record.pending.version} was not installed.${record.pending.log ? ` See ${record.pending.log}.` : ''}`;
  }
}

function message(error: unknown): string {
  if (error instanceof z.ZodError) return 'the release manifest is malformed';
  return error instanceof Error ? error.message : String(error);
}
