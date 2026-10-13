import { isPathWithin, normalizePath, pathKey, samePath } from './Paths';

// Project, worktree, session, and history paths are stored as text and compared
// both in code and in SQL. Every helper here is the identity (or the original
// string comparison) on POSIX, so Linux keeps its exact behaviour, and applies
// Windows rules (drive-letter case, `/` versus `\`, case-insensitivity) there.

const windows = (): boolean => process.platform === 'win32';

// The form to store for a new row.
export function storedPath(value: string): string {
  return windows() ? normalizePath(value) : value;
}

// A comparison key: equal keys name the same path.
export function pathIdentity(value: string): string {
  return windows() ? pathKey(value) : value;
}

export function pathsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return a === b;
  return windows() ? samePath(a, b) : a === b;
}

// True when `child` is `parent` or lies beneath it.
export function pathContains(parent: string, child: string): boolean {
  return windows() ? isPathWithin(child, parent) : child === parent || child.startsWith(`${parent}/`);
}

// Agents started from Git Bash or Cygwin record `/c/Users/x` for `C:\Users\x`.
// Maps those, and `\\?\C:\x`, to the native form. Identity on POSIX.
export function nativePath(value: string): string {
  if (!windows()) return value;
  const drive = /^[\\/]{2}[?.][\\/]([a-zA-Z]:.*)$/.exec(value);
  if (drive) return normalizePath(drive[1]!);
  const posix = /^\/(?:cygdrive\/)?([a-zA-Z])(?:\/(.*))?$/.exec(value);
  if (posix) return normalizePath(`${posix[1]!.toUpperCase()}:\\${(posix[2] ?? '').replace(/\//g, '\\')}`);
  return value;
}

// openSqliteConnection() registers this SQL function on Windows.
export const WINDOWS_PATH_KEY = 'patterm_path_key';

// SQL for comparing a path column with pathParam(value). The text is the bare
// column on POSIX; on Windows it folds separators and Unicode case with the
// function every connection registers, matching pathKey().
export function pathColumn(column: string): string {
  return windows() ? `${WINDOWS_PATH_KEY}(${column})` : column;
}

export function pathParam(value: string): string {
  return windows() ? normalizePath(nativePath(value)).toLowerCase() : value;
}

// A path relative to a root, written with `/` for agents and the UI. Filesystem
// access must still join the native form.
export function slashPath(value: string): string {
  return windows() ? value.replace(/\\/g, '/') : value;
}

// True when the text ends in a directory separator the user could have typed.
export function endsWithSeparator(value: string): boolean {
  return windows() ? /[\\/]$/.test(value) : value.endsWith('/');
}
