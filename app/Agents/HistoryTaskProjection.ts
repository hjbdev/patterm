import type { ParsedMessage } from '../Services/AgentHistory/AgentHistoryTypes';
import type { IntegratedConversationMessage } from '../Services/IntegratedConversation';

interface CombinedHistoryMessage extends ParsedMessage {
  providerCompletedAt?: string | null;
}

// Projects parsed subagent/history JSONL messages into canonical
// IntegratedConversationMessage rows so Claude and Antigravity task outputs
// share the exact same contract as Codex and OpenCode.
export function projectHistoryTaskMessages(
  taskId: string,
  messages: readonly ParsedMessage[]
): IntegratedConversationMessage[] {
  const combined = combineToolResults(messages);
  const projected: IntegratedConversationMessage[] = [];
  for (const message of combined) {
    const id = `${taskId}:${message.seq}`;
    const role: 'user' | 'assistant' = message.role === 'user' ? 'user' : 'assistant';
    const createdAt = isoTime(message.providerCreatedAt);
    const completedAt = isoTime(message.providerCompletedAt);
    const isTool = message.role === 'tool'
      || message.kind.includes('tool')
      || Boolean(message.toolName || message.toolInputSummary || message.toolOutputSummary);

    if (isTool) {
      const metaName = message.metadata?.toolName ?? message.metadata?.name;
      const name = message.toolName ?? (typeof metaName === 'string' && metaName.trim() ? metaName.trim() : null) ?? 'tool';
      const input = parseToolInput(message.toolInputSummary, name);
      const output = message.toolOutputSummary ?? '';
      const status = message.toolStatus ?? (output ? 'completed' : 'pending');
      projected.push({
        id,
        role: 'assistant',
        kind: 'tool',
        text: output,
        title: name,
        tool: {
          name,
          ...(input !== undefined ? { input } : {}),
          state: { status, ...(output ? { output } : {}) }
        },
        ...(createdAt ? { createdAt } : {}),
        ...(completedAt ? { completedAt } : {})
      });
      continue;
    }

    const text = message.text.trim();
    if (!text) continue;
    const isReasoning = message.metadata?.type === 'reasoning' || message.metadata?.contentType === 'thinking';
    projected.push({
      id,
      role,
      kind: isReasoning ? 'reasoning' : 'text',
      text,
      ...(createdAt ? { createdAt } : {}),
      ...(completedAt ? { completedAt } : {})
    });
  }
  return projected;
}

function combineToolResults(messages: readonly ParsedMessage[]): CombinedHistoryMessage[] {
  const result: CombinedHistoryMessage[] = [];
  const calls = new Map<string, number>();
  for (const message of messages) {
    const key = toolCallKey(message);
    const index = key ? calls.get(key) : undefined;
    if (message.kind === 'tool_result' && index !== undefined) {
      const call = result[index]!;
      result[index] = {
        ...call,
        toolOutputSummary: [call.toolOutputSummary, message.toolOutputSummary].filter(Boolean).join('\n') || null,
        toolStatus: message.toolStatus ?? call.toolStatus,
        providerCompletedAt: message.providerCreatedAt ?? call.providerCompletedAt ?? null
      };
    } else {
      if (key && message.kind === 'tool_call') calls.set(key, result.length);
      result.push(message);
    }
  }
  return result;
}

function toolCallKey(message: ParsedMessage): string | null {
  const value = message.metadata?.callId ?? message.metadata?.toolUseId;
  return typeof value === 'string' && value ? value : null;
}

function isoTime(value: string | null | undefined): string | undefined {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function parseToolInput(summary: string | null, name: string): unknown {
  if (!summary) return undefined;
  let parsed: Record<string, unknown> | null = null;
  try {
    const value: unknown = JSON.parse(summary);
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  if (!/patch|edit|write/i.test(name)) return parsed ?? summary;
  const patch = firstString(parsed, ['patch', 'patchText', 'patch_text']) ?? summary;
  if (!patch.startsWith('*** Begin Patch\n') && !patch.startsWith('diff --git ')) return parsed ?? summary;
  return { ...(parsed ?? {}), patch };
}

function firstString(record: Record<string, unknown> | null, keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}
