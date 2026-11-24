// Pure helpers for the expanded view of a transcript tool row: they turn the
// text a harness returned into numbered, per-file lines that the row can
// highlight. Each parser returns null when the text isn't in a shape it knows,
// so the row falls back to plain output rather than guessing.

import type { TranscriptToolFile } from '../../../app/Services/TranscriptProjection';

export interface CodeLine {
  n?: number;
  text: string;
  // Grep context lines (ripgrep's `-` separator) are dimmer than matches.
  context?: boolean;
}

export interface CodeGroup {
  file?: string;
  lines: CodeLine[];
}

// Tenths under ten seconds, so quick calls still read as different lengths.
export function formatToolDuration(milliseconds: number): string {
  const ms = Math.max(0, milliseconds);
  if (ms < 10_000) return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function toolDurationMs(createdAt: string | undefined, completedAt: string | undefined): number | null {
  if (!createdAt || !completedAt) return null;
  const ms = Date.parse(completedAt) - Date.parse(createdAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

// The last lines of long output, with how many were left out.
export function outputTail(output: string, max: number): { hidden: number; text: string } {
  const lines = output.replace(/\n+$/, '').split('\n');
  if (lines.length <= max) return { hidden: 0, text: lines.join('\n') };
  return { hidden: lines.length - max, text: lines.slice(-max).join('\n') };
}

// Claude's Read numbers lines `1\t` (or `1→`); OpenCode's read prints a short
// header, then `1: `. Header lines are dropped, except truncation notices.
const NUMBERED_LINE = /^\s*(\d+)(?:\t|→|: ?$|: |\| ?)(.*)$/;
const NOTICE_LINE = /truncated|showing lines|offset=/i;

export function parseNumberedOutput(output: string): CodeLine[] | null {
  const raw = output.replace(/\n+$/, '').split('\n');
  const lines: CodeLine[] = [];
  let unmatched = 0;
  for (const line of raw) {
    const match = NUMBERED_LINE.exec(line);
    if (match) lines.push({ n: Number(match[1]), text: match[2]! });
    // A notice in the header, such as the archive's truncation line, is the
    // only sign the file is incomplete, so it leads the lines.
    else if (!lines.some((entry) => entry.n !== undefined) && NOTICE_LINE.test(line)) lines.push({ text: line.trim(), context: true });
    // Notices after the first line, such as a truncation or the offset to
    // continue from, stay in place, dimmed.
    else if (lines.length && line.trim()) { lines.push({ text: line, context: true }); unmatched++; }
  }
  const numbered = lines.filter((entry) => entry.n !== undefined).length;
  if (!numbered || unmatched > numbered * 0.2) return null;
  return lines;
}

// Grep output in the two shapes harnesses produce. ripgrep style, from
// Claude's Grep: `path:12:text` for a match and `path-12-text` for context,
// without the path when one file was searched, and `--` between context
// blocks. OpenCode's grep: a `/path:` heading, then `  Line 12: text`.
export function parseGrepOutput(output: string): CodeGroup[] | null {
  const raw = output.replace(/\n+$/, '').split('\n');
  const groups: CodeGroup[] = [];
  const add = (file: string | undefined, line: CodeLine): void => {
    const last = groups.at(-1);
    if (last && last.file === file) last.lines.push(line);
    else groups.push({ ...(file ? { file } : {}), lines: [line] });
  };
  const opencode = raw.some((line) => /^\s+Line \d+: /.test(line));
  // Every way each line could split into file, number and text. A path can
  // hold `-12-` (dated logs) and text can hold `:12:` (stack locations), so
  // a line takes the file most lines could name.
  const readings = opencode ? [] : raw.map(grepReadings);
  const support = new Map<string, number>();
  for (const options of readings) for (const file of new Set(options.map((option) => option.file))) support.set(file, (support.get(file) ?? 0) + 1);
  let heading: string | undefined;
  let matched = 0;
  let unmatched = 0;
  for (const [index, line] of raw.entries()) {
    if (!line.trim() || line === '--' || /^Found \d+ (?:matches|files?)/.test(line)) continue;
    if (opencode) {
      const hit = /^\s+Line (\d+): ?(.*)$/.exec(line);
      if (hit && heading) { add(heading, { n: Number(hit[1]), text: hit[2]! }); matched++; }
      else if (/^\S.*:$/.test(line)) heading = line.slice(0, -1);
      else unmatched++;
      continue;
    }
    const bare = /^(\d+)([:-])(.*)$/.exec(line);
    const reading = bare ? null : bestReading(readings[index]!, support);
    if (bare) add(undefined, { n: Number(bare[1]), text: bare[3]!, ...(bare[2] === '-' ? { context: true } : {}) });
    else if (reading) add(reading.file, { n: reading.n, text: reading.text, ...(reading.context ? { context: true } : {}) });
    else { unmatched++; continue; }
    matched++;
  }
  if (!matched || unmatched > matched * 0.2) return null;
  return groups;
}

interface GrepReading { file: string; n: number; text: string; context: boolean }

function grepReadings(line: string): GrepReading[] {
  const readings: GrepReading[] = [];
  for (const match of line.matchAll(/([:-])(\d+)\1/g)) {
    if (!match.index) continue;
    readings.push({ file: line.slice(0, match.index), n: Number(match[2]), text: line.slice(match.index + match[0].length), context: match[1] === '-' });
  }
  return readings;
}

// Most supported file first, then one without spaces, then a hit, then the
// longer name.
function bestReading(readings: GrepReading[], support: Map<string, number>): GrepReading | null {
  const rank = (reading: GrepReading): number[] => [support.get(reading.file) ?? 0, /\s/.test(reading.file) ? 0 : 1, reading.context ? 0 : 1, reading.file.length];
  let best: GrepReading | null = null;
  for (const reading of readings) {
    if (!best) { best = reading; continue; }
    const [x, y] = [rank(reading), rank(best)];
    const diff = x.findIndex((value, i) => value !== y[i]);
    if (diff >= 0 && x[diff]! > y[diff]!) best = reading;
  }
  return best;
}

// Ranges of a grep pattern in a line, for marking. Treated as a regular
// expression when it is one; a pattern that doesn't compile marks nothing.
export function patternRanges(text: string, pattern: string | undefined, ignoreCase = false): Array<[number, number]> {
  if (!pattern) return [];
  // ripgrep's inline `(?i)` is a flag JavaScript only takes separately.
  const inline = /^\(\?i\)/.test(pattern);
  let regex: RegExp;
  try { regex = new RegExp(inline ? pattern.slice(4) : pattern, ignoreCase || inline ? 'gi' : 'g'); } catch { return []; }
  const ranges: Array<[number, number]> = [];
  for (const match of text.matchAll(regex)) {
    if (!match[0].length) break;
    ranges.push([match.index, match.index + match[0].length]);
    if (ranges.length > 50) break;
  }
  return ranges;
}

export interface CodeSegment {
  text: string;
  color?: string;
  mark?: boolean;
}

// Splits highlighted tokens wherever a marked range starts or ends.
export function markTokens(tokens: Array<{ content: string; color?: string }>, ranges: Array<[number, number]>): CodeSegment[] {
  const segments: CodeSegment[] = [];
  let position = 0;
  for (const token of tokens) {
    const end = position + token.content.length;
    const cuts = new Set([position, end]);
    for (const [from, to] of ranges) {
      if (from > position && from < end) cuts.add(from);
      if (to > position && to < end) cuts.add(to);
    }
    const points = [...cuts].sort((a, b) => a - b);
    for (let index = 0; index < points.length - 1; index++) {
      const from = points[index]!;
      const text = token.content.slice(from - position, points[index + 1]! - position);
      if (!text) continue;
      const mark = ranges.some(([a, b]) => from >= a && from < b);
      segments.push({ text, ...(token.color ? { color: token.color } : {}), ...(mark ? { mark } : {}) });
    }
    position = end;
  }
  return segments;
}

// Pierre needs numbered hunks. Codex's apply_patch bodies (`@@` with no line
// numbers, or bare added lines) can't be placed and show as raw lines instead.
const NUMBERED_HUNK = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m;

export function isUnifiedPatch(patch: string | undefined): boolean {
  return Boolean(patch && NUMBERED_HUNK.test(patch));
}

// One git-format patch for Pierre. Claude's edits arrive as bare hunks per
// file, so each gets the file headers Pierre needs to name and colour it.
export function filesPatch(patch: string | undefined, files: TranscriptToolFile[] | undefined): string {
  if (patch?.includes('diff --git') && isUnifiedPatch(patch)) return patch;
  return (files ?? []).filter((file) => isUnifiedPatch(file.patch)).map((file) => {
    if (file.patch!.includes('diff --git')) return file.patch!;
    const name = (file.name ?? 'file').replace(/^\/+/, '');
    return `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n${file.patch}`;
  }).join('\n');
}

// Claude's Bash starts a failed command's output with `Exit code N`.
const EXIT_CODE_LINE = /^Exit code (\d+)\r?\n?/;

export function shellExitCode(output: string | undefined): number | null {
  const match = output ? EXIT_CODE_LINE.exec(output) : null;
  return match ? Number(match[1]) : null;
}

export function withoutExitCode(output: string): string {
  return output.replace(EXIT_CODE_LINE, '');
}
