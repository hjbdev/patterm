import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomBytes, scryptSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function singleLine(value) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Configuration values must be non-empty single lines');
  return value;
}

export function validateOrigin(value, port) {
  singleLine(value);
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const tailnet = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net$/.test(url.hostname);
  if (url.origin !== value || (!local && (!tailnet || url.protocol !== 'https:')) || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('PUBLIC_ORIGIN must be an HTTPS tailnet origin (*.ts.net) or an HTTP(S) localhost origin, without a path');
  }
  if (local && Number(url.port || (url.protocol === 'https:' ? 443 : 80)) !== port) throw new Error('The localhost origin port must match PATTERM_PORT');
  return value;
}

export function validateOwnerLogin(value) {
  singleLine(value);
  if (value.length > 320 || /\s/.test(value)) throw new Error('--owner-login must be a Tailscale login name, such as you@example.com or you@github');
  return value;
}

export function unitPath(value) {
  singleLine(value);
  if (!path.isAbsolute(value) || value.trim() !== value || value.endsWith('\\')) throw new Error('Systemd paths must be absolute without surrounding whitespace or a trailing backslash');
  // These directives take a single path, not a quoted command argument.
  return value.replaceAll('%', '%%');
}

export function execArgument(value) {
  return `"${singleLine(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => '$$')}"`;
}

export function environmentValue(value) {
  // EnvironmentFile does not expand systemd % specifiers or shell variables.
  return `"${singleLine(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('`', '\\`')}"`;
}

export function renderService({ root, node, envFile, environment }) {
  const hosts = path.join(environment.PATTERM_DATA_DIR, 'terminal-hosts');
  const substitutions = {
    APP_ROOT: unitPath(root),
    ENV_FILE: unitPath(envFile),
    NODE: execArgument(node),
    ENTRY_POINT: execArgument(path.join(root, 'dist/server/server/main.js')),
    HOST_DIR: `${unitPath(hosts)}/%i`,
    HOST_BINARY: `${execArgument(hosts).slice(0, -1)}/%i/terminal-core"`,
    HOST_SOCKET: `${execArgument(hosts).slice(0, -1)}/%i/control.sock"`
  };
  const unit = fs.readFileSync(path.join(appRoot, 'deploy/patterm.service'), 'utf8')
    .replace(/@(APP_ROOT|ENV_FILE|NODE|ENTRY_POINT)@/g, (_, key) => substitutions[key]);
  const terminalUnit = fs.readFileSync(path.join(appRoot, 'deploy/patterm-terminal@.service'), 'utf8')
    .replace(/@(HOST_DIR|ENV_FILE|HOST_BINARY|HOST_SOCKET)@/g, (_, key) => substitutions[key]);
  const config = Object.entries(environment).map(([key, value]) => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error('Invalid environment variable name');
    return `${key}=${environmentValue(value)}\n`;
  }).join('');
  return { unit, terminalUnit, config };
}

export function readEnvironment(config) {
  const environment = {};
  for (const line of config.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Z_][A-Z0-9_]*)="((?:[^"\\]|\\[\\"$`])*)"$/.exec(line);
    if (!match || Object.hasOwn(environment, match[1])) throw new Error('Unsupported or duplicate setting in patterm.env. Use the service installer to regenerate it.');
    environment[match[1]] = singleLine(match[2].replace(/\\([\\"$`])/g, '$1'));
  }
  return environment;
}

// A release install runs from <home>/versions/<version>. Name it through the
// current symlink instead, as the unit named the fixed install directory
// before, so agents and hosts that outlive an update find the swapped version.
export function stableRoot(root) {
  const current = path.join(root, '../../current');
  try {
    if (path.basename(path.dirname(root)) === 'versions' && fs.realpathSync(current) === root) return current;
  } catch {}
  return root;
}

// The server's password and Remote access setting, in the same file and
// format the server reads (app/Http/ServerAccess.ts).
const REMOTE_ACCESS_MODES = ['local', 'tailscale', 'network'];

export function hashPassword(password) {
  if (password.length < 8) throw new Error('The password needs at least 8 characters');
  if (password.length > 1024) throw new Error('The password can have at most 1024 characters');
  const salt = randomBytes(16);
  const params = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
  const hash = scryptSync(password.normalize('NFKC'), salt, 32, params);
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export function machineAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((entry) => entry && !entry.internal && !(entry.family === 'IPv6' && entry.address.startsWith('fe80')))
    .map((entry) => entry.address);
}

export function checkRemoteChoice(mode, bind, addresses = machineAddresses()) {
  if (!REMOTE_ACCESS_MODES.includes(mode)) throw new Error('--remote-access must be local, tailscale, or network');
  if (mode !== 'network') return;
  if (!bind) throw new Error('--remote-access network needs --bind with one of this machine\'s addresses');
  if (!addresses.includes(bind)) throw new Error(`--bind ${bind} is not an address of this machine. Choose one of: ${addresses.join(', ') || 'none found'}`);
}

// Merges the installer's choices into the existing file. A new password signs
// out every browser, as it does in Settings.
export function serverAccessFile(existing, { mode, bind, ownerLogin, password, addresses = machineAddresses() }) {
  const state = existing ?? { version: 1, password: null, secret: randomBytes(32).toString('base64url') };
  const next = { ...state };
  if (password !== undefined) Object.assign(next, { password: hashPassword(password), secret: randomBytes(32).toString('base64url') });
  if (mode !== undefined) {
    checkRemoteChoice(mode, bind, addresses);
    if (mode === 'network' && !next.password) throw new Error('--remote-access network needs a password. Pass --password-stdin, or set one in Settings › Remote access first.');
    next.remote = { mode, bind: mode === 'network' ? bind : null, owner_login: mode === 'tailscale' ? ownerLogin ?? null : null };
  }
  return next;
}

// Reads a password from standard input, or asks for it on a terminal without
// showing it.
function readPassword(fromStdin) {
  if (fromStdin) return fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  if (!process.stdin.isTTY) throw new Error('No password given. Pass it on standard input with --password-stdin.');
  const ask = (prompt) => {
    process.stderr.write(prompt);
    const result = spawnSync('sh', ['-c', 'stty -echo; IFS= read -r value; status=$?; stty echo; printf "%s" "$value"; exit $status'], { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' });
    process.stderr.write('\n');
    if (result.status !== 0) throw new Error('No password given');
    return result.stdout;
  };
  const password = ask('Password for Patterm: ');
  if (ask('Password again: ') !== password) throw new Error('The passwords are different');
  return password;
}

function readAccess(data) {
  try {
    return JSON.parse(fs.readFileSync(path.join(data, 'server-access.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// The server's runtime lock: an exclusive SQLite transaction on
// runtime.lock.db, as app/Runtime/ApplicationLock.ts takes it.
function withRuntimeLock(directory, action) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const lock = new DatabaseSync(path.join(directory, 'runtime.lock.db'));
  try {
    lock.exec('pragma busy_timeout = 0; begin exclusive');
  } catch {
    lock.close();
    throw new Error('Patterm is using this data directory. Change Remote access or the password in Settings › Remote access, or stop patterm.service first.');
  }
  try {
    return action();
  } finally {
    lock.close();
  }
}

// Replaces a complete file without following an existing destination symlink.
function writePrivateFile(filename, contents) {
  const temporary = `${filename}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, filename);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function shellArgument(value) {
  return `'${singleLine(value).replaceAll("'", "'\\''")}'`;
}

export function install(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    'output-dir': { type: 'string' },
    'public-origin': { type: 'string' },
    'owner-login': { type: 'string' },
    'data-dir': { type: 'string' },
    'remote-access': { type: 'string' },
    bind: { type: 'string' },
    'password-stdin': { type: 'boolean' },
    password: { type: 'boolean' },
    update: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' }
  } });
  if (values.help) {
    console.log('Usage: pnpm run install:service [--remote-access local|tailscale|network] [--bind ADDRESS] [--password | --password-stdin] [--owner-login LOGIN] [--data-dir PATH] [--output-dir PATH]\n--remote-access chooses where browsers can open Patterm from: this machine (the default), your tailnet through Tailscale Serve, or a network address given with --bind, which needs a password.\n--password asks for a password; --password-stdin reads it from standard input.\n--owner-login refuses tailnet requests that Tailscale says come from anyone but this login.\n--public-origin sets the browser origin for a server without a Remote access setting.\n--update preserves settings from the installed patterm.env.\n--output-dir writes preview files only; it does not require built server artefacts.');
    return;
  }
  if (process.platform !== 'linux') throw new Error('The user-service installer requires Linux');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24 || major >= 27) throw new Error('Patterm server requires Node >=24 <27');
  const home = os.homedir();
  const configHome = path.resolve(process.env.XDG_CONFIG_HOME || path.join(home, '.config'));
  const previous = values.update ? readEnvironment(fs.readFileSync(path.join(configHome, 'patterm/patterm.env'), 'utf8')) : {};
  const port = Number(previous.PATTERM_PORT ?? process.env.PATTERM_PORT ?? '8787');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PATTERM_PORT must be between 1 and 65535');
  // With a Remote access setting, the server works out its own origin.
  const chosenAccess = values['remote-access'];
  const origin = validateOrigin(values['public-origin'] ?? previous.PATTERM_PUBLIC_ORIGIN ?? (process.env.PATTERM_PUBLIC_ORIGIN || process.env.PUBLIC_ORIGIN || (chosenAccess ? `http://localhost:${port}` : '')), port);
  const ownerLogin = values['owner-login'] ?? previous.PATTERM_OWNER_LOGIN;
  if (ownerLogin !== undefined) validateOwnerLogin(ownerLogin);
  const realRoot = fs.realpathSync(appRoot);
  const root = stableRoot(realRoot);
  const execPath = fs.realpathSync(process.execPath);
  // Release tarballs bundle Node. Keep it off PATH so agents use their own.
  const bundled = execPath === path.join(realRoot, 'runtime/node');
  const node = bundled ? path.join(root, 'runtime/node') : execPath;
  const data = path.resolve(values['data-dir'] ?? previous.PATTERM_DATA_DIR ?? process.env.PATTERM_DATA_DIR ?? path.join(home, '.local/share/patterm-server'));
  if (values.update && previous.PATTERM_DATA_DIR && data !== path.resolve(previous.PATTERM_DATA_DIR)) {
    throw new Error('An update cannot change PATTERM_DATA_DIR. Quit Patterm to stop its terminal hosts before preparing a service for a different data directory.');
  }
  const installedRoot = path.resolve(process.env.XDG_DATA_HOME || path.join(home, '.local/share'), 'patterm-desktop');
  const releaseHome = path.resolve(process.env.PATTERM_HOME || path.join(process.env.XDG_DATA_HOME || path.join(home, '.local/share'), 'patterm'));
  if ([root, realRoot, installedRoot, releaseHome].some((directory) => data === directory || data.startsWith(`${directory}${path.sep}`))) {
    throw new Error('PATTERM_DATA_DIR must be outside the application installation so updates cannot replace its databases or terminal hosts.');
  }
  const preview = values['output-dir'] ? path.resolve(values['output-dir']) : null;
  const unitDir = preview ?? path.join(configHome, 'systemd/user');
  const configDir = preview ?? path.join(configHome, 'patterm');
  const envFile = path.join(configDir, 'patterm.env');
  const sidecar = path.join(root, 'native/terminal-core/target/release/patterm-terminal-core');
  const shim = path.join(root, 'dist/mcp/patterm-mcp.js');
  if (!preview) {
    for (const filename of [path.join(root, 'dist/server/server/main.js'), path.join(root, 'dist/renderer/index.html'), shim]) fs.accessSync(filename, fs.constants.R_OK);
    fs.accessSync(sidecar, fs.constants.X_OK);
  }
  const environment = {
    NODE_ENV: 'production',
    HOME: home,
    SHELL: process.env.SHELL || '/bin/bash',
    PATH: [...new Set([...(bundled ? [] : [path.dirname(node)]), ...(process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(':').filter((entry) => path.isAbsolute(entry))])].join(':'),
    ...previous,
    PATTERM_DATA_DIR: data,
    PATTERM_PORT: String(port),
    PATTERM_PUBLIC_ORIGIN: origin,
    ...(ownerLogin ? { PATTERM_OWNER_LOGIN: ownerLogin } : {}),
    PATTERM_SIDECAR: sidecar,
    PATTERM_MCP_SHIM: shim,
    PATTERM_TERMINAL_SERVICE: 'patterm-terminal',
    ...(bundled ? { PATTERM_NODE: node } : {})
  };
  if (!bundled) delete environment.PATTERM_NODE;
  const accessFile = path.join(preview ?? data, 'server-access.json');
  let access = null;
  if (chosenAccess !== undefined) checkRemoteChoice(chosenAccess, values.bind);
  if (chosenAccess !== undefined || values.password || values['password-stdin']) {
    // Ask for the password before taking the lock, so a slow answer never
    // keeps the server from starting.
    const needsPassword = values.password || values['password-stdin'] || (chosenAccess === 'network' && !readAccess(data)?.password);
    const password = needsPassword ? readPassword(Boolean(values['password-stdin'])) : undefined;
    const merge = () => serverAccessFile(readAccess(data), { mode: chosenAccess, bind: values.bind, ownerLogin: ownerLogin ?? null, ...(password !== undefined ? { password } : {}) });
    if (preview) access = merge();
    else {
      // The server reads this file under its runtime lock and keeps it in
      // memory, so it changes only while Patterm is not using the directory.
      withRuntimeLock(data, () => {
        access = merge();
        writePrivateFile(accessFile, `${JSON.stringify(access, null, 2)}\n`);
      });
    }
  }
  const { unit, terminalUnit, config } = renderService({ root, node, envFile, environment });
  for (const directory of new Set([unitDir, configDir, ...(access && preview ? [preview] : [])])) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const files = [[envFile, config], [path.join(unitDir, 'patterm.service'), unit], [path.join(unitDir, 'patterm-terminal@.service'), terminalUnit]];
  if (access && preview) files.push([accessFile, `${JSON.stringify(access, null, 2)}\n`]);
  for (const [filename, contents] of files) writePrivateFile(filename, contents);
  console.log(`${preview ? 'Preview' : 'Prepared'}: ${path.join(unitDir, 'patterm.service')}\nTerminal hosts: ${path.join(unitDir, 'patterm-terminal@.service')}\nConfiguration: ${envFile}\nData directory (created on startup): ${data}`);
  if (preview) {
    console.log('No live configuration, service, or Tailscale settings were changed. Run without --output-dir to install.');
    return;
  }
  const reach = access?.remote?.mode === 'tailscale'
    ? 'Patterm adds its own route to Tailscale Serve when it starts, leaving other routes alone. Settings › Remote access shows the address.'
    : access?.remote?.mode === 'network'
      ? `Patterm will listen on ${access.remote.bind}, port ${port}, with the password you set.`
      : access?.remote
        ? 'Patterm is open only to this machine. Change that in Settings › Remote access or with --remote-access.'
        : `To reach Patterm from your tailnet, run this again with --remote-access tailscale, or inspect existing Serve routes and run:\ntailscale serve --bg --https=443 http://127.0.0.1:${port}\nThen verify the reported URL matches ${origin} and restrict tailnet access to the owner.`;
  console.log(`Review the unit and configuration, then run:\nsystemctl --user daemon-reload\nsystemctl --user enable --now patterm.service\nloginctl enable-linger ${shellArgument(os.userInfo().username)}\n\n${reach}\nLogs: journalctl --user -u patterm.service -f`);
}

// Node resolves symlinks in the module URL, such as a release install's current.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { install(); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
