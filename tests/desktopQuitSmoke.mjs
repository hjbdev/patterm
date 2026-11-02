import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const filename = path.resolve('desktop/main/main.ts');
const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText;

test('closing the window after confirmed shutdown finishes quitting without accessing destroyed objects', async () => {
  const fixture = await desktop();
  await fixture.application.shutdown(); // The renderer's confirmed Quit command.
  fixture.window.destroy(); // Renderer closes; Electron emits closed, then window-all-closed.
  await fixture.settle();
  assert.equal(fixture.disposed, 1);
  assert.equal(fixture.nativePrompts, 0, 'already-confirmed shutdown needs no second confirmation');
  assert.equal(fixture.errors.length, 0);
  assert.equal(fixture.quitCompleted, true);
});

test('a pending quit fallback is cancelled when its window closes', async () => {
  const fixture = await desktop();
  fixture.window.close();
  assert.equal(fixture.timers.size, 1, 'a renderer that has not acknowledged the dialog has a fallback');
  fixture.window.destroy();
  await fixture.settle();
  assert.equal(fixture.timers.size, 0);
  assert.equal(fixture.nativePrompts, 1);
  assert.equal(fixture.disposed, 1);
  assert.equal(fixture.quitCompleted, true);
});

test('a second launch arriving after the original window closes does not focus a destroyed window', async () => {
  const fixture = await desktop();
  // A second launch may arrive between closed and the application's quit events.
  fixture.window.destroy({ emitWindowAllClosed: false });
  fixture.app.emit('second-instance');
  fixture.app.emit('window-all-closed');
  await fixture.settle();
  assert.equal(fixture.disposed, 1);
  assert.equal(fixture.quitCompleted, true);
});

test('cancelling the quit confirmation keeps the window and application alive', async () => {
  const fixture = await desktop({ nativeResponse: 0 });
  fixture.window.close();
  fixture.ipcMain.emit('patterm:quit:shown', { sender: fixture.window.webContents }, 1);
  assert.equal(fixture.timers.size, 0);
  assert.equal(fixture.window.isDestroyed(), false);
  assert.equal(fixture.disposed, 0);
  assert.equal(fixture.quitCompleted, false);
  fixture.app.quit();
  await fixture.runTimers();
  await fixture.settle();
  assert.equal(fixture.nativePrompts, 1);
  assert.equal(fixture.application.isShuttingDown(), false);
  assert.equal(fixture.quitCompleted, false);
});

for (const trigger of ['window close', 'application quit']) {
  test(`${trigger} with no running work quits without a confirmation`, async () => {
    const fixture = await desktop({ confirmation: undefined });
    if (trigger === 'window close') fixture.window.close();
    else fixture.app.quit();
    await fixture.settle();
    assert.equal(fixture.quitRequests.length, 0);
    assert.equal(fixture.nativePrompts, 0);
    assert.equal(fixture.timers.size, 0);
    assert.equal(fixture.disposed, 1);
    assert.equal(fixture.quitCompleted, true);
  });
}

for (const trigger of ['window close', 'application quit']) {
  test(`${trigger} still exits after cleanup fails once managed processes have stopped`, async () => {
    const fixture = await desktop({ confirmation: undefined, disposeError: new AggregateError([
      new Error('Windows cleanup fixture failed')
    ], 'Application shutdown failed') });
    if (trigger === 'window close') fixture.window.close();
    else fixture.app.quit();
    await fixture.settle();
    assert.equal(fixture.disposed, 1);
    assert.equal(fixture.quitCompleted, true, 'cleanup failure must not leave a windowless Electron process');
    assert.equal(fixture.errors.length, 1);
    assert.match(fixture.errors[0][1], /Windows cleanup fixture failed/, 'show the underlying error');
  });
}

test('a failed managed-process shutdown keeps the app alive for a retry', async () => {
  const fixture = await desktop({ confirmation: undefined, shutdownError: new AggregateError([
    new Error('Terminal host is still running')
  ], 'Managed shutdown failed') });
  fixture.app.quit();
  await fixture.settle();
  assert.equal(fixture.disposed, 0);
  assert.equal(fixture.quitCompleted, false);
  assert.match(fixture.errors[0][1], /Terminal host is still running/);
});

async function desktop(options = {}) {
  const { nativeResponse = 1 } = options;
  const confirmation = Object.hasOwn(options, 'confirmation') ? options.confirmation : 'Stop running processes.';
  const app = new EventEmitter();
  const ipcMain = new EventEmitter();
  const timers = new Map();
  const errors = [];
  const quitRequests = [];
  let nextTimer = 0;
  let window;
  let shuttingDown = false;
  let disposed = 0;
  let nativePrompts = 0;
  let quitCompleted = false;
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const application = {
    terminal: { onFrame: () => () => {} },
    onWorkbenchPatch: () => () => {}, onDataChanged: () => () => {},
    onTerminalClientRequest: () => () => {}, onNotificationsChanged: () => () => {},
    onAssistantEvent: () => () => {}, onDesktopNotification: () => () => {},
    isShuttingDown: () => shuttingDown,
    shutdown: async () => { if (options.shutdownError) throw options.shutdownError; shuttingDown = true; },
    dispose: async () => { disposed++; if (options.disposeError) throw options.disposeError; }
  };
  class BrowserWindow extends EventEmitter {
    destroyed = false;
    contents = {
      isDestroyed: () => this.destroyed, isLoading: () => false, isCrashed: () => false,
      setWindowOpenHandler: () => {}, on: () => {}, send: (channel, payload) => { if (channel === 'patterm:quit:request') quitRequests.push(payload); }, openDevTools: () => {}
    };
    constructor() { super(); window = this; }
    // Electron's BrowserWindow getter itself throws once the window is destroyed.
    get webContents() {
      if (this.destroyed) throw new TypeError('Object has been destroyed');
      return this.contents;
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() {
      if (this.destroyed) throw new TypeError('Object has been destroyed');
      return false;
    }
    restore() {}
    show() {}
    focus() {}
    loadURL() { return Promise.resolve(); }
    loadFile() { return Promise.resolve(); }
    close() {
      const event = cancellable();
      this.emit('close', event);
      if (!event.defaultPrevented) this.destroy();
    }
    destroy({ emitWindowAllClosed = true } = {}) {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('closed');
      if (emitWindowAllClosed) app.emit('window-all-closed');
    }
    static getAllWindows() { return window && !window.destroyed ? [window] : []; }
  }
  Object.assign(app, {
    isPackaged: true, getPath: () => '/tmp/patterm-desktop-quit-test',
    setName: () => {}, setPath: () => {}, setAppUserModelId: () => {},
    requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(),
    commandLine: { appendSwitch: () => {} },
    quit: () => {
      const event = cancellable();
      app.emit('before-quit', event);
      if (event.defaultPrevented) return;
      window?.close();
      if (!BrowserWindow.getAllWindows().length) quitCompleted = true;
    }
  });
  const electron = {
    app, BrowserWindow, ipcMain, Menu: { setApplicationMenu: () => {} },
    dialog: {
      showMessageBox: async () => { nativePrompts++; return { response: nativeResponse }; },
      showErrorBox: (...args) => errors.push(args)
    }
  };
  const imports = {
    electron,
    '../../app/App': { createApplication: async () => application },
    '../../routes/commands': { registerCommandRoutes: () => {} },
    '../../routes/ipc': { registerIpcRoutes: () => {} },
    '../../routes/application': { observedRoutes: (routes) => routes },
    '../../routes/remote': { servePeerRoutes: () => {} },
    './launchIdentity': { resolveLaunchIdentity: () => ({ appName: 'quit-test', appDataPath: '/tmp/patterm-desktop-quit-test', mode: 'production' }) },
    './sidecar': { isInstalledLaunch: () => true, resolveMcpShimPath: () => '', resolveSidecarPath: () => '' },
    '../../app/Commands/CommandPalette': { quitConfirmation: () => confirmation },
    './figureFrame': { ElectronPagePreviewer: class {}, guardFigureFrames: () => {}, registerFigureFrameScheme: () => {}, serveFigureFrames: () => {} }
  };
  vm.runInNewContext(source, {
    require: (id) => Object.hasOwn(imports, id) ? imports[id] : require(id),
    exports: {}, __dirname: path.dirname(filename), console: { ...console, error: () => {} }, Buffer,
    process: { platform: 'win32', env: {}, cwd: () => process.cwd() },
    setTimeout: (callback) => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id)
  }, { filename });
  await settle();
  assert.ok(window, 'desktop startup creates its window');
  return {
    app, application, window, ipcMain, timers, errors, quitRequests, settle,
    get disposed() { return disposed; }, get nativePrompts() { return nativePrompts; },
    get quitCompleted() { return quitCompleted; },
    runTimers: async () => {
      for (const [id, callback] of [...timers]) { timers.delete(id); callback(); }
      await settle();
    }
  };
}

function cancellable() {
  return { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
}
