#!/usr/bin/env node
// Writes THIRD_PARTY_NOTICES.md from the shipped dependencies: npm production
// packages, Electron, development packages compiled into the app, the terminal
// sidecar's runtime crates and static libraries, and source copied into the
// repository. `--check` fails if the file is out of date or a
// dependency's licence needs review.
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'THIRD_PARTY_NOTICES.md');
const overridesDir = path.join(root, 'scripts/third-party-licences');
const check = process.argv.includes('--check');

// Packages published without a licence file. The text comes from upstream.
const overrides = {
  '@radix-icons/vue': { license: 'MIT', file: 'radix-icons-vue.LICENSE' },
  '@vue/devtools-api': { license: 'MIT', file: 'vue-devtools-api.LICENSE' },
  http_ece: { license: 'MIT', file: 'http_ece.LICENSE' },
  lru_map: { license: 'MIT', file: 'lru_map.LICENSE' },
  'vaul-vue': { license: 'MIT', file: 'vaul-vue.LICENSE' }
};
// Development packages whose code the build compiles into the app.
const compiledDev = {
  tailwindcss: 'Its base styles and utilities are compiled into the app stylesheet.',
  '@tailwindcss/typography': 'Its prose styles are compiled into the app stylesheet.',
  'tailwindcss-animate': 'Its animation utilities are compiled into the app stylesheet.'
};
// Source copied into the repository rather than installed as a dependency.
const copied = [
  {
    name: 'shadcn-vue',
    license: 'MIT',
    files: ['shadcn-vue.LICENSE'],
    note: 'The components in resources/js/Components/ui come from its new-york-v4 registry, some of them modified.'
  },
  {
    name: 'shadcn/ui',
    license: 'MIT',
    files: ['shadcn-ui.LICENSE'],
    note: 'shadcn-vue ports its component designs to Vue.'
  },
  {
    name: 'Lobe Icons',
    license: 'MIT',
    files: ['lobe-icons.LICENSE'],
    note: 'resources/js/assets/agents/claude-code.svg, codex.svg, and opencode.svg come from it unmodified. The names and logos are trademarks of their owners.'
  }
];
// Libraries the Rust toolchain links statically into the musl sidecar.
const linked = [
  {
    name: 'Rust standard library',
    license: 'MIT OR Apache-2.0',
    files: ['rust-std.LICENSE-MIT', 'rust-std.LICENSE-APACHE'],
    note: 'Its full copyright notice is at https://github.com/rust-lang/rust/blob/master/COPYRIGHT.'
  },
  {
    name: 'musl',
    license: 'MIT',
    files: ['musl.COPYRIGHT'],
    note: "The C library that Rust's musl targets bundle."
  }
];
const notes = {
  // Shiki bundles grammars and themes whose licences its upstream repository lists.
  '@shikijs/langs': 'It bundles TextMate grammars from many projects. Patterm highlights with the grammars in resources/js/lib/shiki.ts, and releases leave out the GPL-3.0 Ada, gnuplot, nginx, and Racket grammars. Each grammar\'s source and licence are listed at https://github.com/shikijs/textmate-grammars-themes/blob/main/packages/tm-grammars/README.md.',
  '@shikijs/themes': 'It bundles themes from many projects. Patterm uses only github-dark, and releases leave out the GPL-3.0 Aurora X theme. Each theme\'s source and licence are listed at https://github.com/shikijs/textmate-grammars-themes/blob/main/packages/tm-themes/README.md.',
  // MPL-2.0 requires telling recipients where to get the source.
  'web-push': 'Patterm ships it unmodified. Its source is available from https://github.com/web-push-libs/web-push and in the installed node_modules/web-push directory.'
};
// Font binaries are vendored unchanged from pinned Fontsource packages.
const fonts = JSON.parse(readFileSync(path.join(root, 'resources/js/assets/fonts/manifest.json'), 'utf8')).map((font) => ({
  name: font.package,
  version: font.version,
  license: font.license.toUpperCase() === 'MIT' ? 'MIT' : font.license,
  files: [`${font.name}.FONT-LICENSE`],
  note: `Bundled WOFF2 font files from ${font.url}.`
}));

// Release targets, matching .github/workflows/release.yml. The crate list must
// not depend on the build machine.
const platforms = ['x86_64-unknown-linux-musl', 'aarch64-unknown-linux-musl'];
const copyleft = /\b(A?GPL|LGPL|SSPL|EUPL|CDDL|EPL|OSL)\b/i;
const licenceFile = /^(licen[cs]e|copying|notice|unlicense)([-._].*)?$/i;
// A fixed locale, so the output and --check don't depend on the machine's locale.
const compareText = new Intl.Collator('en').compare;
const compareVersion = new Intl.Collator('en', { numeric: true }).compare;

function licenceTexts(dir) {
  return readdirSync(dir)
    .filter((name) => licenceFile.test(name))
    .sort()
    .map((name) => readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n').trim());
}

function npmPackages() {
  const options = { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 };
  // pnpm is a .cmd shim on Windows, which only a shell can start.
  const listed = JSON.parse(process.platform === 'win32'
    ? execSync('pnpm licenses list --prod --json', options)
    : execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], options));
  const packages = [];
  for (const entries of Object.values(listed)) {
    for (const entry of entries) {
      entry.versions.forEach((version, index) => packages.push({ name: entry.name, version, license: entry.license, dir: entry.paths[index] }));
    }
  }
  // Electron is a development dependency of the build, but it ships with the
  // desktop app. Chromium's own notices ship beside its binary.
  const electronDir = path.join(root, 'node_modules/electron');
  const electron = JSON.parse(readFileSync(path.join(electronDir, 'package.json'), 'utf8'));
  packages.push({
    name: 'electron',
    version: electron.version,
    license: electron.license,
    dir: electronDir,
    note: 'Chromium and its components are covered by LICENSES.chromium.html, which ships beside the Electron binary.'
  });
  for (const [name, note] of Object.entries(compiledDev)) {
    const dir = path.join(root, 'node_modules', name);
    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    packages.push({ name, version: manifest.version, license: manifest.license, dir, note });
  }
  return packages;
}

function crates() {
  const cargoEnv = { ...process.env, PATH: `${path.join(os.homedir(), '.cargo/bin')}:${process.env.PATH}` };
  const args = ['metadata', '--format-version', '1', '--locked', '--manifest-path', path.join(root, 'native/terminal-core/Cargo.toml')];
  for (const platform of platforms) args.push('--filter-platform', platform);
  const metadata = JSON.parse(execFileSync('cargo', args, { env: cargoEnv, encoding: 'utf8', maxBuffer: 64 << 20 }));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const byId = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const isProcMacro = (pkg) => pkg.targets.some((target) => target.kind.includes('proc-macro'));
  // Follow normal dependencies only. Build scripts, dev dependencies, and
  // procedural macros run while compiling and are not part of the binary.
  const shipped = new Set();
  const pending = [metadata.resolve.root];
  while (pending.length) {
    const id = pending.pop();
    if (shipped.has(id)) continue;
    shipped.add(id);
    for (const dep of nodes.get(id).deps) {
      if (dep.dep_kinds.some((kind) => kind.kind === null) && !isProcMacro(byId.get(dep.pkg))) pending.push(dep.pkg);
    }
  }
  shipped.delete(metadata.resolve.root);
  return [...shipped].map((id) => {
    const pkg = byId.get(id);
    return { name: pkg.name, version: pkg.version, license: pkg.license, dir: path.dirname(pkg.manifest_path) };
  });
}

// A Windows checkout may hold text files with CRLF line endings.
function readText(file) {
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim();
}

const problems = [];
function resolve(pkg, ecosystem) {
  const override = overrides[pkg.name];
  const license = override?.license ?? pkg.license;
  const texts = override ? [readText(path.join(overridesDir, override.file))] : licenceTexts(pkg.dir);
  const label = `${pkg.name}@${pkg.version}`;
  if (!license || /^unknown$/i.test(license)) problems.push(`${label} declares no licence; add an override`);
  else if (copyleft.test(license)) problems.push(`${label} is ${license}; review before shipping`);
  if (!texts.length) problems.push(`${label} ships no licence file; add an override`);
  return { ...pkg, ecosystem, license, texts, note: pkg.note ?? notes[pkg.name] };
}

function render(packages) {
  // Packages with identical licence text share one copy of it.
  const groups = new Map();
  for (const pkg of packages) {
    const key = createHash('sha256').update(pkg.license).update('\0').update(pkg.texts.join('\n\n').replace(/\s+/g, ' ')).digest('hex');
    if (!groups.has(key)) groups.set(key, { license: pkg.license, texts: pkg.texts, packages: [] });
    groups.get(key).packages.push(pkg);
  }
  const ordered = [...groups.values()].sort((a, b) => compareText(a.license, b.license) || compareText(a.packages[0].name, b.packages[0].name));
  const lines = [
    '# Third-party notices',
    '',
    'Patterm includes the third-party software listed below. Each component is',
    'licensed under the terms that follow its name. `scripts/third-party-notices.mjs`',
    'generates this file; do not edit it by hand.',
    ''
  ];
  for (const group of ordered) {
    lines.push(`## ${group.license}`, '');
    for (const pkg of group.packages) lines.push(`- ${[pkg.name, pkg.version].filter(Boolean).join(' ')} (${pkg.ecosystem})${pkg.note ? `. ${pkg.note}` : ''}`);
    for (const text of group.texts) lines.push('', '```text', text, '```');
    lines.push('');
  }
  return lines.join('\n');
}

function bundled(entry, ecosystem) {
  return { ...entry, version: entry.version ?? '', ecosystem, texts: entry.files.map((file) => readText(path.join(overridesDir, file))) };
}

const byName = (a, b) => compareText(a.name, b.name) || compareVersion(a.version, b.version);
const packages = [
  ...npmPackages().map((pkg) => resolve(pkg, 'npm')),
  ...crates().map((pkg) => resolve(pkg, 'Rust crate')),
  ...copied.map((entry) => bundled(entry, 'copied source')),
  ...fonts.map((entry) => bundled(entry, 'font')),
  ...linked.map((entry) => bundled(entry, 'statically linked'))
].sort(byName);
const notices = render(packages);

if (problems.length) {
  for (const problem of problems) console.error(`error: ${problem}`);
  process.exit(1);
}
if (check) {
  let current = '';
  try {
    current = readFileSync(output, 'utf8').replace(/\r\n/g, '\n');
  } catch {}
  if (current !== notices) {
    console.error('error: THIRD_PARTY_NOTICES.md is out of date; run node scripts/third-party-notices.mjs');
    process.exit(1);
  }
  console.log(`THIRD_PARTY_NOTICES.md is current (${packages.length} components).`);
} else {
  writeFileSync(output, notices);
  console.log(`Wrote THIRD_PARTY_NOTICES.md (${packages.length} components).`);
}
