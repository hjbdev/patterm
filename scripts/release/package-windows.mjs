#!/usr/bin/env node
// Packages a built checkout as a portable Windows desktop zip with bundled
// Electron and the release terminal sidecar. Run the builds first:
//   pnpm run build:main && pnpm run build:renderer && pnpm run build:mcp
//   pnpm run build:sidecar:release
// Usage: node scripts/release/package-windows.mjs --version 1.2.0 --sidecar PATH --out DIR
// Unzip and run Patterm.cmd, or use the per-user PowerShell release installer.
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadElectron } from './download-electron.mjs';
import { brandWindowsExecutable } from './brand-windows.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const USAGE = 'Usage: package-windows.mjs --version VERSION --sidecar PATH --out DIR';
const ARCH = 'x64';
// Shiki's GPL-3.0 grammars and theme must stay out of releases (see package.sh).
const GPL_SHIKI = ['ada', 'gnuplot', 'nginx', 'racket', 'aurora-x'];
const GPL_SHIKI_PATTERN = new RegExp(`\\\\?"name\\\\?":\\\\?"(${GPL_SHIKI.join('|')})\\\\?"`);

const options = parseArgs(process.argv.slice(2));
if (process.platform !== 'win32') fail('package the Windows release on Windows, where pnpm installs the matching optional dependencies');
if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(options.version ?? '')) fail('--version must be a semantic version without a leading v');
if (!options.sidecar || !fs.statSync(options.sidecar, { throwIfNoEntry: false })?.isFile()) fail('--sidecar must name the built release sidecar');
if (!options.out) fail('--out is required');
for (const file of ['dist/main/desktop/main/main.js', 'dist/renderer/index.html', 'dist/renderer/icons/icon.ico', 'dist/mcp/patterm-mcp.js']) {
  if (!fs.existsSync(path.join(ROOT, file))) fail(`${file} is missing; build first`);
}
const tainted = filesContaining(path.join(ROOT, 'dist', 'renderer'), GPL_SHIKI_PATTERN);
if (tainted.length) fail(`the renderer build includes a GPL-3.0 Shiki grammar or theme:\n${tainted.join('\n')}`);

const name = `patterm-${options.version}-windows-${ARCH}`;
const out = path.resolve(options.out);
const stage = path.join(out, name);
const zip = path.join(out, `${name}.zip`);
const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-package-'));
try {
  fs.mkdirSync(out, { recursive: true });
  for (const target of [stage, zip, `${zip}.sha256`]) fs.rmSync(target, { recursive: true, force: true });
  for (const dir of ['dist', 'resources/native', 'resources/mcp']) fs.mkdirSync(path.join(stage, dir), { recursive: true });

  for (const dir of ['main', 'renderer', 'mcp']) fs.cpSync(path.join(ROOT, 'dist', dir), path.join(stage, 'dist', dir), { recursive: true });
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) fs.copyFileSync(path.join(ROOT, file), path.join(stage, file));
  // The tag is the version; package.json in the repository stays at its placeholder.
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  manifest.version = options.version;
  fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // Production dependencies only. The one native package, node-llama-cpp's
  // prebuilt CPU binary, installs for this runner's platform.
  for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) fs.copyFileSync(path.join(ROOT, file), path.join(stage, file));
  execSync('pnpm install --prod --frozen-lockfile --ignore-scripts --config.node-linker=hoisted --reporter=silent', { cwd: stage, stdio: 'inherit' });
  for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) fs.rmSync(path.join(stage, file));
  if (fs.existsSync(path.join(stage, 'node_modules', 'electron'))) fail('the production install includes electron');
  // llama.cpp's source, which node-llama-cpp needs only to build from source. Patterm uses its prebuilt binaries.
  fs.rmSync(path.join(stage, 'node_modules', 'node-llama-cpp', 'llama', 'gitRelease.bundle'), { force: true });
  for (const grammar of GPL_SHIKI) {
    for (const dir of ['@shikijs/langs/dist', '@shikijs/themes/dist', 'shiki/dist/langs', 'shiki/dist/themes']) {
      for (const extension of ['mjs', 'd.mts']) fs.rmSync(path.join(stage, 'node_modules', dir, `${grammar}.${extension}`), { force: true });
    }
  }
  const remaining = filesContaining(path.join(stage, 'node_modules'), GPL_SHIKI_PATTERN);
  if (remaining.length) fail(`the production install still includes a GPL-3.0 Shiki grammar or theme:\n${remaining.join('\n')}`);

  // Electron for the desktop app, checked against the hashes in its npm package.
  const electronVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
  const electronZip = `electron-v${electronVersion}-win32-${ARCH}.zip`;
  const expected = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'checksums.json'), 'utf8'))[electronZip];
  if (!expected) fail(`electron/checksums.json has no hash for ${electronZip}`);
  const downloaded = path.join(downloads, electronZip);
  await downloadElectron(`https://github.com/electron/electron/releases/download/v${electronVersion}/${electronZip}`, downloaded, expected);
  const actual = sha256(downloaded);
  if (actual !== expected) fail(`${electronZip} has SHA-256 ${actual}, expected ${expected}`);
  fs.mkdirSync(path.join(stage, 'electron'));
  execFileSync('tar', ['-xf', downloaded, '-C', path.join(stage, 'electron')], { stdio: 'inherit' });

  const executable = path.join(stage, 'electron', 'electron.exe');
  fs.writeFileSync(executable, brandWindowsExecutable(fs.readFileSync(executable),
    fs.readFileSync(path.join(ROOT, 'dist/renderer/icons/icon.ico')), options.version));
  // Electron's toast registration creates direct executable shortcuts, without
  // our command launcher or its environment. Make that launch work as well.
  const appDirectory = path.join(stage, 'electron/resources/app');
  fs.mkdirSync(appDirectory, { recursive: true });
  fs.writeFileSync(path.join(appDirectory, 'package.json'), JSON.stringify({
    name: 'patterm-desktop', productName: 'Patterm', version: options.version, main: 'main.cjs'
  }));
  fs.writeFileSync(path.join(appDirectory, 'main.cjs'), [
    "const path = require('node:path');",
    "const root = path.resolve(__dirname, '../../..');",
    "process.env.PATTERM_DESKTOP_RESOURCES = path.join(root, 'resources');",
    "process.chdir(root);",
    // Older installed updaters run their own installer, so repair on launch too.
    "if (path.basename(path.dirname(root)).toLowerCase() === 'versions') {",
    "  require('node:child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/install.ps1'), '-InstallRoot', path.resolve(root, '../..'), '-RepairShortcutsOnly'], { windowsHide: true, timeout: 10000 }, (error) => {",
    "    if (error) console.warn('Could not repair legacy Patterm shortcut:', error.message);",
    "  });",
    "}",
    "require(path.join(root, 'dist/main/desktop/main/main.js'));", ''
  ].join('\n'));

  // Installed 0.2.x updaters require electron.exe when validating the new zip.
  // Keep that compatibility copy while the launcher runs Patterm.exe.
  fs.copyFileSync(path.join(stage, 'electron', 'electron.exe'), path.join(stage, 'electron', 'Patterm.exe'));

  fs.copyFileSync(options.sidecar, path.join(stage, 'resources', 'native', 'patterm-terminal-core.exe'));
  fs.copyFileSync(path.join(ROOT, 'dist', 'mcp', 'patterm-mcp.js'), path.join(stage, 'resources', 'mcp', 'patterm-mcp.js'));
  fs.writeFileSync(path.join(stage, 'Patterm.cmd'), launcher());
  // The in-app updater checks releases with this key and installs through the helper.
  fs.mkdirSync(path.join(stage, 'scripts'));
  for (const file of ['apply-update.ps1', 'install.ps1', 'minisign.pub']) fs.copyFileSync(path.join(ROOT, 'scripts', 'release', file), path.join(stage, 'scripts', file));

  const commit = git('rev-parse', 'HEAD');
  const dirty = git('status', '--porcelain') !== '';
  fs.writeFileSync(path.join(stage, 'BUILD'), [
    `version=${options.version}`, `commit=${commit}`, ...(dirty ? ['dirty=true'] : []), `built_at=${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}`, ''
  ].join('\n'));

  // Windows 10 and later ship bsdtar, which writes zip archives.
  execFileSync('tar', ['-a', '-cf', zip, '-C', out, name], { stdio: 'inherit' });
  fs.writeFileSync(`${zip}.sha256`, `${sha256(zip)}  ${path.basename(zip)}\n`);
  fs.rmSync(stage, { recursive: true, force: true });
  console.log(zip);
} finally {
  fs.rmSync(downloads, { recursive: true, force: true });
}

// Mirrors scripts/patterm.sh: the desktop app finds its sidecar and MCP shim
// through PATTERM_DESKTOP_RESOURCES.
function launcher() {
  return [
    '@echo off',
    'setlocal',
    'set "APP_DIR=%~dp0"',
    'set "APP_DIR=%APP_DIR:~0,-1%"',
    'set "PATTERM_DESKTOP_RESOURCES=%APP_DIR%\\resources"',
    'set "ELECTRON_RUN_AS_NODE="',
    'cd /d "%APP_DIR%"',
    'start "" "%APP_DIR%\\electron\\Patterm.exe" %*',
    ''
  ].join('\r\n');
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = { '--version': 'version', '--sidecar': 'sidecar', '--out': 'out' }[args[index]];
    if (!key || args[index + 1] === undefined) fail(USAGE);
    parsed[key] = args[index + 1];
  }
  return parsed;
}

function filesContaining(dir, pattern) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(m?js|json)$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => pattern.test(fs.readFileSync(file, 'utf8')));
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function git(...args) {
  return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' }).trim();
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}
