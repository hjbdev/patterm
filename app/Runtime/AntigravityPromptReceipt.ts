import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_READ_BYTES = 1024 * 1024;
const POLL_MS = 250;

// agy streams output without a live user_message_chunk. Its native transcript
// records explicit input as soon as it receives it, before the model responds.
export function watchAntigravityPrompt(sessionId: string, text: string, received: () => void): (() => void) | null {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || !text) return null;
  const file = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl');
  const open = () => fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  let offset = 0;
  let identity: fs.Stats | undefined;
  let skipPartial = false;
  try {
    const fd = open();
    try {
      identity = fs.fstatSync(fd);
      if (!identity.isFile()) return null;
      offset = identity.size;
      if (offset > 0) {
        const last = Buffer.alloc(1);
        if (fs.readSync(fd, last, 0, 1, offset - 1) !== 1) return null;
        skipPartial = last[0] !== 10;
      }
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
  }

  // agy timestamps the receipt to the second, not the millisecond. A newly
  // created file can contain replayed history, so its byte offset isn't enough.
  const sentSecond = Math.floor(Date.now() / 1000) * 1000;
  // Start at the pre-dispatch EOF, so resending the same words in a resumed
  // conversation cannot match old history. Only the first current explicit user
  // record can be a receipt. Background output and tool activity never count.
  const timer = setInterval(() => {
    const stop = () => clearInterval(timer);
    try {
      const fd = open();
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size < offset || (identity && (stat.dev !== identity.dev || stat.ino !== identity.ino))) { stop(); return; }
        identity ??= stat;
        if (stat.size === offset) return;
        const bytes = Buffer.allocUnsafe(Math.min(stat.size - offset, MAX_READ_BYTES));
        const read = fs.readSync(fd, bytes, 0, bytes.length, offset);
        const last = bytes.subarray(0, read).lastIndexOf(10);
        if (last < 0) {
          if (read === MAX_READ_BYTES) stop();
          return;
        }
        offset += last + 1;
        const lines = bytes.toString('utf8', 0, last).split('\n');
        if (skipPartial) { lines.shift(); skipPartial = false; }
        for (const line of lines) {
          let row;
          try { row = JSON.parse(line); } catch { continue; }
          if (row?.source !== 'USER_EXPLICIT' || row.type !== 'USER_INPUT') continue;
          const created = typeof row.created_at === 'string' ? Date.parse(row.created_at) : NaN;
          if (!Number.isFinite(created) || created < sentSecond) continue;
          stop();
          const content = row.content;
          const start = '<USER_REQUEST>\n';
          const end = '\n</USER_REQUEST>';
          if (typeof content === 'string' && content.startsWith(start) && content.lastIndexOf(end) === start.length + text.length
            && content.slice(start.length, start.length + text.length) === text
            && (content.endsWith(end) || content[start.length + text.length + end.length] === '\n')) received();
          return;
        }
      } finally { fs.closeSync(fd); }
    } catch (error) {
      // New sessions need not have a transcript until the first input.
      if (identity || (error as NodeJS.ErrnoException).code !== 'ENOENT') stop();
    }
  }, POLL_MS);
  return () => clearInterval(timer);
}
