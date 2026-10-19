// The Integrated composer's document as lines of text and mention chips.
// Drafts are stored as text in which each chip is one object replacement
// character, with the chips listed in order beside it. A chip is one unit in
// both forms, so text offsets and ProseMirror positions differ only by the
// paragraph boundaries: a newline is one character, but closing one paragraph
// and opening the next takes two positions.

export const CHIP = '￼';

export interface ComposerChip {
  // A running agent or process, or a preset or harness to launch a new agent with.
  kind: 'agent' | 'process' | 'preset' | 'harness';
  // What the message sends in the chip's place: the agent's or process's ID,
  // or a launch token (see agentMentions).
  token: string;
  // The agent's title, the process's name, the preset's name, or the harness's label.
  name: string;
  harness: string | null;
  // The paired host the agent or process runs on.
  host?: string | undefined;
}

export type ComposerInline = { text: string } | { chip: ComposerChip };
export type ComposerLine = ComposerInline[];

export function composerText(lines: readonly ComposerLine[]): string {
  return lines.map((line) => line.map((item) => 'chip' in item ? CHIP : item.text.replaceAll(CHIP, '')).join('')).join('\n');
}

export function composerChips(lines: readonly ComposerLine[]): ComposerChip[] {
  return lines.flatMap((line) => line.flatMap((item) => 'chip' in item ? [item.chip] : []));
}

// Each chip character takes the next chip; one without a chip is dropped.
export function composerLines(text: string, chips: readonly ComposerChip[]): ComposerLine[] {
  let next = 0;
  return text.split('\n').map((source) => {
    const line: ComposerLine = [];
    for (const [index, part] of source.split(CHIP).entries()) {
      if (index > 0 && next < chips.length) line.push({ chip: chips[next++]! });
      if (part) {
        const last = line[line.length - 1];
        if (last && 'text' in last) last.text += part;
        else line.push({ text: part });
      }
    }
    return line;
  });
}

export function textOffsetToPosition(text: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let newlines = 0;
  for (let index = text.indexOf('\n'); index >= 0 && index < clamped; index = text.indexOf('\n', index + 1)) newlines++;
  return clamped + 1 + newlines;
}

// A position between two paragraphs reads as the start of the second.
export function positionToTextOffset(text: string, position: number): number {
  let start = 0;
  for (const [index, line] of text.split('\n').entries()) {
    const first = start + 1 + index;
    if (position <= first + line.length) return start + Math.max(0, position - first);
    start += line.length + 1;
  }
  return text.length;
}
