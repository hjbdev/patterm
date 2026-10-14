import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createApplication, type PattermApplication } from '../app/App';
import { WebServer } from '../app/Http/WebServer';
import { servePeerRoutes } from '../routes/remote';
import { ServerAccess } from '../app/Http/ServerAccess';
import { applyTailscaleRoute, planRemoteAccess } from '../app/Http/RemoteAccessPlan';
import { TailscaleService } from '../app/Services/TailscaleService';
import { acquireApplicationLock } from '../app/Runtime/ApplicationLock';

// EX_TEMPFAIL: systemd's Restart=on-failure starts the service again.
const RESTART_EXIT_CODE = 75;

async function main(): Promise<void> {
  process.umask(0o077);
  const root = path.resolve(__dirname, '../../..');
  const port = Number(process.env.PATTERM_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PATTERM_PORT must be between 1 and 65535');
  const appDataPath = path.resolve(process.env.PATTERM_DATA_DIR ?? path.join(os.homedir(), '.local/share/patterm-server'));
  const sidecarPath = process.env.PATTERM_SIDECAR ?? path.join(root, 'native/terminal-core/target/release', process.platform === 'win32' ? 'patterm-terminal-core.exe' : 'patterm-terminal-core');
  const mcpShimPath = process.env.PATTERM_MCP_SHIM ?? path.join(root, 'dist/mcp/patterm-mcp.js');
  const rendererPath = path.join(root, 'dist/renderer');
  for (const filename of [sidecarPath, mcpShimPath, path.join(rendererPath, 'index.html')]) fs.accessSync(filename, fs.constants.R_OK);
  fs.accessSync(sidecarPath, fs.constants.X_OK);
  // Settings › Remote access and the installer choose how browsers reach the
  // server. Servers set up before that keep PATTERM_PUBLIC_ORIGIN. The
  // installer writes the setting under the runtime lock, so read it only once
  // the lock is held.
  const runtimeLock = acquireApplicationLock(appDataPath);
  let serverAccess: ServerAccess;
  let plan: Awaited<ReturnType<typeof planRemoteAccess>>;
  const tailscale = new TailscaleService();
  try {
    serverAccess = ServerAccess.forDataDirectory(appDataPath);
    plan = await planRemoteAccess({
      access: serverAccess.remoteAccess(), passwordSet: serverAccess.passwordSet(), port,
      envOrigin: process.env.PATTERM_PUBLIC_ORIGIN, envOwnerLogin: process.env.PATTERM_OWNER_LOGIN, tailscale
    });
  } catch (error) {
    runtimeLock();
    throw error;
  }
  const publicOrigin = plan.origin;
  const ownerLogin = plan.ownerLogin ?? undefined;
  let application: PattermApplication | undefined;
  let server: WebServer | undefined;
  let stopping: Promise<void> | undefined;
  const stop = (exitCode: number) => stopping ??= (async () => {
    process.exitCode = exitCode;
    const timeout = setTimeout(() => process.exit(exitCode || 1), 20_000);
    try {
      await server?.stop();
      await application?.dispose();
    } finally {
      clearTimeout(timeout);
    }
    // Lingering handles must not keep a stopped server alive with no listener.
    process.exit(exitCode);
  })();
  try {
    application = await createApplication({
      appDataPath, sidecarPath, mcpShimPath, runtime: 'node', appRoot: root, publicOrigin, serverAccess, runtimeLock, ...(ownerLogin ? { ownerLogin } : {}),
      ...(process.env.PATTERM_TERMINAL_SERVICE ? { terminalHosts: { appDataPath, serviceName: process.env.PATTERM_TERMINAL_SERVICE } } : {}),
      onQuitRequested: () => { setImmediate(() => { void stop(0).catch((error) => { console.error(error); process.exit(1); }); }); }
    });
    if (!application.terminal.isAvailable()) throw new Error('Terminal sidecar is unavailable');
    servePeerRoutes(application);
    server = new WebServer(application, {
      port, publicOrigin, rendererPath, appDataPath, listen: plan.listen, tailscale, remoteAccess: plan, ...(ownerLogin ? { ownerLogin } : {}),
      // Under systemd, a failed exit restarts the service; terminal hosts and
      // their agents keep running.
      ...(process.env.INVOCATION_ID ? { restart: () => { void stop(RESTART_EXIT_CODE).catch((error) => { console.error(error); process.exit(1); }); } } : {})
    });
    await server.start();
    await applyTailscaleRoute(plan, port, tailscale);
    for (const warning of plan.warnings) console.warn(warning);
    application.terminal.onExit(() => {
      if (stopping || application?.isShuttingDown()) return;
      console.error('Terminal sidecar exited; stopping for service recovery');
      void stop(1).catch((error) => { console.error(error); process.exit(1); });
    });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
      void stop(0).catch((error) => { console.error(error); process.exit(1); });
    });
    console.log(`Patterm listening on ${['127.0.0.1', ...plan.listen].join(', ')} port ${port}; remote access ${plan.mode}; browser origin ${publicOrigin}; ${ownerLogin ? `tailnet owner ${ownerLogin}` : 'no tailnet owner check'}; data ${appDataPath}`);
  } catch (error) {
    console.error(error);
    await stop(1).catch((cleanupError) => console.error(cleanupError));
    throw error;
  }
}

if (require.main === module) void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
