// Paths the renderer shows are server paths, and a browser on one OS may talk
// to a server on another. Decide Windows or POSIX per path, from a drive
// letter or a backslash, never from the browser's platform. Git-relative paths
// always use `/` and don't belong here.

export function isWindowsPath(value: string): boolean {
  return /^[a-zA-Z]:/.test(value) || value.includes('\\');
}

export function pathSeparator(value: string): '/' | '\\' {
  return isWindowsPath(value) ? '\\' : '/';
}

// The non-empty parts of a path, split on either separator for a Windows path.
export function pathSegments(value: string): string[] {
  return value.split(isWindowsPath(value) ? /[\\/]/ : '/').filter(Boolean);
}

export function baseName(value: string): string | undefined {
  return pathSegments(value).at(-1);
}
