import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const MAX_ENTRIES = 500;

export const listDirectoriesInput = z.object({
  path: z.string().default(''),
  // Case-insensitive name match, applied before the entry cap.
  filter: z.string().default(''),
  show_hidden: z.boolean().default(false)
});

export type ListDirectoriesInput = z.infer<typeof listDirectoriesInput>;

export interface DirectoryEntry {
  name: string;
  path: string;
  git: boolean;
}

export interface DirectoryListing {
  path: string;
  parent: string | null;
  home: string;
  entries: DirectoryEntry[];
  truncated: boolean;
}

// On a Windows server the level above a drive root lists the drive letters.
// Mirrors DRIVES_PATH in resources/js/lib/directoryPicker.
export const DRIVES_PATH = '\\\\';

// Lists the subdirectories of one server directory so the browser client can
// pick a project path without a native dialog. Read-only.
// Expands a leading ~ to the home directory, as a shell would.
export function expandHome(requested: string, home: string): string {
  return requested === '~' ? home : requested.replace(process.platform === 'win32' ? /^~(?=[\\/])/ : /^~(?=\/)/, home);
}

export class ListDirectoriesAction {
  constructor(private readonly home: string = os.homedir()) {}

  execute(input: ListDirectoriesInput): DirectoryListing {
    const windows = process.platform === 'win32';
    const requested = input.path.trim();
    if (windows && requested === DRIVES_PATH) return this.listDrives(input.filter);
    const resolved = path.resolve(requested === '' ? this.home : expandHome(requested, this.home));

    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new Error(`path does not exist: ${resolved}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`path is not a directory: ${resolved}`);
    }

    const needle = input.filter.toLowerCase();
    const names: string[] = [];
    for (const dirent of fs.readdirSync(resolved, { withFileTypes: true })) {
      if (!input.show_hidden && dirent.name.startsWith('.')) continue;
      if (needle && !dirent.name.toLowerCase().includes(needle)) continue;
      if (dirent.isDirectory() || (dirent.isSymbolicLink() && isDirectory(path.join(resolved, dirent.name)))) names.push(dirent.name);
    }
    names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
    // Only the listed entries are checked for a repository.
    const entries = names.slice(0, MAX_ENTRIES).map((name): DirectoryEntry => {
      const full = path.join(resolved, name);
      return { name, path: full, git: fs.existsSync(path.join(full, '.git')) };
    });

    const parent = path.dirname(resolved);
    return {
      path: resolved,
      // A drive root reaches the other drives; elsewhere the root has no parent.
      parent: parent === resolved ? (windows ? DRIVES_PATH : null) : parent,
      home: this.home,
      entries,
      truncated: names.length > MAX_ENTRIES
    };
  }

  private listDrives(filter: string): DirectoryListing {
    const needle = filter.toLowerCase();
    const entries: DirectoryEntry[] = [];
    for (let code = 65; code <= 90; code += 1) {
      const name = `${String.fromCharCode(code)}:`;
      if (needle && !name.toLowerCase().includes(needle)) continue;
      if (isDirectory(`${name}\\`)) entries.push({ name, path: `${name}\\`, git: false });
    }
    return { path: DRIVES_PATH, parent: null, home: this.home, entries, truncated: false };
  }
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}
