#!/usr/bin/env node
// Writes the release manifest that install.sh and update checks read.
// Usage: manifest.mjs <version> <commit> <package.sha256>...
// Packages are the Linux tarballs and the Windows and macOS zips.
// The JSON is flat with one key per line, so install.sh can read it with sed.
import fs from 'node:fs';
import path from 'node:path';

const [version, commit, ...checksums] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '') || !/^[0-9a-f]{40}$/.test(commit ?? '') || !checksums.length) {
  console.error('Usage: manifest.mjs <version> <commit> <package.sha256>...');
  process.exit(1);
}
const manifest = {
  version,
  // Any suffix, such as 1.3.0-beta.1, marks a pre-release on every platform.
  prerelease: version.includes('-'),
  commit,
  published_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z')
};
for (const file of checksums.sort()) {
  const [sha256, name] = fs.readFileSync(file, 'utf8').trim().split(/\s+/);
  const escaped = version.replaceAll('.', '\\.');
  const platform = new RegExp(`^patterm-${escaped}-(?:(linux-(?:x64|arm64))\\.tar\\.gz|(macos-(?:x64|arm64)|windows-x64)\\.zip)$`).exec(path.basename(name ?? ''))?.slice(1).find(Boolean);
  if (!platform || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`Unexpected checksum file ${file}`);
  manifest[platform] = name;
  manifest[`${platform}-sha256`] = sha256;
}
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
