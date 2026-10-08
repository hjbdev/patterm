import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { environmentValue, install, readEnvironment, validateOrigin } from './install-service.mjs';

function run(command, args, inherited = false) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: inherited ? 'inherit' : 'pipe' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed. ${result.stderr?.trim() ?? ''}`);
  return result.stdout?.trim();
}

export function tailscaleOrigin(status) {
  if (status.BackendState !== 'Running' || !status.Self?.DNSName) {
    throw new Error('Tailscale must be connected. Run tailscale up first.');
  }
  const hostname = status.Self.DNSName.replace(/\.$/, '');
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net$/.test(hostname)) throw new Error('Tailscale did not return a valid ts.net hostname.');
  return validateOrigin(`https://${hostname}`, 8787);
}

// The login of the user this machine belongs to. Tagged machines have none.
export function tailscaleOwner(status) {
  const login = status.User?.[String(status.Self?.UserID)]?.LoginName;
  return typeof login === 'string' && login && !login.startsWith('tagged-devices') ? login : null;
}

// Patterm uses only the root path of HTTPS port 443; other apps' paths stay.
export function checkServe(config, origin, port) {
  const endpoint = `${new URL(origin).hostname}:443`;
  if (config.AllowFunnel?.[endpoint]) throw new Error('Funnel is enabled on this endpoint. Disable it before exposing Patterm.');
  // Foreground sessions can own listeners independently of the background configuration.
  if (Object.keys(config.Foreground ?? {}).length) throw new Error('An active foreground Serve session exists. Inspect tailscale serve status first.');
  const listener = config.TCP?.['443'];
  if (listener && listener.HTTPS !== true) throw new Error('Tailscale port 443 already carries another route that is not HTTPS. Inspect tailscale serve status; Patterm will not replace it.');
  const handler = config.Web?.[endpoint]?.Handlers?.['/'];
  if (!handler) return false;
  if (handler.Proxy === `http://127.0.0.1:${port}`) return true;
  throw new Error(`Tailscale already serves another route at ${origin}/. Inspect tailscale serve status; Patterm will not replace it.`);
}

export function serviceSettings(config) {
  // Only read the two scalar settings emitted by our installer; never source an environment file.
  const read = (key) => {
    const lines = config.split('\n').filter((line) => line.startsWith(`${key}=`));
    if (lines.length !== 1) throw new Error(`Expected one ${key} setting in patterm.env.`);
    const value = lines[0].slice(key.length + 1);
    if (!/^"[^"\\]*"$/.test(value)) throw new Error(`Unsupported ${key} format in patterm.env. Use the service installer.`);
    return value.slice(1, -1);
  };
  const port = Number(read('PATTERM_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PATTERM_PORT in patterm.env.');
  return { port, origin: read('PATTERM_PUBLIC_ORIGIN') };
}

// The mode in the server's saved Remote access setting, or null for a server
// set up before the setting existed.
export function savedRemoteAccess(config) {
  const dataDir = readEnvironment(config).PATTERM_DATA_DIR;
  if (!dataDir) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'server-access.json'), 'utf8')).remote?.mode ?? null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function start() {
  if (process.getuid?.() === 0) throw new Error('Run patterm as your normal user, without sudo.');
  const status = JSON.parse(run('tailscale', ['status', '--json']));
  const origin = tailscaleOrigin(status);
  const owner = tailscaleOwner(status);
  const loaded = run('systemctl', ['--user', 'show', 'patterm.service', '--property=LoadState', '--value']);
  if (!['loaded', 'not-found'].includes(loaded)) throw new Error(`Cannot load patterm.service: ${loaded}`);
  const exists = loaded === 'loaded';
  const envFile = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'patterm/patterm.env');
  const config = exists ? fs.readFileSync(envFile, 'utf8') : null;
  const settings = exists ? serviceSettings(config) : { port: Number(process.env.PATTERM_PORT ?? 8787), origin };
  if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535) throw new Error('Invalid PATTERM_PORT.');
  const alreadyServing = checkServe(JSON.parse(run('tailscale', ['serve', 'status', '--json'])), origin, settings.port);
  // A server whose Remote access setting names another mode would remove the
  // route again when it starts, so switch the setting to Tailscale too.
  const savedMode = exists ? savedRemoteAccess(config) : null;
  if (savedMode && savedMode !== 'tailscale') {
    const state = run('systemctl', ['--user', 'show', 'patterm.service', '--property=ActiveState', '--value']);
    if (!['inactive', 'failed'].includes(state)) {
      throw new Error(`Patterm is set to ${savedMode === 'local' ? 'this machine only' : 'network'} access. Switch to Tailscale in Settings › Remote access, or stop it with systemctl --user stop patterm.service and retry.`);
    }
    install(['--update', '--remote-access', 'tailscale', '--public-origin', origin]);
    run('systemctl', ['--user', 'daemon-reload']);
  } else if (exists && settings.origin !== origin) {
    const state = run('systemctl', ['--user', 'show', 'patterm.service', '--property=ActiveState', '--value']);
    if (!['inactive', 'failed'].includes(state)) {
      throw new Error('The running service uses a different browser origin. Stop it with systemctl --user stop patterm.service, then retry. Independently hosted terminals continue running.');
    }
    const temporary = `${envFile}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, config.replace(/^PATTERM_PUBLIC_ORIGIN=.*$/m, `PATTERM_PUBLIC_ORIGIN=${environmentValue(origin)}`), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, envFile);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  if (exists && owner && !/^PATTERM_OWNER_LOGIN=/m.test(config)) {
    const installer = path.join(path.dirname(fileURLToPath(import.meta.url)), 'install-service.mjs');
    console.log(`Patterm accepts any tailnet user your policy allows. To accept only ${owner}, run:\n${process.execPath} ${installer} --update --owner-login ${owner}\nthen restart patterm.service.`);
  }
  if (!exists) {
    install(['--public-origin', origin, '--remote-access', 'tailscale', ...(owner ? ['--owner-login', owner] : [])]);
    run('systemctl', ['--user', 'daemon-reload']);
  }
  run('systemctl', ['--user', 'start', 'patterm.service']);
  if (!alreadyServing) {
    console.log('Tailscale access follows your tailnet policy. Restrict this machine’s TCP port 443 to your identity, or set a password in Settings › Remote access.');
    try {
      run('tailscale', ['serve', '--bg', '--https=443', '--set-path=/', `http://127.0.0.1:${settings.port}`], true);
    } catch (error) {
      throw new Error(`${error.message}\nIf Tailscale requires permission, run sudo tailscale set --operator=${os.userInfo().username}, then retry this command. Patterm itself must run without sudo.`);
    }
  }
  console.log(`Patterm: ${origin}\nStop the web service: systemctl --user stop patterm.service\nUse Quit in Patterm to stop all agents and terminals.`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { start(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
