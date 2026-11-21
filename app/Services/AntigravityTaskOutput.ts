import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { userHome } from '../Platform/ServiceProcess';
import { AntigravityHistoryAdapter } from './AgentHistory/AntigravityHistoryAdapter';
import { readJsonl } from './AgentHistory/HistoryAdapterUtils';

const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
// Messages per transcript page. The drawer loads earlier pages on request.
const TRANSCRIPT_PAGE = 200;

export type AntigravityTaskOutput =
  | { format: 'missing'; version: null }
  | { format: 'unchanged'; version: string }
  | { format: 'transcript'; version: string; archived_messages: unknown[]; cursor: string | null };

export function antigravityBrainDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = process.platform === 'win32' ? userHome(env) : env.HOME || os.homedir();
  return path.join(home, '.gemini', 'antigravity-cli', 'brain');
}

export function antigravityTranscriptPath(conversationId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!CONVERSATION_ID.test(conversationId)) return null;
  return path.join(antigravityBrainDir(env), conversationId, '.system_generated', 'logs', 'transcript.jsonl');
}

// Extracts the subagent conversationId from an invoke_subagent result, whether
// ACP delivered a structured object or the plain-text JSON summary.
export function extractAntigravitySubagentId(value: unknown): string | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    const direct = row.conversationId ?? row.conversation_id;
    if (typeof direct === 'string' && CONVERSATION_ID.test(direct)) return direct;
    for (const key of ['output', 'text', 'content', 'result']) {
      if (row[key] !== undefined) {
        const nested = extractAntigravitySubagentId(row[key]);
        if (nested) return nested;
      }
    }
    return null;
  }
  if (typeof value !== 'string' || !value) return null;
  const field = /"conversationId"\s*:\s*"([A-Za-z0-9_-]{1,128})"/.exec(value);
  if (field?.[1]) return field[1];
  const uri = /\/brain\/([A-Za-z0-9_-]{1,128})\/\.system_generated\/logs\/transcript\.jsonl/.exec(value);
  return uri?.[1] ?? null;
}

// Subagent conversation IDs spawned by a parent session, read from its native
// transcript. Used to check ownership even after a host restart.
export function antigravityParentSubagentIds(parentSessionId: string, env: NodeJS.ProcessEnv = process.env): Set<string> {
  const ids = new Set<string>();
  const file = antigravityTranscriptPath(parentSessionId, env);
  if (!file || !fs.existsSync(file)) return ids;
  const parsed = readJsonl(file);
  const pending: string[] = [];
  for (const raw of parsed.records) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    if (row.type === 'USER_INPUT' && row.source === 'USER_EXPLICIT') {
      pending.length = 0;
      continue;
    }
    if (row.type === 'PLANNER_RESPONSE' && row.source === 'MODEL' && Array.isArray(row.tool_calls)) {
      for (const call of row.tool_calls) {
        if (!call || typeof call !== 'object') continue;
        const name = (call as Record<string, unknown>).name;
        pending.push(typeof name === 'string' ? name : '');
      }
      continue;
    }
    if (row.type === 'GENERIC' && row.source === 'MODEL' && pending.length) {
      const name = pending.shift();
      if (name === 'invoke_subagent') {
        const id = extractAntigravitySubagentId(row.content);
        if (id && id !== parentSessionId) ids.add(id);
      }
    }
  }
  return ids;
}

// Without a cursor, reads the newest page. A transcript's cursor is the index
// of the first message already shown: the file only grows at the end, so the
// index still names the same message on a later read.
export function readAntigravityTaskOutput(
  taskId: string,
  env: NodeJS.ProcessEnv = process.env,
  since?: string | null,
  cursor?: string | null
): AntigravityTaskOutput {
  if (!CONVERSATION_ID.test(taskId)) throw new Error('Invalid background task id');
  const file = antigravityTranscriptPath(taskId, env);
  if (!file || !fs.existsSync(file)) return { format: 'missing', version: null };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { format: 'missing', version: null };
    throw error;
  }
  if (!stat.isFile()) return { format: 'missing', version: null };
  const version = `${stat.size}:${stat.mtimeMs}`;
  if (since === version && !cursor) return { format: 'unchanged', version };
  const end = cursor ? Number(cursor) : null;
  if (end !== null && (!Number.isInteger(end) || end < 0)) throw new Error('Invalid task output cursor');
  const messages = new AntigravityHistoryAdapter().parseFile(file).conversations[0]?.messages ?? [];
  const sliceEnd = Math.min(end ?? messages.length, messages.length);
  let start = Math.max(0, sliceEnd - TRANSCRIPT_PAGE);
  // Keep paired tool_call / tool_result rows in the same page so folding in
  // the drawer never splits a tool call from its output across a page edge.
  if (start > 0 && start < sliceEnd) {
    const callIndex = new Map<string, number>();
    for (let i = 0; i < sliceEnd; i++) {
      const msg = messages[i];
      const callId = typeof msg?.metadata?.callId === 'string' ? msg.metadata.callId : '';
      if (msg?.kind === 'tool_call' && callId && !callIndex.has(callId)) callIndex.set(callId, i);
    }
    for (let i = sliceEnd - 1; i >= start; i--) {
      const msg = messages[i];
      const callId = typeof msg?.metadata?.callId === 'string' ? msg.metadata.callId : '';
      if (msg?.kind !== 'tool_result' || !callId) continue;
      const paired = callIndex.get(callId);
      if (paired !== undefined && paired < start) start = paired;
    }
  }
  const kept = messages.slice(start, sliceEnd);
  return {
    format: 'transcript',
    version,
    cursor: start > 0 ? String(start) : null,
    archived_messages: kept.map((message) => ({
      ...message,
      id: `${taskId}:${message.seq}`,
      conversationId: taskId,
      redactionCount: 0,
      createdAt: message.providerCreatedAt ?? ''
    }))
  };
}
