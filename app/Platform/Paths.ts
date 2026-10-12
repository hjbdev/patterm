import path from 'node:path';

// Filesystem paths compare case-insensitively on Windows, where git also
// reports `C:/x` for `C:\x`. Store normalizePath() output and compare with
// pathKey(); never compare raw strings or test for a `/` prefix.

export function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.replace(/^[a-z]:/, (drive) => drive.toUpperCase()) : resolved;
}

export function pathKey(value: string): string {
  const normalized = normalizePath(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

// True when `child` is `parent` or lies beneath it.
export function isPathWithin(child: string, parent: string): boolean {
  const relative = path.relative(pathKey(parent), pathKey(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
