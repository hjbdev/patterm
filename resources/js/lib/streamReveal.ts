// Only animate a small suffix of an existing rendered message. Markdown can
// restructure text as a fence or link closes; those changes should appear at
// once rather than fading unrelated content.
export function appendedTextStart(previous: string, current: string, live: boolean): number | null {
  // markdown-it leaves a presentation newline after the final block. It moves
  // to the end again when text is appended, even though the visible prefix is
  // unchanged.
  const prefix = previous.trimEnd();
  const added = current.trimEnd().length - prefix.length;
  return live && prefix.length > 0 && added > 0 && added <= 256 && current.startsWith(prefix)
    ? prefix.length
    : null;
}
