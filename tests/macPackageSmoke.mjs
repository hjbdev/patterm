import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

test('Mac zip preserves a runnable app, bundled dependencies, and renderer', {
  // Two verified installs, a launch, and a running-app refusal have separate bounds.
  skip: process.platform !== 'darwin' && 'requires macOS', timeout: 360_000
}, async (t) => {
  const directory = process.env.MAC_PACKAGE_DIRECTORY;
  assert.ok(directory, 'set MAC_PACKAGE_DIRECTORY to the package output directory');
  const archives = fs.readdirSync(directory).filter(name => name.endsWith(`-macos-${process.arch}.zip`));
  assert.equal(archives.length, 1, 'expected one package for this architecture');
  const archive = path.join(directory, archives[0]);
  const checksum = fs.readFileSync(`${archive}.sha256`, 'utf8').trim().split(/\s+/)[0];
  assert.equal(createHash('sha256').update(fs.readFileSync(archive)).digest('hex'), checksum);
  // A path with spaces catches bundle-path quoting errors. Never use live app data.
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm mac smoke '));
  let child;
  let socket;
  let log = '';
  try {
    console.log('Installing and checking the Mac bundle');
    const applications = path.join(temporary, 'Applications');
    const version = /^patterm-(.+)-macos-(?:arm64|x64)\.zip$/.exec(archives[0])[1];
    const installEnv = { ...process.env, PATTERM_MAC_APPLICATIONS_DIR: applications, PATTERM_MAC_RELEASE_URL: pathToFileURL(path.resolve(directory)).href };
    for (let attempt = 0; attempt < 2; attempt++) {
      execFileSync('bash', ['scripts/release/install-macos.sh', '--version', version], { env: installEnv, timeout: 120_000, stdio: 'inherit' });
    }
    const bundle = path.join(applications, 'Patterm.app');
    const resources = path.join(bundle, 'Contents', 'Resources');
    const app = path.join(resources, 'app');
    const executable = path.join(bundle, 'Contents', 'MacOS', 'Patterm');
    execFileSync('codesign', ['--verify', '--deep', '--strict', bundle]);
    execFileSync('lipo', [path.join(resources, 'native', 'patterm-terminal-core'), '-verify_arch', process.arch === 'arm64' ? 'arm64' : 'x86_64']);
    for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'dist/main/desktop/main/main.js', 'dist/renderer/index.html']) {
      assert.ok(fs.statSync(path.join(app, file)).isFile(), file);
    }
    assert.ok(fs.statSync(path.join(resources, 'mcp', 'patterm-mcp.js')).isFile());
    console.log('Checking bundled Node and SQLite');
    // Exercise Electron's bundled Node, including SQLite and dependency resolution.
    execFileSync(executable, ['-e', "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(':memory:'); db.exec('SELECT 1'); db.close(); require('zod'); require('ws');"], {
      cwd: app, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 15_000
    });
    console.log('Checking the semantic search runtime');
    // The prebuilt llama.cpp binary (Metal on Apple silicon, where no CPU-only build exists) must load from the signed bundle. No model is needed.
    execFileSync(executable, ['-e', "import('node-llama-cpp').then((m) => m.getLlama({ gpu: process.arch === 'arm64' ? 'metal' : false, build: 'never', skipDownload: true })).then(() => process.exit(0), (error) => { console.error(error); process.exit(1); })"], {
      cwd: app, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 60_000, stdio: 'inherit'
    });
    const data = path.join(temporary, 'data');
    const env = { ...process.env, PATTERM_APP_DATA_PATH: data };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.PATTERM_DESKTOP_RESOURCES;
    console.log('Launching the packaged app');
    child = spawn('./Patterm', ['--remote-debugging-port=0'], { cwd: path.dirname(executable), env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { log = (log + chunk).slice(-16_000); });
    child.stderr.on('data', chunk => { log = (log + chunk).slice(-16_000); });
    const deadline = Date.now() + 45_000;
    const activePort = path.join(data, 'DevToolsActivePort');
    while (!fs.existsSync(activePort)) {
      assert.equal(child.exitCode, null, log);
      assert.ok(Date.now() < deadline, `no debug port: ${log}`);
      await delay(250);
    }
    const port = fs.readFileSync(activePort, 'utf8').split('\n')[0];
    let page;
    while (!page) {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5_000) })).json();
      page = pages.find(entry => entry.type === 'page' && entry.url.startsWith('file:') && entry.url.endsWith('/index.html'));
      assert.ok(Date.now() < deadline, `packaged renderer never loaded: ${log}`);
      if (!page) await delay(250);
    }
    console.log('Connecting to the packaged renderer');
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await once(socket, 'open', { signal: AbortSignal.any([t.signal, AbortSignal.timeout(10_000)]) });
    let id = 0;
    while (true) {
      const response = once(socket, 'message', { signal: AbortSignal.any([t.signal, AbortSignal.timeout(5_000)]) });
      socket.send(JSON.stringify({ id: ++id, method: 'Runtime.evaluate', params: {
        expression: "Boolean(document.querySelector('#app')?.children.length && window.patterm)", returnByValue: true
      } }));
      const [event] = await response;
      const result = JSON.parse(event.data);
      if (result.id === id && result.result?.result?.value === true) break;
      assert.ok(Date.now() < deadline, `Vue app or preload never initialized: ${log}`);
      await delay(250);
    }
    console.log('Packaged renderer and preload initialized');
    assert.equal(child.exitCode, null, log);
    assert.ok(fs.existsSync(path.join(data, 'app.db')), `app database missing: ${log}`);
    assert.throws(() => execFileSync('bash', ['scripts/release/install-macos.sh', '--version', version], {
      env: installEnv, timeout: 15_000, stdio: 'pipe'
    }), error => /Patterm is running/.test(error.stderr?.toString()), 'installer rejects an app launched with relative argv[0]');
  } catch (error) {
    throw new Error(`${error.message}\n${log}`, { cause: error });
  } finally {
    socket?.close();
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    child?.stdout.destroy();
    child?.stderr.destroy();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
