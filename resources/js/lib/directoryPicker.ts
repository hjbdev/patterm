import { shallowRef } from 'vue';

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

// Splits typed text into the directory to list and the filter for its
// entries, like shell completion: `/srv/co` lists `/srv/` filtered by `co`.
export function splitDirectoryQuery(query: string): { directory: string; filter: string } {
  const slash = query.lastIndexOf('/');
  if (slash < 0) return { directory: query === '~' ? '~' : '', filter: query === '~' ? '' : query };
  return { directory: query.slice(0, slash + 1), filter: query.slice(slash + 1) };
}

export function withTrailingSlash(path: string): string {
  return path.endsWith('/') ? path : `${path}/`;
}
