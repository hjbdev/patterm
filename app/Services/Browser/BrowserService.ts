import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { findExecutable } from '../../Platform/Executable';
import { stopChild } from '../../Platform/ServiceProcess';
import { CdpConnection, type CdpEvent } from './CdpConnection';
import type { ChromeInstaller, ChromeInstallState, InstalledChrome } from './ChromeInstaller';

export interface BrowserTab { targetId: string; url: string; title: string }

export interface BrowserFrame {
  seq: number;
  // A JPEG, base64-encoded.
  data: string;
  // The page area the frame shows, in CSS pixels, for mapping input.
  width: number;
  height: number;
  targetId: string;
}

export interface BrowserHelpRequest { reason: string; requestedAt: string }

export interface BrowserState {
  running: boolean;
  headed: boolean;
  version: string | null;
  install: ChromeInstallState;
  tabs: BrowserTab[];
  activeTargetId: string | null;
  help: BrowserHelpRequest | null;
}

export type BrowserMouseInput = {
  kind: 'mouse';
  type: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel';
  x: number;
  y: number;
  button?: 'none' | 'left' | 'middle' | 'right' | undefined;
  clickCount?: number | undefined;
  deltaX?: number | undefined;
  deltaY?: number | undefined;
  modifiers?: number | undefined;
};
export type BrowserKeyInput = {
  kind: 'key';
  type: 'keyDown' | 'keyUp' | 'rawKeyDown' | 'char';
  key?: string | undefined;
  code?: string | undefined;
  text?: string | undefined;
  windowsVirtualKeyCode?: number | undefined;
  modifiers?: number | undefined;
};
export type BrowserTextInput = { kind: 'text'; text: string };
export type BrowserInput = BrowserMouseInput | BrowserKeyInput | BrowserTextInput;

export interface BrowserServiceOptions {
  directory: string;
  installer: Pick<ChromeInstaller, 'ensure' | 'state'>;
  onChanged: () => void;
  // Tells the user an agent needs them in its browser, and clears that.
  raiseHelp: (processId: string, reason: string) => void;
  resolveHelp: (processId: string) => void;
  // Tells the agent the user is done.
  messageAgent: (processId: string, text: string) => Promise<unknown>;
  // Whether a session is still running. Its browser lasts as long as it does.
  isLive: (sessionId: string) => boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

interface ManagedBrowser {
  sessionId: string;
  processId: string;
  profile: string;
  headed: boolean;
  version: string;
  cdpUrl: string;
  chrome: ChildProcess;
  display: ChildProcess | null;
  cdp: CdpConnection;
  tabs: Map<string, BrowserTab>;
  // The tab the user watches. It follows the newest tab until the user picks one.
  activeTargetId: string | null;
  pinned: boolean;
  screencast: { targetId: string; sessionId: string } | null;
  switching: Promise<void> | null;
  frame: BrowserFrame | null;
  waiters: Set<() => void>;
  watchedAt: number;
  help: BrowserHelpRequest | null;
  stopping: boolean;
}

const VIEWPORT = { width: 1366, height: 900 } as const;
const STARTUP_TIMEOUT_MS = 20_000;
// The screencast stops this long after the last viewer asked for a frame.
const VIEWER_IDLE_MS = 15_000;
const FRAME_WAIT_MS = 20_000;
const INPUT_WAIT_MS = 3_000;

// The patchright-core Patterm ships, which agents can import to drive the
// browser over CDP with Playwright's API without the CDP traces stock
// Playwright leaves.
export function patchrightPath(): string | null {
  try {
    return path.dirname(createRequire(__filename).resolve('patchright-core/package.json'));
  } catch {
    return null;
  }
}

// One Chrome per agent session, launched on first use. On Linux it runs
// headed on its own virtual display, which sites find harder to tell from a
// person than headless Chrome; elsewhere, or without Xvfb, it runs headless.
// Agents drive it over CDP; Patterm attaches only to stream what it shows
// and to pass on the user's input.
export class BrowserService {
  private readonly browsers = new Map<string, ManagedBrowser>();
  private readonly launching = new Map<string, Promise<ManagedBrowser>>();
  private readonly idleTimer: NodeJS.Timeout;
  private disposed = false;
  // Frame numbers only ever rise, across browsers and Patterm restarts, so a
  // viewer's cursor from an earlier browser never hides a new one's frames.
  private frameSeq = Date.now();

  constructor(private readonly options: BrowserServiceOptions) {
    this.idleTimer = setInterval(() => this.stopIdleScreencasts(), 5_000);
    this.idleTimer.unref();
  }

  private get profiles(): string {
    return path.join(this.options.directory, 'profiles');
  }

  // Starts the session's browser if needed and says how to reach it.
  async open(sessionId: string, processId: string): Promise<{ cdp_url: string; websocket_url: string; headed: boolean; chrome_version: string; patchright: string | null }> {
    const browser = await this.ensure(sessionId, processId);
    const version = await fetch(`${browser.cdpUrl}/json/version`).then((response) => response.json() as Promise<{ webSocketDebuggerUrl?: string }>).catch(() => null);
    return { cdp_url: browser.cdpUrl, websocket_url: version?.webSocketDebuggerUrl ?? '', headed: browser.headed, chrome_version: browser.version, patchright: patchrightPath() };
  }

  state(sessionId: string): BrowserState {
    const browser = this.browsers.get(sessionId);
    const install = this.options.installer.state();
    return {
      running: Boolean(browser),
      headed: browser?.headed ?? false,
      version: browser?.version ?? (install.status === 'installed' ? install.version : null),
      install,
      tabs: browser ? [...browser.tabs.values()] : [],
      activeTargetId: browser?.activeTargetId ?? null,
      help: browser?.help ?? null
    };
  }

  // The newest frame after `after`, waiting up to `waitMs` for one. Asking
  // keeps the screencast running; it stops when nobody has asked for a while.
  async frame(sessionId: string, after: number, waitMs = FRAME_WAIT_MS): Promise<BrowserFrame | { seq: number; data: null }> {
    const browser = this.browsers.get(sessionId);
    if (!browser) return { seq: after, data: null };
    browser.watchedAt = Date.now();
    await this.ensureScreencast(browser);
    if (browser.frame && browser.frame.seq > after) return browser.frame;
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); browser.waiters.delete(done); resolve(); };
      const timer = setTimeout(done, waitMs);
      browser.waiters.add(done);
    });
    browser.watchedAt = Date.now();
    return browser.frame && browser.frame.seq > after ? browser.frame : { seq: after, data: null };
  }

  // Input waits briefly for the watched tab to attach, never long enough to
  // hold up the other requests on the user's connection.
  async input(sessionId: string, input: BrowserInput): Promise<void> {
    const browser = this.require(sessionId);
    await Promise.race([this.ensureScreencast(browser), new Promise((resolve) => setTimeout(resolve, INPUT_WAIT_MS))]);
    const target = browser.screencast;
    if (!target) throw new Error('The browser has no open tab');
    if (input.kind === 'text') {
      await browser.cdp.send('Input.insertText', { text: input.text }, target.sessionId);
    } else if (input.kind === 'key') {
      const { kind: _kind, ...params } = input;
      await browser.cdp.send('Input.dispatchKeyEvent', definedOnly(params), target.sessionId);
    } else {
      const { kind: _kind, ...params } = input;
      await browser.cdp.send('Input.dispatchMouseEvent', definedOnly({ button: 'none', ...params, deltaX: params.deltaX ?? 0, deltaY: params.deltaY ?? 0 }), target.sessionId);
    }
  }

  // Types a secret into a field, as keystrokes, so it never passes through
  // the agent. The page must be on a site the user allowed for the secret,
  // checked in the page itself, not from the tab list.
  async fillSecret(sessionId: string, input: { targetId?: string | undefined; selector: string; value: string; allowed: (host: string) => boolean }): Promise<{ target_id: string; host: string }> {
    const browser = this.browsers.get(sessionId);
    if (!browser) throw new Error('Your browser is not running. Call browser_open and load the sign-in page first.');
    const targetId = input.targetId ?? browser.activeTargetId ?? [...browser.tabs.keys()].at(-1);
    if (!targetId || !browser.tabs.has(targetId)) throw new Error('That tab is not open');
    const { sessionId: attached } = await browser.cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    try {
      // Text input goes only to a focused page, and Patterm's Chrome has no
      // focused window. Detaching ends the emulation.
      await browser.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, attached);
      const check = await browser.cdp.send<{ result: { value?: { host: string; secure: boolean; found: boolean } } }>('Runtime.evaluate', {
        expression: `(() => {
          const element = document.querySelector(${JSON.stringify(input.selector)});
          const editable = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element?.isContentEditable;
          if (editable) { element.focus(); element.select?.(); }
          return { host: location.host, secure: location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname), found: Boolean(editable) };
        })()`,
        returnByValue: true
      }, attached);
      const page = check.result.value;
      if (!page) throw new Error('Could not read the page');
      if (!input.allowed(page.host)) throw new Error(`The user allowed this secret only on other sites, not ${page.host || 'this page'}`);
      if (!page.secure) throw new Error('Secrets are filled only on https pages');
      if (!page.found) throw new Error(`No text field matches ${input.selector}`);
      await browser.cdp.send('Input.insertText', { text: input.value }, attached);
      // Compares lengths, so the value never comes back out of the page.
      const typed = await browser.cdp.send<{ result: { value?: number } }>('Runtime.evaluate', {
        expression: `(() => { const element = document.activeElement; return element && 'value' in element ? String(element.value).length : (element?.textContent ?? '').length; })()`,
        returnByValue: true
      }, attached);
      if (typed.result.value !== input.value.length) throw new Error('The field did not take the secret. Click it in the page first, or ask the user with browser_request_help.');
      return { target_id: targetId, host: page.host };
    } finally {
      await browser.cdp.send('Target.detachFromTarget', { sessionId: attached }).catch(() => {});
    }
  }

  // Opens `url` in the session's watched tab. A browser that isn't running
  // starts in the background, since it may first need Chrome downloaded and
  // the user's request shouldn't wait on that; its state shows the progress.
  async navigate(sessionId: string, processId: string, url: string): Promise<{ starting: boolean }> {
    const running = this.browsers.get(sessionId);
    if (!running) {
      void this.ensure(sessionId, processId).then((browser) => this.show(browser, url)).catch(() => { this.options.onChanged(); });
      return { starting: true };
    }
    await this.show(running, url);
    return { starting: false };
  }

  private async show(browser: ManagedBrowser, url: string): Promise<void> {
    await this.ensureScreencast(browser);
    if (!browser.screencast) {
      await browser.cdp.send('Target.createTarget', { url });
      return;
    }
    await browser.cdp.send('Page.navigate', { url }, browser.screencast.sessionId);
  }

  async selectTab(sessionId: string, targetId: string): Promise<void> {
    const browser = this.require(sessionId);
    if (!browser.tabs.has(targetId)) throw new Error('That tab has closed');
    browser.activeTargetId = targetId;
    browser.pinned = true;
    await browser.cdp.send('Target.activateTarget', { targetId }).catch(() => {});
    await this.switchScreencast(browser);
    this.options.onChanged();
  }

  async requestHelp(sessionId: string, processId: string, reason: string): Promise<void> {
    const browser = await this.ensure(sessionId, processId);
    browser.help = { reason, requestedAt: new Date().toISOString() };
    this.options.raiseHelp(processId, reason);
    this.options.onChanged();
  }

  // The user finished what the agent asked for, or stepped in unasked.
  async finishHelp(sessionId: string, note?: string): Promise<void> {
    const browser = this.require(sessionId);
    const asked = browser.help;
    browser.help = null;
    this.options.resolveHelp(browser.processId);
    this.options.onChanged();
    const lead = asked ? 'The user finished in your browser.' : 'The user used your browser.';
    await this.options.messageAgent(browser.processId, `[browser] ${lead}${note ? ` ${note}` : ''} Check its current state before you carry on.`);
  }

  async stop(sessionId: string, options: { removeProfile?: boolean } = {}): Promise<void> {
    const launching = this.launching.get(sessionId);
    if (launching) await launching.catch(() => undefined);
    const browser = this.browsers.get(sessionId);
    if (browser) await this.shutdown(browser);
    if (options.removeProfile) await fs.promises.rm(path.join(this.profiles, safeName(sessionId)), { recursive: true, force: true });
  }

  // Stops the browsers of sessions that have ended and removes their
  // profiles, including ones left from before a restart. A browser still
  // starting checks for itself once it is up.
  async reap(): Promise<void> {
    const isLive = this.options.isLive;
    for (const sessionId of [...this.browsers.keys()]) {
      if (!isLive(sessionId)) await this.stop(sessionId, { removeProfile: true });
    }
    let entries: string[] = [];
    try { entries = await fs.promises.readdir(this.profiles); } catch { return; }
    for (const entry of entries) {
      if (!this.browsers.has(entry) && !this.launching.has(entry) && !isLive(entry)) {
        await fs.promises.rm(path.join(this.profiles, entry), { recursive: true, force: true });
      }
    }
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.launching.values()]);
    await Promise.all([...this.browsers.values()].map((browser) => this.shutdown(browser)));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    clearInterval(this.idleTimer);
    await this.stopAll();
  }

  private require(sessionId: string): ManagedBrowser {
    const browser = this.browsers.get(sessionId);
    if (!browser) throw new Error('This agent has no browser open');
    return browser;
  }

  private ensure(sessionId: string, processId: string): Promise<ManagedBrowser> {
    if (this.disposed) return Promise.reject(new Error('Patterm is shutting down'));
    const running = this.browsers.get(sessionId);
    if (running) return Promise.resolve(running);
    let launching = this.launching.get(sessionId);
    if (!launching) {
      launching = this.options.installer.ensure()
        .then((chrome) => this.launch(sessionId, processId, chrome))
        .finally(() => this.launching.delete(sessionId));
      this.launching.set(sessionId, launching);
    }
    return launching;
  }

  private async launch(sessionId: string, processId: string, chrome: InstalledChrome): Promise<ManagedBrowser> {
    if (!/^[A-Za-z0-9_.:-]+$/.test(sessionId)) throw new Error('Invalid session id');
    // A first download can outlast the session that asked for it.
    if (!this.options.isLive(sessionId)) throw new Error('The session has ended');
    const env = this.options.env ?? process.env;
    const platform = this.options.platform ?? process.platform;
    const profile = path.join(this.profiles, safeName(sessionId));
    await fs.promises.mkdir(profile, { recursive: true });
    await fs.promises.rm(path.join(profile, 'DevToolsActivePort'), { force: true });

    const xvfb = platform === 'linux' ? findExecutable('Xvfb', env) : null;
    const display = xvfb ? await startDisplay(xvfb) : null;
    const args = [
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      '--window-position=0,0',
      '--password-store=basic',
      ...(platform === 'darwin' ? ['--use-mock-keychain'] : []),
      ...(display ? [] : ['--headless=new']),
      'about:blank'
    ];
    const child = spawn(chrome.executable, args, {
      env: { ...env, ...(display ? { DISPLAY: display.name } : {}) },
      stdio: 'ignore',
      detached: platform !== 'win32',
      windowsHide: true
    });
    let exited = false;
    child.once('exit', () => { exited = true; });
    child.once('error', () => { exited = true; });
    try {
      const port = await waitForPort(path.join(profile, 'DevToolsActivePort'), () => exited);
      const cdpUrl = `http://127.0.0.1:${port.port}`;
      const cdp = await CdpConnection.connect(`ws://127.0.0.1:${port.port}${port.path}`);
      const browser: ManagedBrowser = {
        sessionId, processId, profile, headed: Boolean(display), version: chrome.version, cdpUrl,
        chrome: child, display: display?.process ?? null, cdp,
        tabs: new Map(), activeTargetId: null, pinned: false, screencast: null, switching: null,
        frame: null, waiters: new Set(), watchedAt: 0, help: null, stopping: false
      };
      cdp.on((event) => this.onEvent(browser, event));
      await cdp.send('Target.setDiscoverTargets', { discover: true });
      if (this.disposed || !this.options.isLive(sessionId)) {
        cdp.close();
        throw new Error('The session has ended');
      }
      this.browsers.set(sessionId, browser);
      child.once('exit', () => void this.shutdown(browser));
      this.options.onChanged();
      return browser;
    } catch (error) {
      const stopped = exited ? Promise.resolve() : new Promise<void>((resolve) => { child.once('exit', () => resolve()); setTimeout(resolve, 5_000).unref(); });
      stopChild(child, 'SIGKILL', platform !== 'win32');
      if (display) stopChild(display.process, 'SIGTERM');
      if (!this.options.isLive(sessionId)) {
        await stopped;
        await fs.promises.rm(profile, { recursive: true, force: true });
      }
      throw error;
    }
  }

  private onEvent(browser: ManagedBrowser, event: CdpEvent): void {
    if (event.method === 'Target.targetCreated' || event.method === 'Target.targetInfoChanged') {
      const info = event.params.targetInfo as { targetId: string; type: string; url: string; title: string } | undefined;
      if (!info || info.type !== 'page') return;
      const added = !browser.tabs.has(info.targetId);
      browser.tabs.set(info.targetId, { targetId: info.targetId, url: info.url, title: info.title });
      if (added && !browser.pinned) {
        browser.activeTargetId = info.targetId;
        if (browser.screencast) void this.switchScreencast(browser);
      }
      this.options.onChanged();
    } else if (event.method === 'Target.targetDestroyed') {
      const targetId = event.params.targetId as string;
      if (!browser.tabs.delete(targetId)) return;
      if (browser.activeTargetId === targetId) {
        browser.activeTargetId = [...browser.tabs.keys()].at(-1) ?? null;
        browser.pinned = false;
        if (browser.screencast?.targetId === targetId) browser.screencast = null;
        void this.switchScreencast(browser);
      }
      this.options.onChanged();
    } else if (event.method === 'Page.screencastFrame' && event.sessionId && event.sessionId === browser.screencast?.sessionId) {
      const metadata = event.params.metadata as { deviceWidth?: number; deviceHeight?: number } | undefined;
      void browser.cdp.send('Page.screencastFrameAck', { sessionId: event.params.sessionId }, event.sessionId).catch(() => {});
      browser.frame = {
        seq: ++this.frameSeq,
        data: event.params.data as string,
        width: metadata?.deviceWidth ?? VIEWPORT.width,
        height: metadata?.deviceHeight ?? VIEWPORT.height,
        targetId: browser.screencast.targetId
      };
      for (const wake of [...browser.waiters]) wake();
    } else if (event.method === 'Target.detachedFromTarget' && event.params.sessionId === browser.screencast?.sessionId) {
      browser.screencast = null;
    }
  }

  private async ensureScreencast(browser: ManagedBrowser): Promise<void> {
    if (browser.switching) await browser.switching;
    if (browser.screencast?.targetId === browser.activeTargetId && browser.screencast) return;
    await this.switchScreencast(browser);
  }

  // Streams the watched tab, moving off whichever tab streamed before.
  private switchScreencast(browser: ManagedBrowser): Promise<void> {
    const run = async () => {
      await this.stopScreencast(browser);
      if (browser.stopping) return;
      const targetId = browser.activeTargetId ?? [...browser.tabs.keys()].at(-1) ?? null;
      if (!targetId) return;
      browser.activeTargetId = targetId;
      const { sessionId } = await browser.cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
      browser.screencast = { targetId, sessionId };
      await browser.cdp.send('Page.enable', {}, sessionId);
      await browser.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 1 }, sessionId);
    };
    const switching = (browser.switching ?? Promise.resolve()).then(run).catch(() => {}).finally(() => {
      if (browser.switching === switching) browser.switching = null;
    });
    browser.switching = switching;
    return switching;
  }

  private async stopScreencast(browser: ManagedBrowser): Promise<void> {
    const streaming = browser.screencast;
    if (!streaming) return;
    browser.screencast = null;
    await browser.cdp.send('Page.stopScreencast', {}, streaming.sessionId).catch(() => {});
    await browser.cdp.send('Target.detachFromTarget', { sessionId: streaming.sessionId }).catch(() => {});
  }

  private stopIdleScreencasts(): void {
    for (const browser of this.browsers.values()) {
      if (browser.screencast && !browser.switching && Date.now() - browser.watchedAt >= VIEWER_IDLE_MS) void this.stopScreencast(browser);
    }
  }

  private async shutdown(browser: ManagedBrowser): Promise<void> {
    if (browser.stopping) return;
    browser.stopping = true;
    if (this.browsers.get(browser.sessionId) === browser) this.browsers.delete(browser.sessionId);
    for (const wake of [...browser.waiters]) wake();
    if (browser.help) this.options.resolveHelp(browser.processId);
    await browser.cdp.send('Browser.close').catch(() => {});
    browser.cdp.close();
    const platform = this.options.platform ?? process.platform;
    if (browser.chrome.exitCode === null && browser.chrome.signalCode === null) {
      const exited = new Promise<void>((resolve) => browser.chrome.once('exit', () => resolve()));
      const timer = setTimeout(() => stopChild(browser.chrome, 'SIGKILL', platform !== 'win32'), 5_000);
      await exited;
      clearTimeout(timer);
    }
    if (browser.display) stopChild(browser.display, 'SIGTERM');
    if (!this.disposed) this.options.onChanged();
  }
}

// Starts Xvfb on a free display and returns its name, such as ":5".
async function startDisplay(xvfb: string): Promise<{ name: string; process: ChildProcess }> {
  const child = spawn(xvfb, ['-displayfd', '3', '-screen', '0', `${VIEWPORT.width + 74}x${VIEWPORT.height + 160}x24`, '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
  const pipe = child.stdio[3] as NodeJS.ReadableStream | null;
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => { stopChild(child, 'SIGTERM'); reject(new Error('Xvfb did not start')); }, 10_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Xvfb exited before it started')); });
    pipe?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const match = /^(\d+)\n/.exec(output);
      if (!match) return;
      clearTimeout(timer);
      child.removeAllListeners('exit');
      resolve({ name: `:${match[1]}`, process: child });
    });
  });
}

// Chrome writes its chosen port and browser path to DevToolsActivePort.
async function waitForPort(file: string, exited: () => boolean): Promise<{ port: number; path: string }> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited()) throw new Error('Chrome exited while starting');
    try {
      const [port, browserPath] = (await fs.promises.readFile(file, 'utf8')).split('\n');
      if (port && Number(port) > 0 && browserPath?.startsWith('/devtools/browser/')) return { port: Number(port), path: browserPath.trim() };
    } catch { /* Not written yet. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Chrome did not start in time');
}

function safeName(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_.-]/g, '_');
}

function definedOnly(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
