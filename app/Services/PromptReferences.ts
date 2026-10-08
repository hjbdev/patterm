// File references are plain prompt text. Claude Code resolves `@path` tokens,
// while the Codex TUI inserts the path itself (quoted when it contains
// whitespace). Both forms compare whole paths, never substrings, so
// `@src/app.ts` and `@src/app.tsx` stay distinct. A path that ends in
// sentence punctuation is quoted too, so `@"notes!"` keeps its `!` while the
// full stop after `@src/app.ts.` is read as punctuation.

const TRAILING_PUNCTUATION = /[.,;:!?)]$/;
// A token ends at whitespace or the end of the text, optionally after
// sentence punctuation, so `@src/a.ts` is not found inside `@src/a.ts.bak`.
const TOKEN_END = '(?=[.,;:!?)]*(?:\\s|$))';

export function quotedPath(path: string): string {
  return (/\s/.test(path) || TRAILING_PUNCTUATION.test(path)) && !path.includes('"') ? `"${path}"` : path;
}

export function referenceToken(path: string): string {
  return `@${quotedPath(path)}`;
}

// Exact test for one known path, quoted or not, so a path containing
// punctuation or spaces is never split the way free text would be.
export function containsReferenceToken(text: string, path: string): boolean {
  const escaped = escapeRegExp(path);
  return new RegExp(`(^|\\s)@(?:"${escaped}"|${escaped})${TOKEN_END}`).test(text);
}

export function replaceReferenceToken(text: string, path: string, replacement: string): string {
  const escaped = escapeRegExp(path);
  const pattern = new RegExp(`(^|\\s)@(?:"${escaped}"|${escaped})${TOKEN_END}`, 'g');
  return text.replace(pattern, (_match, prefix: string) => `${prefix}${replacement}`);
}

export function containsPlainPath(text: string, path: string): boolean {
  const escaped = escapeRegExp(path);
  return new RegExp(`(^|\\s)"?${escaped}"?${TOKEN_END}`).test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
