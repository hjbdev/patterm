import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// A directory of links to another directory's entries, such as Patterm's copy
// of an OpenCode config directory. POSIX uses symlinks. Windows symlinks need
// Developer Mode or elevation, so directories become junctions, which need
// neither, and files become hard links, which share the original's content as a
// symlink does. A hard link needs the same NTFS volume, so a file falls back to
// a copy, which keeps the content but not later writes.
//
// A symlink identifies itself as Patterm's. Hard links and copies do not, so on
// Windows the names Patterm placed are recorded in a manifest beside the
// directories (never inside, where the CLI would read it as config), each with
// the file's size and mtime. A file the CLI has since rewritten no longer
// matches and is left alone.

type Manifest = Record<string, Record<string, string>>;

export class LinkedEntries {
  // `manifest` is shared by every LinkedEntries of one tree, told apart by `key`.
  constructor(private readonly directory: string, private readonly manifest: string, private readonly key: string) {}

  // Removes the links Patterm made for entries that are no longer in `keep`.
  removeStale(keep: readonly string[]): void {
    if (process.platform !== 'win32') {
      for (const entry of fs.readdirSync(this.directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink() && !keep.includes(entry.name)) fs.unlinkSync(path.join(this.directory, entry.name));
      }
      return;
    }
    const owned = this.owned();
    for (const [name, fingerprint] of Object.entries(owned)) {
      if (keep.includes(name)) continue;
      const stat = fs.lstatSync(path.join(this.directory, name), { throwIfNoEntry: false });
      if (stat && (stat.isSymbolicLink() || (stat.isFile() && fingerprintOf(stat) === fingerprint))) fs.unlinkSync(path.join(this.directory, name));
      delete owned[name];
    }
    this.save(owned);
  }

  // Links `source` as `name`. An existing entry is replaced only when `replace`.
  link(source: string, name: string, replace: boolean): void {
    const destination = path.join(this.directory, name);
    if (process.platform !== 'win32') {
      if (!replace) {
        if (!fs.lstatSync(destination, { throwIfNoEntry: false })) fs.symlinkSync(source, destination);
        return;
      }
      const temporary = path.join(this.directory, `.${randomUUID()}.tmp`);
      try {
        fs.symlinkSync(source, temporary);
        fs.renameSync(temporary, destination);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
      return;
    }
    const target = fs.statSync(source, { bigint: true, throwIfNoEntry: false });
    const existing = fs.lstatSync(destination, { bigint: true, throwIfNoEntry: false });
    // The source can vanish after it was listed. A real directory belongs to the CLI.
    if (!target || (existing && (!replace || (existing.isDirectory() && !existing.isSymbolicLink())))) return;
    const owned = this.owned();
    if (target.isDirectory()) {
      if (existing) fs.unlinkSync(destination);
      fs.symlinkSync(source, destination, 'junction');
      owned[name] = '';
    } else {
      // A hard link to this very file already shares its content.
      if (!existing?.isFile() || existing.ino !== target.ino || existing.dev !== target.dev) linkOrCopy(source, destination);
      owned[name] = fingerprintOf(fs.statSync(destination));
    }
    this.save(owned);
  }

  private owned(): Record<string, string> {
    return this.read()[this.key] ?? {};
  }

  private read(): Manifest {
    try {
      const manifest: unknown = JSON.parse(fs.readFileSync(this.manifest, 'utf8'));
      return manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest as Manifest : {};
    } catch {
      return {};
    }
  }

  private save(owned: Record<string, string>): void {
    const manifest = this.read();
    manifest[this.key] = owned;
    fs.writeFileSync(this.manifest, JSON.stringify(manifest), { mode: 0o600 });
  }
}

// Replaces `destination` with a hard link to `source`, or a copy of it when the
// files are on different volumes or the filesystem has no hard links. The swap
// goes through a temporary name, so `destination` is never half written.
// Returns whether the result is a link.
export function linkOrCopy(source: string, destination: string): boolean {
  const temporary = path.join(path.dirname(destination), `.${randomUUID()}.tmp`);
  try {
    let linked = true;
    try { fs.linkSync(source, temporary); }
    catch { linked = false; fs.copyFileSync(source, temporary); }
    fs.renameSync(temporary, destination);
    return linked;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function fingerprintOf(stat: { size: number | bigint; mtimeMs: number | bigint }): string {
  return `${stat.size}:${Math.trunc(Number(stat.mtimeMs))}`;
}
