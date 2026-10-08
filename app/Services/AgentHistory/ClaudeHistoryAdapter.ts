import fs from 'node:fs';
import path from 'node:path';
import type { HistoryFileFingerprint, HistorySourceCandidate, ParsedConversation, ParsedHistoryFile, ParsedMessage, ParsedSkillUse, ParsedUsage, ProviderHistoryAdapter } from './AgentHistoryTypes';
import { defaultFileFingerprint, digestJson, isoFromString, nonNegative, readJsonl, statOnlyFingerprint, stringValue, textFromUnknown, walkFiles } from './HistoryAdapterUtils';

export class ClaudeHistoryAdapter implements ProviderHistoryAdapter {
  readonly provider = 'claude' as const;
  readonly parserVersion = 'claude-jsonl-v9';

  defaultSources(homeDir: string): HistorySourceCandidate[] {
    const projects = path.join(homeDir, '.claude', 'projects');
    return [{ provider: this.provider, sourceKind: 'default', path: projects, exists: fs.existsSync(projects) }];
  }

  discoverFiles(sourcePath: string): string[] {
    return walkFiles(sourcePath, isConversationFile);
  }

  // A session also changes when only its subagents write, since their usage
  // is read with it.
  discoverFilesSince(sourcePath: string, sinceMtimeMs: number, forcePaths: string[] = []): string[] {
    const forced = new Set(forcePaths.map((filePath) => isConversationFile(filePath) ? filePath : subagentParent(filePath)));
    return walkFiles(sourcePath, (filePath) => (isConversationFile(filePath)
      && (fileMtimeMs(filePath) >= sinceMtimeMs || subagentFiles(filePath).some((child) => fileMtimeMs(child) >= sinceMtimeMs))) || forced.has(filePath));
  }

  fingerprintFile(filePath: string): HistoryFileFingerprint {
    const parent = defaultFileFingerprint(filePath);
    const children = subagentFiles(filePath).map((child) => defaultFileFingerprint(child));
    if (!children.length) return parent;
    const metadata = { files: [...parent.metadata.files as unknown[], ...children.flatMap((child) => child.metadata.files as unknown[])] };
    const mtimeMs = Math.max(parent.mtimeMs ?? 0, ...children.map((child) => child.mtimeMs ?? 0));
    return { ...parent, mtimeMs, metadata, digest: digestJson(metadata) };
  }

  quickFingerprintFile(filePath: string): HistoryFileFingerprint {
    return statOnlyFingerprint([filePath, ...subagentFiles(filePath)]);
  }

  parseFile(filePath: string): ParsedHistoryFile {
    const parsed = readJsonl(filePath);
    const warnings: string[] = [];

    const messages: ParsedMessage[] = [];
    let conversationId = path.basename(filePath, '.jsonl');
    let hasSessionId = false;
    let cwd: string | null = null;
    let providerVersion: string | null = null;
    let title: string | null = null;
    let seq = 0;
    let startedAt: string | null = null;
    let updatedAt: string | null = null;
    const toolNamesByUseId = new Map<string, string>();
    const usage = new Map<string, ParsedUsage>();
    const seenUuids = new Set<string>();
    const skills: ParsedSkillUse[] = [];

    for (const record of parsed.records) {
      if (!record || typeof record !== 'object') {
        warnings.push('skipped non-object record');
        continue;
      }
      const row = record as Record<string, unknown>;
      collectClaudeUsage(row, usage, false);
      const sessionId = stringValue(row.sessionId);
      if (sessionId) {
        conversationId = sessionId;
        hasSessionId = true;
      }
      // Claude Code re-appends the whole chain under the same uuids when a
      // session moves into a worktree; the first copy is already in order.
      const uuid = stringValue(row.uuid);
      if (uuid) {
        if (seenUuids.has(uuid)) continue;
        seenUuids.add(uuid);
      }
      collectClaudeSkill(row, skills, false);
      cwd ??= stringValue(row.cwd);
      providerVersion ??= stringValue(row.version);
      const createdAt = isoFromString(row.timestamp);
      startedAt ??= createdAt;
      updatedAt = createdAt ?? updatedAt;

      const type = stringValue(row.type) ?? 'event';
      // Queue operations echo a prompt before its real user row, so importing
      // them shows every queued prompt twice.
      if (type === 'attachment' || row.attachment || type === 'system' || type === 'queue-operation' || row.isMeta === true) continue;
      const message = row.message && typeof row.message === 'object' ? row.message as Record<string, unknown> : null;
      const role = mapRole(stringValue(message?.role) ?? stringValue(row.role));
      const extracted = extractClaudeContent(message?.content ?? row.content, type, row, toolNamesByUseId);
      if (extracted.length === 0) continue;
      for (const item of extracted) {
        const text = item.text;
        const itemRole = item.role ?? role;
        if (item.kind.includes('tool') && !text && !item.toolName && !item.toolInputSummary && !item.toolOutputSummary) continue;
        title ??= itemRole === 'user' && item.kind === 'message' && text ? firstLine(text) : null;
        messages.push({
          providerMessageId: extracted.length > 1 ? `${stringValue(row.uuid) ?? stringValue(row.messageId) ?? `${conversationId}:${seq}`}:${item.index}` : stringValue(row.uuid) ?? stringValue(row.messageId) ?? `${conversationId}:${seq}`,
          parentProviderMessageId: stringValue(row.parentUuid),
          turnId: stringValue(row.promptId),
          seq: seq++,
          role: itemRole,
          kind: item.kind,
          text,
          toolName: item.toolName,
          toolStatus: item.toolStatus,
          toolInputSummary: item.toolInputSummary,
          toolOutputSummary: item.toolOutputSummary,
          providerCreatedAt: createdAt,
          tokenCount: null,
          metadata: { type, contentType: item.contentType, isSidechain: row.isSidechain ?? null, toolUseId: item.toolUseId ?? null, source: 'claude-jsonl' }
        });
      }
    }

    warnings.push(...parsed.warnings);
    if (parsed.partialTrailingLine) warnings.push('partial trailing JSONL line; will retry on a later import');
    if (messages.length === 0) warnings.push('no supported Claude conversation messages found');
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
      metadata: { source: 'claude-jsonl', relativePath: filePath },
      messages,
      ...subagentActivity(filePath, usage, skills)
    };
    // Retain the session identity when filtering leaves no messages, so reimport
    // clears old guidance without deleting native resume links.
    return { provider: this.provider, sourcePath: filePath, sourceKind: 'jsonl', parserVersion: this.parserVersion, warnings, conversations: messages.length || (!parsed.warnings.length && !parsed.partialTrailingLine && hasSessionId) ? [conversation] : [] };
  }
}

function subagentFiles(filePath: string): string[] {
  const directory = path.join(filePath.slice(0, -'.jsonl'.length), 'subagents');
  try {
    return fs.readdirSync(directory).filter((name) => name.endsWith('.jsonl')).sort().map((name) => path.join(directory, name));
  } catch {
    return [];
  }
}

function subagentParent(filePath: string): string {
  return `${path.dirname(path.dirname(filePath))}.jsonl`;
}

// Subagent transcripts live in <session>/subagents/ and reuse the parent's
// sessionId, so importing them would replace the parent conversation.
function isConversationFile(filePath: string): boolean {
  return filePath.endsWith('.jsonl') && !filePath.endsWith('history.jsonl') && path.basename(path.dirname(filePath)) !== 'subagents';
}

// One response is written as several rows that repeat its usage, so rows are
// keyed by message ID and the last copy wins.
function collectClaudeUsage(row: Record<string, unknown>, usage: Map<string, ParsedUsage>, subagent: boolean): void {
  if (row.type !== 'assistant' || !row.message || typeof row.message !== 'object') return;
  const message = row.message as Record<string, unknown>;
  const tokens = message.usage && typeof message.usage === 'object' ? message.usage as Record<string, unknown> : null;
  const model = stringValue(message.model);
  if (!tokens || model === '<synthetic>') return;
  const cacheCreation = tokens.cache_creation && typeof tokens.cache_creation === 'object' ? tokens.cache_creation as Record<string, unknown> : {};
  const details = tokens.output_tokens_details && typeof tokens.output_tokens_details === 'object' ? tokens.output_tokens_details as Record<string, unknown> : {};
  const entry: ParsedUsage = {
    model,
    occurredAt: isoFromString(row.timestamp),
    inputTokens: nonNegative(tokens.input_tokens),
    cacheReadTokens: nonNegative(tokens.cache_read_input_tokens),
    cacheWriteTokens: nonNegative(tokens.cache_creation_input_tokens),
    cacheWrite1hTokens: nonNegative(cacheCreation.ephemeral_1h_input_tokens),
    outputTokens: nonNegative(tokens.output_tokens),
    reasoningTokens: nonNegative(details.thinking_tokens),
    costUsd: null,
    subagent
  };
  if (entry.inputTokens + entry.cacheReadTokens + entry.cacheWriteTokens + entry.outputTokens === 0) return;
  const key = stringValue(message.id) ?? stringValue(row.requestId) ?? stringValue(row.uuid) ?? `${usage.size}`;
  usage.set(key, entry);
}

// Claude Code loads a skill's instructions as a meta row, whether the agent
// called the Skill tool or the user typed its slash command.
function collectClaudeSkill(row: Record<string, unknown>, skills: ParsedSkillUse[], subagent: boolean): void {
  if (row.isMeta !== true || !row.message || typeof row.message !== 'object') return;
  const match = /^Base directory for this skill: (.+)$/m.exec(textFromUnknown((row.message as Record<string, unknown>).content));
  if (!match) return;
  skills.push({ name: path.basename(match[1]!.trim()), invokedBy: row.sourceToolUseID ? 'agent' : 'user', occurredAt: isoFromString(row.timestamp), subagent });
}

// Subagents bill against the same account but are not imported as
// conversations, so only their usage and skills are read.
function subagentActivity(filePath: string, usage: Map<string, ParsedUsage>, skills: ParsedSkillUse[]): Pick<ParsedConversation, 'usage' | 'skills'> {
  const childUsage = new Map<string, ParsedUsage>();
  const childSkills: ParsedSkillUse[] = [];
  for (const child of subagentFiles(filePath)) {
    try {
      for (const record of readJsonl(child).records) {
        if (!record || typeof record !== 'object') continue;
        collectClaudeUsage(record as Record<string, unknown>, childUsage, true);
        collectClaudeSkill(record as Record<string, unknown>, childSkills, true);
      }
    } catch {
      // A subagent file can vanish mid-read; its activity returns on the next import.
    }
  }
  return { usage: [...usage.values(), ...childUsage.values()], skills: [...skills, ...childSkills] };
}

interface ClaudeContentItem {
  index: number;
  role?: ParsedMessage['role'];
  kind: ParsedMessage['kind'];
  contentType: string | null;
  text: string;
  toolName: string | null;
  toolStatus: string | null;
  toolInputSummary: string | null;
  toolOutputSummary: string | null;
  toolUseId?: string | null;
}

function extractClaudeContent(content: unknown, rowType: string, row: Record<string, unknown>, toolNamesByUseId: Map<string, string>): ClaudeContentItem[] {
  const blocks = Array.isArray(content) ? content : [content];
  const out: ClaudeContentItem[] = [];
  blocks.forEach((block, index) => {
    if (typeof block === 'string') {
      if (block.trim()) out.push(messageItem(index, rowType === 'summary' ? 'summary' : 'message', null, block));
      return;
    }
    if (!block || typeof block !== 'object') return;
    const record = block as Record<string, unknown>;
    const contentType = stringValue(record.type);
    if (contentType === 'thinking' || contentType === 'redacted_thinking') return;
    if (contentType === 'text') {
      const text = textFromUnknown(record.text);
      if (text.trim()) out.push(messageItem(index, 'message', contentType, text));
      return;
    }
    if (contentType === 'tool_use') {
      const toolUseId = stringValue(record.id);
      const toolName = stringValue(record.name);
      if (toolUseId && toolName) toolNamesByUseId.set(toolUseId, toolName);
      out.push({
        index,
        role: 'tool',
        kind: 'tool_call',
        contentType,
        text: '',
        toolName,
        toolStatus: null,
        toolInputSummary: textFromUnknown(record.input) || null,
        toolOutputSummary: null,
        toolUseId
      });
      return;
    }
    if (contentType === 'tool_result') {
      const toolUseId = stringValue(record.tool_use_id);
      const output = textFromUnknown(record.content) || null;
      if (!output && record.is_error !== true) return;
      out.push({
        index,
        role: 'tool',
        kind: 'tool_result',
        contentType,
        text: '',
        toolName: toolUseId ? toolNamesByUseId.get(toolUseId) ?? null : null,
        toolStatus: record.is_error === true ? 'error' : 'completed',
        toolInputSummary: null,
        toolOutputSummary: output,
        toolUseId
      });
      return;
    }
    const text = textFromUnknown(record.text ?? record.content ?? record.summary);
    if (text.trim()) out.push(messageItem(index, rowType === 'summary' ? 'summary' : 'message', contentType, text));
  });
  if (out.length > 0) return out;
  const toolName = stringValue(row.toolName) ?? stringValue(row.name);
  if (rowType.includes('tool') || toolName) {
    return [{ index: 0, role: 'tool', kind: row.output ? 'tool_result' : 'tool_call', contentType: rowType, text: '', toolName, toolStatus: stringValue(row.status), toolInputSummary: textFromUnknown(row.input) || null, toolOutputSummary: textFromUnknown(row.output) || null }];
  }
  return [];
}

function messageItem(index: number, kind: ParsedMessage['kind'], contentType: string | null, text: string): ClaudeContentItem {
  return { index, kind, contentType, text, toolName: null, toolStatus: null, toolInputSummary: null, toolOutputSummary: null };
}

function mapRole(value: string | null): ParsedMessage['role'] {
  if (value === 'user') return 'user';
  if (value === 'assistant') return 'assistant';
  if (value === 'system') return 'system';
  if (value === 'tool') return 'tool';
  return 'unknown';
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0]?.slice(0, 120) ?? '';
}

function fileMtimeMs(filePath: string): number {
  try {
    return Math.round(fs.statSync(filePath).mtimeMs);
  } catch {
    return 0;
  }
}
