import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { BROWSER_CONTROL_TOOLS, BROWSER_VIEW_TOOLS, BrowserActions } from '../app/Actions/BrowserActions';
import { BROWSER_TOOLS, INTEGRATED_CONTROL_TOOLS } from '../app/Http/BrowserTools';
import { BrowserService, patchrightPath } from '../app/Services/Browser/BrowserService';
import { CdpConnection } from '../app/Services/Browser/CdpConnection';
import { CHROME_VERSIONS_URL, ChromeInstaller, chromeExecutable, chromePlatform, extractZip } from '../app/Services/Browser/ChromeInstaller';
import type { DatabaseService } from '../app/Services/DatabaseService';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-browser-'));

// A stored (uncompressed) zip, enough to exercise extraction.
function zip(entries: Array<{ name: string; data?: string; mode?: number }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data ?? '');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

async function extractionChecks(): Promise<void> {
  const archive = path.join(root, 'ok.zip');
  fs.writeFileSync(archive, zip([
    { name: 'chrome-linux64/', mode: 0o40755 },
    { name: 'chrome-linux64/chrome', data: '#!/bin/sh\n', mode: 0o100755 },
    { name: 'chrome-linux64/link', data: 'chrome', mode: 0o120777 }
  ]));
  const out = path.join(root, 'ok');
  await extractZip(archive, out);
  assert.equal(fs.readFileSync(path.join(out, 'chrome-linux64/chrome'), 'utf8'), '#!/bin/sh\n');
  if (process.platform !== 'win32') {
    assert.ok(fs.statSync(path.join(out, 'chrome-linux64/chrome')).mode & 0o100, 'keeps the executable bit');
    assert.equal(fs.readlinkSync(path.join(out, 'chrome-linux64/link')), 'chrome');
  }

  const escaping = path.join(root, 'escape.zip');
  fs.writeFileSync(escaping, zip([{ name: '../outside', data: 'x' }]));
  await assert.rejects(extractZip(escaping, path.join(root, 'escape')), /escapes|invalid relative path/);
  assert.equal(fs.existsSync(path.join(root, 'outside')), false);

  if (process.platform !== 'win32') {
    const linking = path.join(root, 'link.zip');
    fs.writeFileSync(linking, zip([{ name: 'a/link', data: '../../outside', mode: 0o120777 }]));
    await assert.rejects(extractZip(linking, path.join(root, 'link')), /leaves its folder/);
    // Links that each stay inside, chained, would still climb out.
    const chained = path.join(root, 'chained.zip');
    fs.writeFileSync(chained, zip([
      { name: 'alias', data: '.', mode: 0o120777 },
      { name: 'alias/up', data: '..', mode: 0o120777 },
      { name: 'alias/up/escaped', data: 'x' }
    ]));
    await assert.rejects(extractZip(chained, path.join(root, 'chained', 'out')), /leaves its folder/);
    assert.equal(fs.existsSync(path.join(root, 'chained', 'escaped')), false, 'nothing lands beside the destination');
    // Nor can `..` hide behind an earlier link, and refusing it creates nothing.
    const hidden = path.join(root, 'hidden.zip');
    fs.writeFileSync(hidden, zip([
      { name: 'alias', data: '.', mode: 0o120777 },
      { name: 'escape', data: 'alias/..', mode: 0o120777 },
      { name: 'escape/outside_created/link', data: '.', mode: 0o120777 }
    ]));
    await assert.rejects(extractZip(hidden, path.join(root, 'hidden', 'out')), /leaves its folder/);
    assert.deepEqual(fs.readdirSync(path.join(root, 'hidden')), ['out']);
    assert.deepEqual(fs.readdirSync(path.join(root, 'hidden', 'out')), []);
    // Links that only point down, as in Chrome's macOS bundle, are kept.
    const bundle = path.join(root, 'bundle.zip');
    fs.writeFileSync(bundle, zip([
      { name: 'F.framework/Versions/1/Resources/r', data: 'r' },
      { name: 'F.framework/Versions/Current', data: '1', mode: 0o120777 },
      { name: 'F.framework/Resources', data: 'Versions/Current/Resources', mode: 0o120777 }
    ]));
    await extractZip(bundle, path.join(root, 'bundle'));
    assert.equal(fs.readFileSync(path.join(root, 'bundle', 'F.framework', 'Resources', 'r'), 'utf8'), 'r');
  }
}

async function installerChecks(): Promise<void> {
  assert.equal(chromePlatform('linux', 'x64'), 'linux64');
  assert.equal(chromePlatform('darwin', 'arm64'), 'mac-arm64');
  assert.equal(chromePlatform('win32', 'x64'), 'win64');
  assert.equal(chromePlatform('freebsd', 'x64'), null);
  assert.equal(chromeExecutable('/x', 'mac-arm64'), path.join('/x', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'));

  const body = zip([{ name: 'chrome-linux64/', mode: 0o40755 }, { name: 'chrome-linux64/chrome', data: '#!/bin/sh\n', mode: 0o100755 }]);
  const md5 = createHash('md5').update(body).digest('base64');
  let downloads = 0;
  const fetchFor = (hash: string) => (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === CHROME_VERSIONS_URL) {
      return Response.json({ channels: { Stable: { version: '150.0.1.2', downloads: { chrome: [{ platform: 'linux64', url: 'https://example.test/chrome.zip' }] } } } });
    }
    downloads++;
    return new Response(new Uint8Array(body), { headers: { 'content-length': String(body.length), 'x-goog-hash': `crc32c=AAAAAA==, md5=${hash}` } });
  }) as typeof fetch;

  // A download whose MD5 does not match is rejected and leaves nothing installed.
  const tamperedDir = path.join(root, 'tampered');
  const tampered = new ChromeInstaller(tamperedDir, () => {}, fetchFor('AAAAAAAAAAAAAAAAAAAAAA=='), 'linux64');
  await assert.rejects(tampered.ensure(), /MD5/);
  assert.equal(tampered.state().status, 'error');
  assert.equal(tampered.installed(), null);
  assert.deepEqual(fs.readdirSync(tamperedDir), []);

  const directory = path.join(root, 'chrome');
  const changes: string[] = [];
  const installer = new ChromeInstaller(directory, () => changes.push(installer.state().status), fetchFor(md5), 'linux64');
  const [first, second] = await Promise.all([installer.ensure(), installer.ensure()]);
  assert.equal(downloads, 2, 'concurrent callers share one download');
  assert.deepEqual(first, second);
  assert.equal(first.version, '150.0.1.2');
  assert.equal(first.executable, path.join(directory, '150.0.1.2', 'chrome-linux64', 'chrome'));
  assert.deepEqual(installer.state(), { status: 'installed', version: '150.0.1.2' });
  assert.ok(changes.includes('downloading') && changes.includes('extracting'));

  // An install survives a restart without downloading again.
  const reopened = new ChromeInstaller(directory, () => {}, (() => { throw new Error('no download expected'); }) as typeof fetch, 'linux64');
  assert.deepEqual(reopened.state(), { status: 'installed', version: '150.0.1.2' });
  assert.deepEqual(await reopened.ensure(), first);
  // Another platform's install is not trusted.
  assert.equal(new ChromeInstaller(directory, () => {}, fetch, 'mac-arm64').installed(), null);
}

function toolChecks(): void {
  for (const tool of BROWSER_VIEW_TOOLS) assert.ok(BROWSER_TOOLS.has(tool), `${tool} is readable from the UI`);
  for (const tool of BROWSER_CONTROL_TOOLS) {
    assert.ok(INTEGRATED_CONTROL_TOOLS.has(tool), `${tool} needs control of the agent`);
    assert.ok(!BROWSER_TOOLS.has(tool), `${tool} is socket-only in browsers`);
  }
  assert.ok(patchrightPath(), 'patchright-core ships with Patterm');
  // The browser replaced framed previews, so the app frames no other sites.
  for (const file of ['app/Http/WebServer.ts', 'index.html']) {
    const frameSources = /frame-src ([^;]*);/.exec(fs.readFileSync(file, 'utf8'))?.[1] ?? '';
    assert.doesNotMatch(frameSources, /https?:/, `${file} frames only Patterm's own pages`);
  }
}

async function actionChecks(): Promise<void> {
  const calls: unknown[] = [];
  const service = {
    input: async (...args: unknown[]) => { calls.push(['input', ...args]); },
    navigate: async (...args: unknown[]) => { calls.push(['navigate', ...args]); }
  } as unknown as BrowserService;
  const database = { connection: { prepare: () => ({ get: () => ({ id: 'session_1' }) }) } } as unknown as DatabaseService;
  const actions = new BrowserActions(service, database);
  await actions.input({ process_id: 'process_1', input: { kind: 'mouse', type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1 } });
  assert.deepEqual(calls.pop(), ['input', 'session_1', { kind: 'mouse', type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1 }]);
  await assert.rejects(actions.input({ process_id: 'process_1', input: { kind: 'eval', script: 'x' } }));
  await assert.rejects(actions.navigate({ process_id: 'process_1', url: 'file:///etc/passwd' }), /http/);
  await assert.rejects(actions.navigate({ process_id: 'process_1', url: 'javascript:alert(1)' }), /http/);
  await actions.navigate({ process_id: 'process_1', url: 'http://127.0.0.1:5173/' });
  assert.deepEqual(calls.pop(), ['navigate', 'session_1', 'process_1', 'http://127.0.0.1:5173/']);
  assert.throws(() => actions.open({}), /running agent/);
  assert.throws(() => actions.open({ remote: { host_id: 'h', host_name: 'h', project_id: 'p' } }), /own host/);
}

// Launches a real Chrome when one is at hand: PATTERM_TEST_CHROME, or the
// Chrome for Testing build Playwright caches.
function localChrome(): string | null {
  if (process.env.PATTERM_TEST_CHROME) return process.env.PATTERM_TEST_CHROME;
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  try {
    for (const entry of fs.readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name)).sort().reverse()) {
      const executable = path.join(cache, entry, 'chrome-linux64', 'chrome');
      if (fs.existsSync(executable)) return executable;
    }
  } catch { /* No cache. */ }
  return null;
}

async function liveChecks(): Promise<void> {
  const executable = process.platform === 'linux' ? localChrome() : null;
  if (!executable) { console.log('browser smoke: no local Chrome, live checks skipped'); return; }
  const helps: string[] = [];
  const messages: string[] = [];
  const service = new BrowserService({
    directory: path.join(root, 'live'),
    installer: { ensure: async () => ({ version: 'test', executable }), state: () => ({ status: 'absent' }) },
    onChanged: () => {},
    raiseHelp: (processId, reason) => helps.push(`${processId}:${reason}`),
    resolveHelp: (processId) => helps.push(`resolved:${processId}`),
    messageAgent: async (processId, text) => { messages.push(`${processId}:${text}`); },
    isLive: () => live
  });
  let live = true;
  try {
    const opened = await service.open('session_live', 'process_live');
    assert.match(opened.cdp_url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(opened.websocket_url, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//);
    const again = await service.open('session_live', 'process_live');
    assert.equal(again.cdp_url, opened.cdp_url, 'one browser per session');

    // A user's page loads and streams.
    await service.navigate('session_live', 'process_live', 'data:text/html,<title>Hello</title><p>hi</p>');
    const frame = await service.frame('session_live', 0, 10_000);
    assert.ok(frame.data, 'a frame arrives');
    assert.ok('width' in frame && frame.width > 0 && frame.height > 0);
    assert.ok(Buffer.from(frame.data, 'base64').subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), 'frames are JPEG');
    const state = service.state('session_live');
    assert.equal(state.running, true);
    assert.equal(state.headed, Boolean(process.env.PATH?.split(path.delimiter).some((dir) => fs.existsSync(path.join(dir, 'Xvfb')))));
    assert.ok(state.tabs.length >= 1 && state.activeTargetId);

    // The user's typing reaches the page.
    const cdp = await CdpConnection.connect(opened.websocket_url);
    const { targetInfos } = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string }> }>('Target.getTargets');
    const page = targetInfos.find((target) => target.targetId === state.activeTargetId)!;
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    await cdp.send('Runtime.evaluate', { expression: 'document.body.innerHTML = "<input id=box>"; document.getElementById("box").focus()' }, sessionId);
    await service.input('session_live', { kind: 'text', text: 'typed by a person' });
    const typed = await cdp.send<{ result: { value: string } }>('Runtime.evaluate', { expression: 'document.getElementById("box").value', returnByValue: true }, sessionId);
    assert.equal(typed.result.value, 'typed by a person');
    const webdriver = await cdp.send<{ result: { value: unknown } }>('Runtime.evaluate', { expression: 'navigator.webdriver', returnByValue: true }, sessionId);
    assert.equal(webdriver.result.value, false);
    cdp.close();

    await service.requestHelp('session_live', 'process_live', 'Solve the CAPTCHA');
    assert.deepEqual(helps, ['process_live:Solve the CAPTCHA']);
    assert.equal(service.state('session_live').help?.reason, 'Solve the CAPTCHA');
    await service.finishHelp('session_live');
    assert.equal(service.state('session_live').help, null);
    assert.match(messages[0] ?? '', /^process_live:\[browser\] The user finished in your browser\./);

    // An ended session's browser stops and its profile goes.
    live = false;
    await service.reap();
    assert.equal(service.state('session_live').running, false);
    assert.equal(fs.existsSync(path.join(root, 'live', 'profiles', 'session_live')), false);
    await assert.rejects(service.input('session_live', { kind: 'text', text: 'x' }), /no browser/);

    // Opening a page in a stopped browser starts it without waiting for it.
    live = true;
    const before = (frame as { seq: number }).seq;
    assert.deepEqual(await service.navigate('session_live', 'process_live', 'data:text/html,again'), { starting: true });
    for (let tries = 0; tries < 100 && !service.state('session_live').tabs.some((tab) => tab.url.startsWith('data:')); tries++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(service.state('session_live').tabs.some((tab) => tab.url.startsWith('data:')), 'the page opens once the browser starts');
    // A viewer still holding the old browser's cursor sees the new browser.
    const restarted = await service.frame('session_live', before, 10_000);
    assert.ok(restarted.data && restarted.seq > before, 'frame numbers keep rising across browsers');
    await service.stop('session_live');

    // A session that ends while its browser starts never gets one.
    let release: () => void = () => {};
    const slow = new BrowserService({
      directory: path.join(root, 'late'),
      installer: { ensure: () => new Promise((resolve) => { release = () => resolve({ version: 'test', executable }); }), state: () => ({ status: 'absent' }) },
      onChanged: () => {}, raiseHelp: () => {}, resolveHelp: () => {}, messageAgent: async () => {},
      isLive: () => lateLive
    });
    let lateLive = true;
    try {
      const opening = slow.open('session_late', 'process_late');
      await new Promise((resolve) => setTimeout(resolve, 50));
      lateLive = false;
      release();
      await assert.rejects(opening, /ended/);
      assert.equal(slow.state('session_late').running, false);
      assert.equal(fs.existsSync(path.join(root, 'late', 'profiles', 'session_late')), false);
    } finally {
      await slow.dispose();
    }
  } finally {
    await service.dispose();
  }
}

async function main(): Promise<void> {
  await extractionChecks();
  await installerChecks();
  toolChecks();
  await actionChecks();
  await liveChecks();
  console.log('browser smoke ok');
}

main().finally(() => fs.rmSync(root, { recursive: true, force: true })).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
