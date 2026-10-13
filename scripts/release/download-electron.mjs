import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Electron 42 downloads on demand. Packaging populates the cache itself, and
// also accepts archives saved by older Electron install hooks.
export async function downloadElectron(url, file, expected) {
  const cache = process.env.electron_config_cache;
  if (cache && fs.existsSync(cache)) {
    const entries = fs.readdirSync(cache, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name === path.basename(file));
    for (const entry of entries) {
      const cached = path.join(entry.parentPath, entry.name);
      if (createHash('sha256').update(fs.readFileSync(cached)).digest('hex') === expected) {
        fs.copyFileSync(cached, file);
        return;
      }
    }
  }
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok) throw new Error(`${url} returned ${response.status}`);
      fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
      break;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
  if (createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== expected) {
    throw new Error(`${path.basename(file)} failed SHA-256 verification`);
  }
  if (cache) {
    fs.mkdirSync(cache, { recursive: true });
    fs.copyFileSync(file, path.join(cache, path.basename(file)));
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [url, file, expected] = process.argv.slice(2);
  if (process.argv.length !== 5 || !/^[a-f0-9]{64}$/.test(expected ?? '')) {
    throw new Error('Usage: download-electron.mjs URL FILE SHA256');
  }
  await downloadElectron(url, file, expected);
}
