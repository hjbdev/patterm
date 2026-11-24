import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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
