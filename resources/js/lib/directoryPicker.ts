import { shallowRef } from 'vue';
import { isWindowsPath, pathSeparator } from './serverPath';

// Mirrors app/Actions/ListDirectoriesAction, which the renderer can't import
// because it uses Node modules.
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

export interface DirectoryPickerRequest {
  initial: string;
  resolve(path: string | null): void;
}

// The open server-directory picker, if any. The browser runtime has no native
// dialog, so `pickDirectory` asks the mounted DirectoryPickerDialog instead.
export const directoryPickerRequest = shallowRef<DirectoryPickerRequest | null>(null);

export function pickServerDirectory(initial = ''): Promise<string | null> {
  directoryPickerRequest.value?.resolve(null);
  return new Promise((resolve) => {
    directoryPickerRequest.value = { initial, resolve };
  });
}

export function finishDirectoryPicker(path: string | null): void {
  const request = directoryPickerRequest.value;
  directoryPickerRequest.value = null;
  request?.resolve(path);
}

// On a Windows server the level above a drive root lists the drive letters.
// Mirrors DRIVES_PATH in app/Actions/ListDirectoriesAction.
export const DRIVES_PATH = '\\\\';

// Splits typed text into the directory to list and the filter for its
// entries, like shell completion: `/srv/co` lists `/srv/` filtered by `co`.
// A Windows path splits at either separator, and `C:` means that drive's root.
export function splitDirectoryQuery(query: string): { directory: string; filter: string } {
  if (/^[a-zA-Z]:$/.test(query)) return { directory: `${query}\\`, filter: '' };
  const slash = isWindowsPath(query) ? Math.max(query.lastIndexOf('/'), query.lastIndexOf('\\')) : query.lastIndexOf('/');
  if (slash < 0) return { directory: query === '~' ? '~' : '', filter: query === '~' ? '' : query };
  return { directory: query.slice(0, slash + 1), filter: query.slice(slash + 1) };
}

export function withTrailingSlash(path: string): string {
  if (path.endsWith('/') || path.endsWith('\\')) return path;
  return `${path}${pathSeparator(path)}`;
}

// Home-relative, as a shell prompt shows it. Windows paths compare ignoring case.
export function displayServerPath(path: string, home: string | undefined): string {
  if (!home) return path;
  const windows = isWindowsPath(home);
  const fold = (value: string) => windows ? value.toLowerCase() : value;
  const prefix = withTrailingSlash(home);
  return fold(path) === fold(home) || fold(path).startsWith(fold(prefix)) ? `~${path.slice(home.length)}` : path;
}

export function directoryPlaceholder(home: string | undefined): string {
  return home && isWindowsPath(home) ? 'C:\\path\\to\\repo' : '/path/to/repo';
}
