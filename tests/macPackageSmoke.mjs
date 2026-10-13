import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

test('Mac zip preserves a runnable app, bundled dependencies, and renderer', {
  skip: process.platform !== 'darwin' && 'requires macOS', timeout: 90_000
}, async () => {
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
    execFileSync('ditto', ['-x', '-k', archive, temporary]);
    const bundle = path.join(temporary, 'Patterm.app');
    const resources = path.join(bundle, 'Contents', 'Resources');
    const app = path.join(resources, 'app');
    const executable = path.join(bundle, 'Contents', 'MacOS', 'Electron');
    execFileSync('codesign', ['--verify', '--deep', '--strict', bundle]);
    execFileSync('lipo', [path.join(resources, 'native', 'patterm-terminal-core'), '-verify_arch', process.arch === 'arm64' ? 'arm64' : 'x86_64']);
    for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'dist/main/desktop/main/main.js', 'dist/renderer/index.html']) {
      assert.ok(fs.statSync(path.join(app, file)).isFile(), file);
    }
    assert.ok(fs.statSync(path.join(resources, 'mcp', 'patterm-mcp.js')).isFile());
    // Exercise Electron's bundled Node, including SQLite and dependency resolution.
    execFileSync(executable, ['-e', "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(':memory:'); db.exec('SELECT 1'); db.close(); require('zod'); require('ws');"], {
      cwd: app, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 15_000
    });
    const data = path.join(temporary, 'data');
    const env = { ...process.env, PATTERM_APP_DATA_PATH: data };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.PATTERM_DESKTOP_RESOURCES;
    child = spawn(executable, ['--remote-debugging-port=0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = pages.find(entry => entry.type === 'page' && entry.url.startsWith('file:') && entry.url.endsWith('/index.html'));
      assert.ok(Date.now() < deadline, `packaged renderer never loaded: ${log}`);
      if (!page) await delay(250);
    }
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await once(socket, 'open');
    let id = 0;
    while (true) {
      const response = once(socket, 'message');
      socket.send(JSON.stringify({ id: ++id, method: 'Runtime.evaluate', params: {
        expression: "Boolean(document.querySelector('#app')?.children.length && window.patterm)", returnByValue: true
      } }));
      const [event] = await response;
      const result = JSON.parse(event.data);
      if (result.id === id && result.result?.result?.value === true) break;
      assert.ok(Date.now() < deadline, `Vue app or preload never initialized: ${log}`);
      await delay(250);
    }
    assert.equal(child.exitCode, null, log);
    assert.ok(fs.existsSync(path.join(data, 'app.db')), `app database missing: ${log}`);
  } finally {
    socket?.close();
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
