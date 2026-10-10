import fs from 'node:fs';
import path from 'node:path';
import type { HistoryFileFingerprint, HistorySourceCandidate, ParsedConversation, ParsedHistoryFile, ParsedMedia, ParsedMessage, ParsedRateLimit, ParsedUsage, ProviderHistoryAdapter } from './AgentHistoryTypes';
import { defaultFileFingerprint, isoFromString, nonNegative, parsedImage, readJsonl, skillUsesFromMessages, statOnlyFingerprint, stringValue, textFromUnknown, walkFiles } from './HistoryAdapterUtils';

export class CodexHistoryAdapter implements ProviderHistoryAdapter {
  readonly provider = 'codex' as const;
  readonly parserVersion = 'codex-jsonl-v6';

  defaultSources(homeDir: string): HistorySourceCandidate[] {
    const sessions = path.join(homeDir, '.codex', 'sessions');
    return [{ provider: this.provider, sourceKind: 'default', path: sessions, exists: fs.existsSync(sessions) }];
  }

  discoverFiles(sourcePath: string): string[] {
    return walkFiles(sourcePath, (filePath) => filePath.endsWith('.jsonl'));
  }

  discoverFilesSince(sourcePath: string, sinceMtimeMs: number, forcePaths: string[] = []): string[] {
    const forced = new Set(forcePaths);
    return walkFiles(sourcePath, (filePath) => (filePath.endsWith('.jsonl') && fileMtimeMs(filePath) >= sinceMtimeMs) || forced.has(filePath));
  }

  fingerprintFile(filePath: string): HistoryFileFingerprint {
    return defaultFileFingerprint(filePath);
  }

  quickFingerprintFile(filePath: string): HistoryFileFingerprint {
    return statOnlyFingerprint([filePath]);
  }

  parseFile(filePath: string): ParsedHistoryFile {
    const parsed = readJsonl(filePath);
    const warnings: string[] = [];

    let conversationId = path.basename(filePath, '.jsonl');
    let hasSessionId = false;
    let cwd: string | null = null;
    let providerVersion: string | null = null;
    let title: string | null = null;
    let seq = 0;
    let startedAt: string | null = null;
    let updatedAt: string | null = null;
    const messages: ParsedMessage[] = [];
    // Modern rollouts mirror chat in event_msg, sometimes without block separators.
    // Read the response transcript once; retain event-only legacy transcripts.
    let hasResponseMessages = false;
    const usage = new CodexUsageReader();
    // Tool calls carry no turn_id; the turn_context before them names the turn.
    let currentTurnId: string | null = null;
    const media: ParsedMedia[] = [];
    // Each tool call's input, to name the images its output returns.
    const callInputs = new Map<string, string>();
    for (const record of readJsonl(filePath).records) {
      if (!record || typeof record !== 'object') continue;
      const row = record as Record<string, unknown>;
      if (row.type === 'response_item' && row.payload && typeof row.payload === 'object'
        && (row.payload as Record<string, unknown>).type === 'message') {
        hasResponseMessages = true;
        break;
      }
    }

    for (const record of parsed.records) {
      if (!record || typeof record !== 'object') {
        warnings.push('skipped non-object record');
        continue;
      }
      const row = record as Record<string, unknown>;
      const payload = row.payload && typeof row.payload === 'object' ? row.payload as Record<string, unknown> : row;
      const rowType = stringValue(row.type) ?? stringValue(payload.type) ?? 'event';
      if (rowType === 'session_meta' && stringValue(payload.id)) {
        conversationId = stringValue(payload.id)!;
        hasSessionId = true;
      }
      cwd ??= stringValue(payload.cwd);
      providerVersion ??= stringValue(payload.cli_version);
      const createdAt = isoFromString(row.timestamp) ?? isoFromString(payload.timestamp);
      startedAt ??= createdAt;
      updatedAt = createdAt ?? updatedAt;
      usage.read(rowType, payload, createdAt);
      if (rowType === 'turn_context') currentTurnId = stringValue(payload.turn_id) ?? currentTurnId;

      const extracted = extractCodexItems(payload, rowType);
      const rowSeq = seq;
      for (const item of extracted) {
        if (rowType === 'event_msg' && hasResponseMessages) continue;
        if (!item.text && !item.toolName && !item.toolInputSummary && !item.toolOutputSummary) continue;
        title ??= item.role === 'user' && item.kind === 'message' && item.text ? firstLine(item.text) : null;
        messages.push({
          providerMessageId: item.providerMessageId ?? `${conversationId}:${seq}`,
          parentProviderMessageId: item.parentProviderMessageId,
          turnId: item.turnId ?? currentTurnId,
          seq: seq++,
          role: item.role,
          kind: item.kind,
          text: item.text,
          toolName: item.toolName,
          toolStatus: item.toolStatus,
          toolInputSummary: item.toolInputSummary,
          toolOutputSummary: item.toolOutputSummary,
          providerCreatedAt: createdAt,
          tokenCount: numberValue(payload.tokens),
          metadata: { type: rowType, payloadType: stringValue(payload.type), callId: item.callId ?? null, source: 'codex-jsonl' }
        });
      }
      if (rowType === 'response_item') {
        const messageSeq = seq > rowSeq ? rowSeq : seq ? seq - 1 : null;
        media.push(...codexImages(payload, callInputs, { messageSeq, occurredAt: createdAt, position: parsed.position }));
      }
    }

    warnings.push(...parsed.warnings);
    if (parsed.partialTrailingLine) warnings.push('partial trailing JSONL line; will retry on a later import');
    if (messages.length === 0) warnings.push('no supported Codex conversation messages found');
    const conversation: ParsedConversation = {
      provider: this.provider,
      providerConversationId: conversationId,
      title,
      cwd,
      providerVersion,
      startedAt,
      updatedAt,
      endedAt: updatedAt,
      status: parsed.partialTrailingLine ? 'active' : 'imported',
      sourcePath: filePath,
      metadata: { source: 'codex-jsonl' },
      messages,
      media,
      usage: usage.usage,
      rateLimits: usage.rateLimits,
      skills: skillUsesFromMessages(messages, { skillFileReads: true })
    };
    return { provider: this.provider, sourcePath: filePath, sourceKind: 'jsonl', parserVersion: this.parserVersion, warnings, conversations: messages.length || (hasSessionId && !parsed.warnings.length && !parsed.partialTrailingLine) ? [conversation] : [] };
  }
}

type TokenTotals = Record<'input_tokens' | 'cached_input_tokens' | 'cache_write_input_tokens' | 'output_tokens' | 'reasoning_output_tokens', number>;
const TOKEN_FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'] as const;

// Codex writes a token_count event after each response, sometimes repeated
// when only the quota changed. Each new running total contributes its
// difference from the previous one. The first event uses its own response
// size, because a forked rollout starts with the parent's running total.
class CodexUsageReader {
  readonly usage: ParsedUsage[] = [];
  rateLimits: ParsedRateLimit[] = [];
  private model: string | null = null;
  private previous: TokenTotals | null = null;

  read(rowType: string, payload: Record<string, unknown>, createdAt: string | null): void {
    if (rowType === 'turn_context') this.model = stringValue(payload.model) ?? this.model;
    if (rowType !== 'event_msg' || payload.type !== 'token_count') return;
    if (createdAt) this.readRateLimits(payload.rate_limits, createdAt);
    const info = record(payload.info);
    const total = tokenTotals(info.total_token_usage);
    if (!total) return;
    const previous = this.previous;
    this.previous = total;
    const growth = previous ? TOKEN_FIELDS.map((field) => total[field] - previous[field]) : null;
    if (growth?.every((value) => value === 0)) return;
    const delta = growth && growth.every((value) => value >= 0)
      ? Object.fromEntries(TOKEN_FIELDS.map((field, index) => [field, growth[index]])) as TokenTotals
      : tokenTotals(info.last_token_usage);
    if (!delta) return;
    this.usage.push({
      model: this.model,
      occurredAt: createdAt,
      // OpenAI counts cached input inside input_tokens.
      inputTokens: Math.max(0, delta.input_tokens - delta.cached_input_tokens - delta.cache_write_input_tokens),
      cacheReadTokens: delta.cached_input_tokens,
      cacheWriteTokens: delta.cache_write_input_tokens,
      cacheWrite1hTokens: 0,
      outputTokens: delta.output_tokens,
      reasoningTokens: delta.reasoning_output_tokens,
      costUsd: null,
      subagent: false
    });
  }

  private readRateLimits(value: unknown, observedAt: string): void {
    const limits = record(value);
    const limitId = stringValue(limits.limit_id) ?? 'codex';
    const name = stringValue(limits.limit_name);
    const windows: ParsedRateLimit[] = [];
    for (const key of ['primary', 'secondary'] as const) {
      const window = record(limits[key]);
      if (typeof window.used_percent !== 'number') continue;
      const minutes = typeof window.window_minutes === 'number' ? window.window_minutes : null;
      const resets = typeof window.resets_at === 'number' ? new Date(window.resets_at < 1e12 ? window.resets_at * 1000 : window.resets_at).toISOString() : null;
      windows.push({ key: `${limitId}:${minutes ?? key}`, label: `${name ? `${name} ` : ''}${limitLabel(minutes, key)}`, usedPercent: window.used_percent, windowMinutes: minutes, resetsAt: resets, observedAt });
    }
    if (windows.length) this.rateLimits = [...this.rateLimits.filter((limit) => !windows.some((window) => window.key === limit.key)), ...windows];
  }
}

function limitLabel(minutes: number | null, fallback: string): string {
  if (minutes === 300) return '5h limit';
  if (minutes === 10_080) return 'Weekly limit';
  return minutes ? `${minutes}m limit` : `${fallback} limit`;
}

function tokenTotals(value: unknown): TokenTotals | null {
  const usage = record(value);
  if (typeof usage.input_tokens !== 'number' && typeof usage.output_tokens !== 'number') return null;
  return Object.fromEntries(TOKEN_FIELDS.map((field) => [field, nonNegative(usage[field])])) as TokenTotals;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

interface CodexContentItem {
  providerMessageId: string | null;
  parentProviderMessageId: string | null;
  turnId: string | null;
  role: ParsedMessage['role'];
  kind: ParsedMessage['kind'];
  text: string;
  toolName: string | null;
  toolStatus: string | null;
  toolInputSummary: string | null;
  toolOutputSummary: string | null;
  callId?: string | null;
}

function extractCodexItems(payload: Record<string, unknown>, rowType: string): CodexContentItem[] {
  const payloadType = stringValue(payload.type);
  const providerMessageId = stringValue(payload.message_id) ?? stringValue(payload.id);
  const parentProviderMessageId = stringValue(payload.parent_id);
  const turnId = stringValue(payload.turn_id);
  if (rowType === 'response_item') {
    if (payloadType === 'message') {
      const text = textFromCodexContent(payload.content ?? payload.message ?? payload.summary ?? payload.text);
      if (payload.role === 'developer' || payload.role === 'system' || isGeneratedContext(payload, text)) return [];
      return [{ providerMessageId, parentProviderMessageId, turnId, role: mapRole(stringValue(payload.role)), kind: 'message', text, toolName: null, toolStatus: stringValue(payload.status), toolInputSummary: null, toolOutputSummary: null }];
    }
    if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
      return [{
        providerMessageId,
        parentProviderMessageId,
        turnId,
        role: 'tool',
        kind: 'tool_call',
        text: '',
        toolName: stringValue(payload.name) ?? stringValue(payload.tool_name) ?? payloadType,
        toolStatus: stringValue(payload.status),
        toolInputSummary: textFromCodexContent(payload.arguments ?? payload.input) || null,
        toolOutputSummary: null,
        callId: stringValue(payload.call_id) ?? providerMessageId
      }];
    }
    if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
      return [{
        providerMessageId,
        parentProviderMessageId,
        turnId,
        role: 'tool',
        kind: 'tool_result',
        text: '',
        toolName: null,
        toolStatus: stringValue(payload.status) ?? 'completed',
        toolInputSummary: null,
        toolOutputSummary: textFromCodexContent(payload.output ?? payload.content) || null,
        callId: stringValue(payload.call_id)
      }];
    }
    if (payloadType === 'reasoning' || payloadType === 'reasoning_summary') return [];
  }

  if (rowType === 'event_msg') {
    if (payloadType !== 'user_message' && payloadType !== 'agent_message') return [];
    return [{ providerMessageId, parentProviderMessageId, turnId, role: payloadType === 'user_message' ? 'user' : 'assistant', kind: 'message',
      text: textFromCodexContent(payload.message), toolName: null, toolStatus: null, toolInputSummary: null, toolOutputSummary: null }];
  }
  if (!['message', 'summary', 'compacted'].includes(rowType) && !rowType.includes('tool')) return [];
  const role = mapRole(stringValue(payload.role));
  if (role === 'system') return [];
  const toolName = stringValue(payload.tool_name) ?? stringValue(payload.name);
  const text = textFromCodexContent(payload.content ?? payload.message ?? payload.summary ?? payload.text);
  const isTool = rowType.includes('tool') || Boolean(toolName);
  return [{
    providerMessageId,
    parentProviderMessageId,
    turnId,
    role,
    kind: isTool ? 'tool_call' : rowType.includes('summary') ? 'summary' : rowType === 'session_meta' ? 'event' : 'message',
    text,
    toolName,
    toolStatus: stringValue(payload.status),
    toolInputSummary: textFromCodexContent(payload.input) || null,
    toolOutputSummary: textFromCodexContent(payload.output) || null
  }];
}

const IMAGE_PATH = /["'`]([^"'`\s]+\.(?:png|jpe?g|gif|webp))["'`]/gi;

// A pasted image follows an input_text naming its upload path; a viewed image
// is returned in a tool call's output, and the call's input names its file
// when it opens images in order, as view_image does.
function codexImages(payload: Record<string, unknown>, callInputs: Map<string, string>, context: { messageSeq: number | null; occurredAt: string | null; position: { offset: number; length: number } }): ParsedMedia[] {
  const type = stringValue(payload.type);
  const callId = stringValue(payload.call_id);
  if ((type === 'function_call' || type === 'custom_tool_call') && callId) {
    callInputs.set(callId, textFromUnknown(payload.arguments ?? payload.input));
    return [];
  }
  const field = type === 'message' ? 'content' : type === 'function_call_output' || type === 'custom_tool_call_output' ? 'output' : null;
  const items = field ? payload[field] : null;
  if (!field || !Array.isArray(items) || payload.role === 'developer' || payload.role === 'system') return [];
  const kind = type === 'message' && payload.role === 'user' ? 'pasted' : 'viewed';
  const paths = kind === 'viewed' ? [...(callInputs.get(callId ?? '') ?? '').matchAll(IMAGE_PATH)].map((match) => match[1]!) : [];
  const out: ParsedMedia[] = [];
  let label: string | null = null;
  items.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const record = item as Record<string, unknown>;
    if (record.type === 'input_text') {
      label = /^<image name=[^>]*?path="([^"]+)"/.exec(textFromUnknown(record.text))?.[1] ?? null;
      return;
    }
    if (record.type !== 'input_image') return;
    const name = kind === 'pasted' ? label : paths[out.length] ?? null;
    const image = parsedImage(record.image_url, null, {
      messageSeq: context.messageSeq, kind, name, occurredAt: context.occurredAt,
      locator: { type: 'jsonl', ...context.position, pointer: ['payload', field, index, 'image_url'] }
    });
    if (image) out.push(image);
  });
  return out;
}

function isGeneratedContext(payload: Record<string, unknown>, text: string): boolean {
  if (payload.role !== 'user') return false;
  const metadata = payload.internal_chat_message_metadata_passthrough;
  const kinds = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).content_item_kinds : null;
  if (Array.isArray(kinds) && kinds.length) {
    return kinds.every(kind => kind === 'agents_md.instructions' || kind === 'environments.environment_context');
  }
  // Older rollouts lack content-kind metadata. Match complete native wrappers,
  // leaving ordinary user messages that discuss AGENTS.md intact.
  return /^# AGENTS\.md instructions for [^\n]+\n[\s\S]*<\/INSTRUCTIONS>(?:\s*<environment_context>[\s\S]*<\/environment_context>)?\s*$/.test(text)
    || /^<environment_context>[\s\S]*<\/environment_context>\s*$/.test(text);
}

function textFromCodexContent(value: unknown): string {
  if (!Array.isArray(value)) return textFromUnknown(value);
  return value.map((item) => {
    if (!item || typeof item !== 'object') return textFromUnknown(item);
    const record = item as Record<string, unknown>;
    return textFromUnknown(record.text ?? record.content ?? record.output ?? record.input);
  }).filter(Boolean).join('\n');
}

function mapRole(value: string | null): ParsedMessage['role'] {
  if (value === 'user') return 'user';
  if (value === 'assistant') return 'assistant';
  if (value === 'system') return 'system';
  if (value === 'developer') return 'system';
  if (value === 'tool') return 'tool';
  return 'unknown';
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0]?.slice(0, 120) ?? '';
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function fileMtimeMs(filePath: string): number {
  try {
    return Math.round(fs.statSync(filePath).mtimeMs);
  } catch {
    return 0;
  }
}
