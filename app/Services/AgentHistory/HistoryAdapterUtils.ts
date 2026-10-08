import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { HistoryFileFingerprint, ParsedMessage, ParsedSkillUse } from './AgentHistoryTypes';

const MAX_SYNC_FINGERPRINT_HASH_BYTES = 8 * 1024 * 1024;

export function readJsonl(filePath: string): { records: Iterable<unknown>; warnings: string[]; partialTrailingLine: boolean } {
  const parsed = { records: parseRecords(), warnings: [] as string[], partialTrailingLine: false };
  return parsed;

  function* parseRecords(): Generator<unknown> {
    const fd = fs.openSync(filePath, 'r');
    const chunk = Buffer.allocUnsafe(256 * 1024);
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let lineNumber = 0;
    try {
      while (true) {
        const bytes = fs.readSync(fd, chunk, 0, chunk.length, null);
        const text = bytes ? decoder.write(chunk.subarray(0, bytes)) : decoder.end();
        pending += text;
        let start = 0;
        let end: number;
        while ((end = pending.indexOf('\n', start)) !== -1) {
          const line = pending.slice(start, end).replace(/\r$/, '');
          lineNumber += 1;
          if (line.trim()) {
            try {
              yield JSON.parse(line) as unknown;
            } catch (error) {
              parsed.warnings.push(`line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          start = end + 1;
        }
        pending = pending.slice(start);
        if (!bytes) break;
      }
      if (pending.trim()) {
        try {
          yield JSON.parse(pending) as unknown;
        } catch {
          parsed.partialTrailingLine = true;
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }
}

// Token counts from transcripts; anything else counts as zero.
export function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export function walkFiles(root: string, predicate: (filePath: string) => boolean): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(current);
    } catch {
      continue;
    }
    if (stat.isFile()) {
      if (predicate(current)) out.push(current);
      continue;
    }
    if (!stat.isDirectory()) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      stack.push(path.join(current, entry.name));
    }
  }
  return out.sort();
}

export async function walkFilesAsync(root: string, predicate: (filePath: string) => boolean, yieldEvery = 200): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    visited += 1;
    if (visited % yieldEvery === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(current);
    } catch {
      continue;
    }
    if (stat.isFile()) {
      if (predicate(current)) out.push(current);
      continue;
    }
    if (!stat.isDirectory()) continue;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      stack.push(path.join(current, entry.name));
    }
  }
  return out.sort();
}

export function fileHash(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function defaultFileFingerprint(filePath: string): HistoryFileFingerprint {
  const entry = statEntry(filePath);
  const metadata = { files: [entry] };
  return {
    sizeBytes: entry.sizeBytes,
    mtimeMs: entry.mtimeMs,
    contentHash: entry.contentHash,
    metadata,
    digest: digestJson(metadata)
  };
}

// Stats files without reading them. Its digest equals statDigest() of a stored
// fingerprint for the same unchanged files, so an append-only JSONL file whose
// size and mtime match can be skipped without hashing it. Like Claude's full
// fingerprint, its mtime is the newest of the files, so the watermark covers
// subagent files too.
export function statOnlyFingerprint(filePaths: string[]): HistoryFileFingerprint {
  const files = filePaths.map((filePath) => statEntry(filePath, false));
  const mtimes = files.flatMap((file) => file.mtimeMs === null ? [] : [file.mtimeMs]);
  return { sizeBytes: files[0]?.sizeBytes ?? null, mtimeMs: mtimes.length ? Math.max(...mtimes) : null, contentHash: null, metadata: { files }, digest: statDigest(files)! };
}

export function statDigest(files: unknown): string | null {
  if (!Array.isArray(files)) return null;
  return digestJson(files.map((file) => {
    const { path: filePath, exists, sizeBytes, mtimeMs } = (file ?? {}) as Record<string, unknown>;
    return { path: filePath, exists, sizeBytes, mtimeMs };
  }));
}

export function sqliteSidecarFingerprint(filePath: string): HistoryFileFingerprint {
  return sqliteFingerprint(filePath, true);
}

export function sqliteSidecarStatFingerprint(filePath: string): HistoryFileFingerprint {
  return sqliteFingerprint(filePath, false);
}

function sqliteFingerprint(filePath: string, hashSmallFiles: boolean): HistoryFileFingerprint {
  const files = [filePath, `${filePath}-wal`, `${filePath}-shm`].map((entry) => statEntry(entry, hashSmallFiles));
  const main = files[0] ?? null;
  const metadata = { files };
  return {
    sizeBytes: main?.sizeBytes ?? null,
    mtimeMs: main?.mtimeMs ?? null,
    contentHash: digestJson(metadata),
    metadata,
    digest: digestJson(metadata)
  };
}

export function digestJson(value: unknown): string {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

export function isoFromMillis(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return new Date(value > 10_000_000_000 ? value : value * 1000).toISOString();
}

export function isoFromString(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function statEntry(filePath: string, hashSmallFiles = true): { path: string; exists: boolean; sizeBytes: number | null; mtimeMs: number | null; contentHash: string | null } {
  if (!fs.existsSync(filePath)) return { path: filePath, exists: false, sizeBytes: null, mtimeMs: null, contentHash: null };
  const stat = fs.statSync(filePath);
  return {
    path: filePath,
    exists: true,
    sizeBytes: stat.isFile() ? stat.size : null,
    mtimeMs: Math.round(stat.mtimeMs),
    contentHash: hashSmallFiles && stat.isFile() && stat.size <= MAX_SYNC_FINGERPRINT_HASH_BYTES ? fileHash(filePath) : null
  };
}

export function textFromUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(textFromUnknown).filter(Boolean).join('\n');
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
    if (Array.isArray(record.content)) return textFromUnknown(record.content);
    if (typeof record.input === 'string') return record.input;
    if (typeof record.output === 'string') return record.output;
    return JSON.stringify(record);
  }
  return '';
}

export function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

// Skill tools take the skill's name; Codex has no skill tool, so the agent
// reads SKILL.md itself and a user's $skill mention arrives as a <skill> block.
// OpenCode stores a finished call and its output as one tool_result part.
export function skillUsesFromMessages(messages: ParsedMessage[], options: { subagent?: boolean; skillFileReads?: boolean; finishedCalls?: boolean } = {}): ParsedSkillUse[] {
  const subagent = options.subagent ?? false;
  const uses: ParsedSkillUse[] = [];
  // Agents often page through one SKILL.md in several reads. Transcripts
  // without turn IDs start a turn at each user message.
  const readInTurn = new Set<string>();
  let userTurn = 0;
  for (const message of messages) {
    const occurredAt = message.providerCreatedAt;
    if (message.kind === 'message' && message.role === 'user') {
      userTurn += 1;
      for (const match of message.text.matchAll(/^<skill>\s*<name>([^<]+)<\/name>/gm)) uses.push({ name: match[1]!.trim(), invokedBy: 'user', occurredAt, subagent });
      continue;
    }
    const call = message.kind === 'tool_call' || (options.finishedCalls === true && message.kind === 'tool_result');
    if (!call) continue;
    if (message.toolName?.toLowerCase() === 'skill') {
      const name = skillToolName(message.toolInputSummary);
      if (name) uses.push({ name, invokedBy: 'agent', occurredAt, subagent });
      continue;
    }
    if (options.skillFileReads && message.toolInputSummary && SHELL_TOOLS.has(message.toolName ?? '')) {
      // Only a read command loads a skill; listing, writing, or mentioning the
      // path does not. Globs and variables, such as skills/*/SKILL.md, name no skill.
      const names = new Set(skillFileReads(message.toolInputSummary));
      for (const name of names) {
        const key = `${message.turnId ?? `user:${userTurn}`}\u0000${name}`;
        if (readInTurn.has(key)) continue;
        readInTurn.add(key);
        uses.push({ name, invokedBy: 'agent', occurredAt, subagent });
      }
    }
  }
  return uses;
}

const SHELL_TOOLS = new Set(['exec', 'exec_command', 'shell', 'shell_command', 'local_shell']);
const READ_COMMAND = /\b(?:cat|sed|head|tail|nl|bat|less|more|awk)\b/;
const SKILL_FILE = /\/skills\/([A-Za-z0-9][\w.:-]*)\/SKILL\.md/g;

// Arguments keep the command JSON-escaped, so escaped newlines are decoded
// before splitting it into commands. Separators inside quotes, such as
// sed -n '1,200p;201q', stay in their command. A read command can load
// several files, but a redirect target such as cat > SKILL.md is written.
function skillFileReads(input: string): string[] {
  const unquoted = input.replace(/\\n/g, '\n').replace(/'[^'\n]*'/g, (quoted) => quoted.replace(/[;&|]/g, ' '));
  return unquoted.split(/[;&|\n]/)
    .filter((command) => READ_COMMAND.test(command))
    .flatMap((command) => [...command.replace(/>>?\s*\S+/g, '').matchAll(SKILL_FILE)].map((match) => match[1]!));
}

function skillToolName(input: string | null): string | null {
  if (!input) return null;
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    return stringValue(parsed.skill) ?? stringValue(parsed.name);
  } catch {
    return null;
  }
}
