import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envValue } from '../Platform/Environment';
import { userHome } from '../Platform/ServiceProcess';
import { ClaudeHistoryAdapter } from './AgentHistory/ClaudeHistoryAdapter';

// Claude writes every background task's output to
// <tmp>/claude-<uid>/<project>/<session>/tasks/<task>.output, or on Windows to
// %TEMP%\claude\<project>\<session>\tasks\<task>.output. For a background
// agent that file links to its transcript at
// <config>/projects/<project>/<session>/subagents/agent-<task>.jsonl, which
// outlives the temporary directory. Shells write plain text.

const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TEXT_LIMIT_BYTES = 256 * 1024;
// Messages per transcript page. The drawer loads earlier pages on request.
const TRANSCRIPT_PAGE = 200;

export interface ClaudeTaskLocation {
  cwd: string;
  sessionId: string;
  env: NodeJS.ProcessEnv;
}

export type ClaudeTaskOutput =
  | { format: 'missing'; version: null }
  | { format: 'unchanged'; version: string }
  | { format: 'text'; version: string; text: string; truncated: boolean }
  | { format: 'transcript'; version: string; archived_messages: unknown[]; cursor: string | null };

// Without a cursor, reads the newest page. A transcript's cursor is the index
// of the first message already shown: the file only grows at the end, so the
// index still names the same message on a later read.
export function readClaudeTaskOutput(location: ClaudeTaskLocation, taskId: string, since?: string | null, cursor?: string | null): ClaudeTaskOutput {
  if (!TASK_ID.test(taskId)) throw new Error('Invalid background task id');
  const file = taskFile(location, taskId);
  if (!file) return { format: 'missing', version: null };
  const stat = fs.statSync(file);
  const version = `${stat.size}:${stat.mtimeMs}`;
  if (since === version && !cursor) return { format: 'unchanged', version };
  if (!file.endsWith('.jsonl')) return text(file, stat.size, version);
  const end = cursor ? Number(cursor) : null;
  if (end !== null && (!Number.isInteger(end) || end < 0)) throw new Error('Invalid task output cursor');
  return transcript(file, taskId, version, end);
}

// Claude Code appends `claude-<uid>` to CLAUDE_CODE_TMPDIR, or /tmp. Windows has
// no uid, and Claude Code appends `claude` to CLAUDE_CODE_TMPDIR, or the user's
// temp directory.
function taskRoot(env: NodeJS.ProcessEnv): string {
  const override = envValue(env, 'CLAUDE_CODE_TMPDIR');
  if (process.platform !== 'win32') return path.join(override || '/tmp', `claude-${os.userInfo().uid}`);
  return path.join(override || envValue(env, 'TEMP') || envValue(env, 'TMP') || os.tmpdir(), 'claude');
}

function taskFile(location: ClaudeTaskLocation, taskId: string): string | null {
  const tmp = taskRoot(location.env);
  const output = sessionFile(tmp, location, ['tasks', `${taskId}.output`]);
  let empty: string | null = null;
  if (output) {
    try {
      const real = fs.realpathSync(output);
      // Without symlink rights Windows leaves an agent's .output as an empty
      // file instead of a link to its transcript, so look for the transcript.
      if (process.platform !== 'win32' || real.endsWith('.jsonl') || fs.statSync(real).size > 0) return real;
      empty = real;
    } catch {
      // A dangling link falls through to the transcript directory.
    }
  }
  const config = envValue(location.env, 'CLAUDE_CONFIG_DIR') || path.join(process.platform === 'win32' ? userHome(location.env) : location.env.HOME || os.homedir(), '.claude');
  const transcript = sessionFile(path.join(config, 'projects'), location, ['subagents', `agent-${taskId}.jsonl`]);
  return transcript ?? empty;
}

// Claude names the project directory after the cwd with every other character
// replaced by '-', and shortens long paths, so fall back to finding the
// session directory by its unique id.
function sessionFile(root: string, location: ClaudeTaskLocation, parts: string[]): string | null {
  const direct = path.join(root, location.cwd.replace(/[^a-zA-Z0-9]/g, '-'), location.sessionId, ...parts);
  if (fs.existsSync(direct)) return direct;
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const candidate = path.join(root, entry, location.sessionId, ...parts);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function text(file: string, size: number, version: string): ClaudeTaskOutput {
  const start = Math.max(0, size - TEXT_LIMIT_BYTES);
  const buffer = Buffer.alloc(size - start);
  const handle = fs.openSync(file, 'r');
  try {
    fs.readSync(handle, buffer, 0, buffer.length, start);
  } finally {
    fs.closeSync(handle);
  }
  return { format: 'text', version, text: buffer.toString('utf8'), truncated: start > 0 };
}

function transcript(file: string, taskId: string, version: string, before: number | null): ClaudeTaskOutput {
  const messages = new ClaudeHistoryAdapter().parseFile(file).conversations[0]?.messages ?? [];
  const end = Math.min(before ?? messages.length, messages.length);
  const start = Math.max(0, end - TRANSCRIPT_PAGE);
  const kept = messages.slice(start, end);
  return {
    format: 'transcript',
    version,
    cursor: start > 0 ? String(start) : null,
    // The renderer reads these as archived conversation records.
    archived_messages: kept.map((message) => ({
      ...message,
      id: `${taskId}:${message.seq}`,
      conversationId: taskId,
      redactionCount: 0,
      createdAt: message.providerCreatedAt ?? ''
    }))
  };
}
