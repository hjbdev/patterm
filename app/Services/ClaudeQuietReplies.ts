import fs from 'node:fs';
import path from 'node:path';

export const QUIET_REPLY = 'NO_REPLY';
export const QUIET_DIGEST_INSTRUCTION = '\n\nIf this routine notification needs no action or user-facing reply, respond with exactly NO_REPLY and do not call tools. Otherwise respond normally.';

export function quietReplyDirectory(runtimeDir: string): string {
  return path.join(runtimeDir, 'claude', 'quiet-replies');
}

// One empty file per confirmed native message. Detached hosts can commit the
// decision before publishing idle, without writing into either app database.
export function quietReplyPath(directory: string, sessionId: string, messageId: string): string | null {
  if (!/^[a-z0-9_-]{1,128}$/i.test(sessionId) || !/^[a-z0-9_-]{1,128}$/i.test(messageId)) return null;
  return path.join(directory, sessionId, messageId);
}

export function isQuietReply(directory: string | undefined, sessionId: string, messageId: string): boolean {
  const file = directory && quietReplyPath(directory, sessionId, messageId);
  return Boolean(file && fs.existsSync(file));
}

export function recordQuietReply(directory: string, sessionId: string, id: string): boolean {
  const file = quietReplyPath(directory, sessionId, id);
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.closeSync(fs.openSync(file, 'a', 0o600));
    return true;
  } catch {
    return false;
  }
}
