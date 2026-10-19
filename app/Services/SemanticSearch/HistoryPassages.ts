import { createHash } from 'node:crypto';

// Prose a person would remember: user and assistant messages and imported
// summaries. Tool calls and results stay keyword-only; they are most of the
// stored bytes and are better found by exact text.
export const EMBEDDED_MESSAGE_FILTER = `kind in ('message', 'summary') and role in ('user', 'assistant', 'system')`;

const TARGET_CHARS = 1_000;
const MAX_CHARS = 1_200;
// Pasted logs and injected context run to 100k characters. Their opening is
// what identifies them, and a cap keeps backfill time proportional to turns.
const MAX_PASSAGES_PER_MESSAGE = 2;
const MIN_CHARS = 12;

export interface MessageForPassages { id: string; seq: number; text: string; }
export interface HistoryPassage { messageId: string; seq: number; chunk: number; text: string; contentHash: string; }

export function messagePassages(message: MessageForPassages): HistoryPassage[] {
  const flat = message.text.replace(/\s+/g, ' ').trim();
  if (flat.length < MIN_CHARS) return [];
  const passages: HistoryPassage[] = [];
  let start = 0;
  while (start < flat.length && passages.length < MAX_PASSAGES_PER_MESSAGE) {
    const end = passageEnd(flat, start);
    const text = flat.slice(start, end).trim();
    if (text.length >= MIN_CHARS) passages.push({ messageId: message.id, seq: message.seq, chunk: passages.length, text, contentHash: passageHash(text) });
    start = end;
  }
  return passages;
}

export function passageHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// Ends a passage at a sentence or word boundary between the target and the
// maximum length, so a word is never split unless it is longer than that.
function passageEnd(text: string, start: number): number {
  if (text.length - start <= MAX_CHARS) return text.length;
  const window = text.slice(start + TARGET_CHARS, start + MAX_CHARS);
  const sentence = window.search(/[.!?]\s/);
  if (sentence >= 0) return start + TARGET_CHARS + sentence + 1;
  const space = window.lastIndexOf(' ');
  if (space >= 0) return start + TARGET_CHARS + space;
  return start + MAX_CHARS;
}
