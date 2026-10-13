import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Electron's install hook has already downloaded this archive into its cache.
// The caller checks the archive against electron/checksums.json before use.
export async function downloadElectron(url, file, expected) {
  const cache = process.env.electron_config_cache;
  if (cache && fs.existsSync(cache)) {
    const entry = fs.readdirSync(cache, { recursive: true, withFileTypes: true })
      .find(entry => entry.isFile() && entry.name === path.basename(file));
    if (entry) {
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
      return;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
}
