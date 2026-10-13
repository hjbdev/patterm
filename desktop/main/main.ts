import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, shell } from 'electron';
import { createApplication, type PattermApplication } from '../../app/App';
import { registerCommandRoutes } from '../../routes/commands';
import { registerIpcRoutes } from '../../routes/ipc';
import { servePeerRoutes } from '../../routes/remote';
import { resolveLaunchIdentity } from './launchIdentity';
import { isInstalledLaunch, resolveMcpShimPath, resolveSidecarPath } from './sidecar';
import { quitConfirmation } from '../../app/Commands/CommandPalette';

interface LaunchDiagnostics {
  platform: NodeJS.Platform;
  xdgSessionType: string | null;
  waylandDisplay: string | null;
  display: string | null;
  mode: 'auto' | 'wayland' | 'gpu-disabled' | 'wayland-gpu-disabled';
  switches: Array<{ name: string; value?: string }>;
}

const launchDiagnostics = configureLinuxWindowing();
const launchIdentity = resolveLaunchIdentity({
  // Roaming AppData syncs between machines; databases, sockets, and terminal
  // state belong to this machine.
  appDataRoot: process.platform === 'win32' ? process.env.LOCALAPPDATA ?? app.getPath('appData') : app.getPath('appData'),
  env: process.env,
  isInstalledLaunch: isInstalledLaunch(),
  isPackaged: app.isPackaged
});

// Set app identity before any service resolves userData. Dev and production
// deliberately use separate namespaces so a dev launch cannot reconcile the
// installed app's live PTY rows.
app.setName(launchIdentity.appName);
app.setPath('userData', launchIdentity.appDataPath);
// Windows routes toast notifications and their clicks by this ID. An installer
// must give its Start menu shortcut the same ID.
if (process.platform === 'win32') app.setAppUserModelId(launchIdentity.mode === 'production' ? 'Patterm.Desktop' : 'Patterm.Desktop.Dev');
Menu.setApplicationMenu(null);

let mainWindow: BrowserWindow | null = null;
let patterm: PattermApplication | null = null;
let quitting: Promise<void> | undefined;
let quitComplete = false;
let quitPrompt: { id: number; fallback: NodeJS.Timeout } | null = null;
let nextQuitPromptId = 0;

const singleInstanceLock = app.requestSingleInstanceLock({
  appName: launchIdentity.appName,
  appDataPath: launchIdentity.appDataPath,
  mode: launchIdentity.mode
});

if (!singleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  });
}

async function createWindow(): Promise<void> {
  patterm = await createApplication({
    appDataPath: app.getPath('userData'),
    sidecarPath: resolveSidecarPath(app.isPackaged),
    mcpShimPath: resolveMcpShimPath(app.isPackaged),
    // Windows terminals run in detached hosts that survive an app restart. The
    // Linux desktop keeps its attached sidecar; its server uses systemd hosts.
    ...(process.platform === 'win32' ? { terminalHosts: { appDataPath: app.getPath('userData') } } : {}),
    launchDiagnostics,
    launchIdentity
  });
  registerIpcRoutes(ipcMain, patterm, path.join(app.getPath('userData'), 'uploads'));
  servePeerRoutes(patterm);
  registerCommandRoutes(ipcMain, patterm);

  // Workbench changes arrive as versioned patches; other topics are refetch signals.
  const unsubscribeWorkbenchPatches = patterm.onWorkbenchPatch((patch) => {
    mainWindow?.webContents.send('patterm:workbench:patch', patch);
  });
  const unsubscribeDataChanged = patterm.onDataChanged((topics) => {
    mainWindow?.webContents.send('patterm:data:changed', topics);
  });

  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 980,
    minHeight: 640,
    title: 'Patterm',
    ...windowIcon(),
    autoHideMenuBar: true,
    backgroundColor: '#080b10',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // Markdown/agent content can contain links. Never let them navigate the SPA
  // away or open uncontrolled windows: route http(s) to the OS browser and deny
  // everything else.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url === mainWindow?.webContents.getURL()) {
      return;
    }
    event.preventDefault();
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
  });

  const unsubscribeTerminalFrames = patterm.terminal.onFrame((frame) => {
    if (frame.type === 'terminal-damage') {
      if (!patterm?.terminal.shouldForwardDamageFrame(frame)) {
        return;
      }
      mainWindow?.webContents.send('patterm:terminal:frame', frame.payload);
      return;
    }

    if (frame.type === 'terminal-lifecycle') mainWindow?.webContents.send('patterm:terminal:lifecycle', frame);
  });
  // The desktop window is the only client, so terminal copies and link opens
  // act on this machine directly.
  const unsubscribeClientRequests = patterm.onTerminalClientRequest((request) => {
    if (request.kind === 'clipboard') clipboard.writeText(request.text);
    else void shell.openExternal(request.url);
  });
  const unsubscribeNotifications = patterm.onNotificationsChanged((change) => {
    mainWindow?.webContents.send('patterm:notifications:changed', change);
    const unread = patterm?.notifications.state().unread.reduce((total, row) => total + row.count, 0) ?? 0;
    app.setBadgeCount(unread);
    // Windows taskbars have no badge count; show a dot over the icon instead.
    if (process.platform === 'win32') mainWindow?.setOverlayIcon(unread > 0 ? unreadOverlay() : null, unread > 0 ? `${unread} unread notifications` : '');
  });
  const unsubscribeAssistant = patterm.onAssistantEvent((event) => {
    mainWindow?.webContents.send('patterm:assistant:event', event);
  });
  // The server only asks for these while no Patterm client is focused.
  const unsubscribeDesktopNotifications = patterm.onDesktopNotification((notification) => {
    if (!Notification.isSupported()) return;
    const shown = new Notification({
      title: notification.title,
      body: notification.body,
      urgency: notification.urgency === 'high' ? 'critical' : notification.urgency,
      silent: notification.urgency === 'low'
    });
    shown.on('click', () => {
      if (!mainWindow) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('patterm:navigate', notification.url);
    });
    shown.show();
    if (notification.urgency === 'high') mainWindow?.flashFrame(true);
  });
  mainWindow.on('focus', () => mainWindow?.flashFrame(false));
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (quitPrompt) clearTimeout(quitPrompt.fallback);
    quitPrompt = null;
    unsubscribeNotifications();
    unsubscribeAssistant();
    unsubscribeDesktopNotifications();
    unsubscribeTerminalFrames();
    unsubscribeClientRequests();
    unsubscribeWorkbenchPatches();
    unsubscribeDataChanged();
  });
  mainWindow.on('close', (event) => {
    if (quitComplete) return;
    event.preventDefault();
    requestQuit();
  });

  if (!app.isPackaged && !isInstalledLaunch()) {
    await mainWindow.loadURL('http://127.0.0.1:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    return;
  }

  await mainWindow.loadFile(path.join(__dirname, '../../../renderer/index.html'));
}

if (singleInstanceLock) {
  app.whenReady().then(createWindow).catch((error) => {
    console.error('failed to start patterm desktop', error);
    app.quit();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (event) => {
  if (quitComplete || !patterm) return;
  event.preventDefault();
  requestQuit();
});

ipcMain.on('patterm:quit:shown', (event, id: unknown) => {
  if (event.sender !== mainWindow?.webContents || !quitPrompt || id !== quitPrompt.id) return;
  clearTimeout(quitPrompt.fallback);
  quitPrompt = null;
});

// The window confirms quitting in the app. A window that cannot show the
// dialog (loading, crashed, or unresponsive) falls back to the native one.
function requestQuit(): void {
  // BrowserWindow.webContents itself throws after the window is destroyed.
  const contents = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : undefined;
  if (!patterm || patterm.isShuttingDown() || quitting || !contents || contents.isDestroyed() || contents.isLoading() || contents.isCrashed()) {
    void quitDesktop();
    return;
  }
  if (mainWindow!.isMinimized()) mainWindow!.restore();
  mainWindow!.show();
  mainWindow!.focus();
  if (quitPrompt) clearTimeout(quitPrompt.fallback);
  const id = ++nextQuitPromptId;
  quitPrompt = {
    id,
    fallback: setTimeout(() => {
      if (quitPrompt?.id !== id) return;
      quitPrompt = null;
      void quitDesktop();
    }, 2000)
  };
  contents.send('patterm:quit:request', { id, detail: quitConfirmation(patterm) });
}

function quitDesktop(): Promise<void> {
  return quitting ??= (async () => {
    if (patterm && !patterm.isShuttingDown()) {
      const result = await dialog.showMessageBox({
        type: 'warning', title: 'Quit Patterm and stop all processes?',
        message: 'Quit Patterm and stop all processes?', detail: quitConfirmation(patterm),
        buttons: ['Cancel', 'Quit and stop all'], defaultId: 0, cancelId: 0, noLink: true
      });
      if (result.response !== 1) return;
    }
    await patterm?.shutdown();
    await patterm?.dispose();
    quitComplete = true;
    app.quit();
  })().catch((error) => {
    dialog.showErrorBox('Patterm could not finish shutting down', String(error));
  }).finally(() => { quitting = undefined; });
}

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});

function configureLinuxWindowing(): LaunchDiagnostics {
  const diagnostics: LaunchDiagnostics = {
    platform: process.platform,
    xdgSessionType: process.env.XDG_SESSION_TYPE ?? null,
    waylandDisplay: process.env.WAYLAND_DISPLAY ?? null,
    display: process.env.DISPLAY ?? null,
    mode: 'auto',
    switches: []
  };

  if (process.platform !== 'linux') {
    return diagnostics;
  }

  if (process.env.PATTERM_ENABLE_WAYLAND === '1') {
    appendSwitch(diagnostics, 'enable-wayland-ime');
    appendSwitch(diagnostics, 'ozone-platform', 'wayland');
    appendSwitch(diagnostics, 'enable-features', 'UseOzonePlatform');
    diagnostics.mode = 'wayland';
  }

  if (process.env.PATTERM_DISABLE_GPU === '1') {
    appendSwitch(diagnostics, 'disable-gpu');
    diagnostics.mode = diagnostics.mode === 'wayland' ? 'wayland-gpu-disabled' : 'gpu-disabled';
  }

  return diagnostics;
}

function appendSwitch(diagnostics: LaunchDiagnostics, name: string, value?: string): void {
  if (value === undefined) {
    app.commandLine.appendSwitch(name);
    diagnostics.switches.push({ name });
    return;
  }

  app.commandLine.appendSwitch(name, value);
  diagnostics.switches.push({ name, value });
}

function windowIcon(): { icon?: string } {
  const name = process.platform === 'win32' ? 'icon.ico' : 'icon-512.png';
  const icon = app.isPackaged || isInstalledLaunch()
    ? path.join(__dirname, '../../../renderer/icons', name)
    : path.join(process.cwd(), 'public', 'icons', name);
  return fs.existsSync(icon) ? { icon } : {};
}

let overlay: Electron.NativeImage | null = null;

// A 16px filled dot, drawn once.
function unreadOverlay(): Electron.NativeImage {
  if (overlay) return overlay;
  const size = 16;
  const bitmap = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
      const alpha = Math.round(255 * Math.min(1, Math.max(0, size / 2 - distance)));
      bitmap.set([0x44, 0x44, 0xef, alpha], (y * size + x) * 4);
    }
  }
  overlay = nativeImage.createFromBitmap(bitmap, { width: size, height: size });
  return overlay;
}
