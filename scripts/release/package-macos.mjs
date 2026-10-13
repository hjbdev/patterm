#!/usr/bin/env node
// Packages a built checkout as a macOS .app zip with bundled
// Electron and the release terminal sidecar. Run the builds first:
//   pnpm run build:main && pnpm run build:renderer && pnpm run build:mcp
//   pnpm run build:sidecar:release
// Usage: node scripts/release/package-macos.mjs --version 1.2.0 --sidecar PATH --out DIR
// Run on the target Mac architecture. The resulting app is ad-hoc signed, not notarized.
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const USAGE = 'Usage: package-macos.mjs --version VERSION --sidecar PATH --out DIR';
const ARCH = process.arch;
// Shiki's GPL-3.0 grammars and theme must stay out of releases (see package.sh).
const GPL_SHIKI = ['ada', 'gnuplot', 'nginx', 'racket', 'aurora-x'];
const GPL_SHIKI_PATTERN = new RegExp(`\\\\?"name\\\\?":\\\\?"(${GPL_SHIKI.join('|')})\\\\?"`);

const options = parseArgs(process.argv.slice(2));
if (process.platform !== 'darwin' || !['x64', 'arm64'].includes(ARCH)) fail('package the macOS release on an Intel or Apple Silicon Mac');
if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(options.version ?? '')) fail('--version must be a semantic version without a leading v');
if (!options.sidecar || !fs.statSync(options.sidecar, { throwIfNoEntry: false })?.isFile()) fail('--sidecar must name the built release sidecar');
if (!options.out) fail('--out is required');
for (const file of ['dist/main/desktop/main/main.js', 'dist/renderer/index.html', 'dist/mcp/patterm-mcp.js']) {
  if (!fs.existsSync(path.join(ROOT, file))) fail(`${file} is missing; build first`);
}
const tainted = filesContaining(path.join(ROOT, 'dist', 'renderer'), GPL_SHIKI_PATTERN);
if (tainted.length) fail(`the renderer build includes a GPL-3.0 Shiki grammar or theme:\n${tainted.join('\n')}`);

const name = `patterm-${options.version}-macos-${ARCH}`;
const out = path.resolve(options.out);
const stage = path.join(out, name);
const zip = path.join(out, `${name}.zip`);
const bundle = path.join(stage, 'Patterm.app');
const resources = path.join(bundle, 'Contents', 'Resources');
const app = path.join(resources, 'app');
const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-package-'));
try {
  fs.mkdirSync(out, { recursive: true });
  for (const target of [stage, zip, `${zip}.sha256`]) fs.rmSync(target, { recursive: true, force: true });
  // Use Electron's verified distribution, preserving framework symlinks and modes.
  const electronVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
  const electronZip = `electron-v${electronVersion}-darwin-${ARCH}.zip`;
  const expected = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'checksums.json'), 'utf8'))[electronZip];
  if (!expected) fail(`electron/checksums.json has no hash for ${electronZip}`);
  const downloaded = path.join(downloads, electronZip);
  await download(`https://github.com/electron/electron/releases/download/v${electronVersion}/${electronZip}`, downloaded);
  if (sha256(downloaded) !== expected) fail(`${electronZip} failed SHA-256 verification`);
  execFileSync('ditto', ['-x', '-k', downloaded, downloads], { stdio: 'inherit' });
  fs.mkdirSync(stage, { recursive: true });
  fs.renameSync(path.join(downloads, 'Electron.app'), bundle);
  fs.rmSync(path.join(resources, 'default_app.asar'));
  for (const dir of [app, path.join(resources, 'native'), path.join(resources, 'mcp')]) fs.mkdirSync(dir, { recursive: true });
  for (const dir of ['main', 'renderer', 'mcp']) fs.cpSync(path.join(ROOT, 'dist', dir), path.join(app, 'dist', dir), { recursive: true });
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) fs.copyFileSync(path.join(ROOT, file), path.join(app, file));
  fs.copyFileSync(path.join(downloads, 'LICENSE'), path.join(resources, 'ELECTRON_LICENSE'));
  fs.copyFileSync(path.join(downloads, 'LICENSES.chromium.html'), path.join(resources, 'LICENSES.chromium.html'));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  manifest.version = options.version;
  fs.writeFileSync(path.join(app, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) fs.copyFileSync(path.join(ROOT, file), path.join(app, file));
  execSync('pnpm install --prod --frozen-lockfile --ignore-scripts --config.node-linker=hoisted --reporter=silent', { cwd: app, stdio: 'inherit' });
  for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) fs.rmSync(path.join(app, file));
  if (fs.existsSync(path.join(app, 'node_modules', 'electron'))) fail('the production install includes electron');
  for (const grammar of GPL_SHIKI) {
    for (const dir of ['@shikijs/langs/dist', '@shikijs/themes/dist', 'shiki/dist/langs', 'shiki/dist/themes']) {
      for (const extension of ['mjs', 'd.mts']) fs.rmSync(path.join(app, 'node_modules', dir, `${grammar}.${extension}`), { force: true });
    }
  }
  const remaining = filesContaining(path.join(app, 'node_modules'), GPL_SHIKI_PATTERN);
  if (remaining.length) fail(`the production install still includes a GPL-3.0 Shiki grammar or theme:\n${remaining.join('\n')}`);

  const sidecar = path.join(resources, 'native', 'patterm-terminal-core');
  fs.copyFileSync(options.sidecar, sidecar);
  fs.chmodSync(sidecar, 0o755);
  // Refuse a sidecar from the wrong architecture before signing the bundle.
  execFileSync('lipo', [sidecar, '-verify_arch', ARCH === 'arm64' ? 'arm64' : 'x86_64'], { stdio: 'inherit' });
  fs.copyFileSync(path.join(ROOT, 'dist', 'mcp', 'patterm-mcp.js'), path.join(resources, 'mcp', 'patterm-mcp.js'));
  const plist = path.join(bundle, 'Contents', 'Info.plist');
  for (const [key, value] of Object.entries({
    CFBundleDisplayName: 'Patterm', CFBundleName: 'Patterm', CFBundleIdentifier: 'cloud.bayliss.patterm',
    CFBundleShortVersionString: options.version.split('-')[0], CFBundleVersion: options.version.split('-')[0]
  })) execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);

  const iconset = path.join(downloads, 'patterm.iconset');
  fs.mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      execFileSync('sips', ['-z', String(size * scale), String(size * scale),
        path.join(ROOT, 'public', 'icons', 'icon-512.png'), '--out',
        path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)], { stdio: 'ignore' });
    }
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(resources, 'electron.icns')]);

  const commit = git('rev-parse', 'HEAD');
  const dirty = git('status', '--porcelain') !== '';
  fs.writeFileSync(path.join(app, 'BUILD'), [
    `version=${options.version}`, `commit=${commit}`, ...(dirty ? ['dirty=true'] : []), `built_at=${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}`, ''
  ].join('\n'));

  // The original Electron signature no longer covers the modified bundle.
  // Ad-hoc signing makes local test builds executable, including on Apple Silicon.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });
  execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, zip], { stdio: 'inherit' });
  fs.writeFileSync(`${zip}.sha256`, `${sha256(zip)}  ${path.basename(zip)}\n`);
  fs.rmSync(stage, { recursive: true, force: true });
  console.log(zip);
} finally {
  fs.rmSync(downloads, { recursive: true, force: true });
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

async function download(url, file) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok) throw new Error(`${url} returned ${response.status}`);
      fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
      return;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
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
