import type { ConversationMessageRecord } from '../types';
import { buildTranscriptTool, diffChangeCounts, type TranscriptMessage, type TranscriptToolFile } from './integratedConversation';

interface ArchiveDisplay {
  text: string;
  fileReferences: string[];
  toolDetail: string | null;
  approval: TranscriptMessage['approval'];
}

interface ApprovalDetails {
  riskLevel: string | null;
  userAuthorization: string | null;
  outcome: string | null;
  rationale: string | null;
}

export interface ArchiveDisplayEntry {
  displayText: string;
  fileReferences: string[];
  toolDetail: string | null;
  approvalDetails: ApprovalDetails | null;
}

export type ArchiveDisplayCache = Map<string, ArchiveDisplayEntry>;

export interface ArchiveTranscriptOptions {
  projectPath: string | null;
  showReasoning: boolean;
  // Display parsing is costly for long transcripts; callers that re-project
  // the same rows keep a cache and clear it when the project path changes.
  cache?: ArchiveDisplayCache;
}

// Imported rows become transcript rows. Tool results fold into their call, and
// rows with nothing to show are dropped. The History view and Integrated
// backfill both use this, so an archived turn looks the same in each.
export function archiveTranscript(messages: ConversationMessageRecord[], options: ArchiveTranscriptOptions): TranscriptMessage[] {
  const cache = options.cache ?? new Map<string, ArchiveDisplayEntry>();
  return combineToolResults(messages)
    .filter((message) => hasVisibleContent(message, options, cache))
    .map((message) => {
      const display = cachedDisplay(message, options.projectPath, cache);
      return archiveTranscriptMessage(message, {
        text: display.displayText,
        fileReferences: display.fileReferences,
        toolDetail: display.toolDetail,
        approval: display.approvalDetails ?? undefined
      });
    });
}

export function isReasoningMessage(message: ConversationMessageRecord): boolean {
  return message.metadata?.type === 'reasoning';
}

// A folded tool call finishes when its result was recorded.
type CombinedMessageRecord = ConversationMessageRecord & { providerCompletedAt?: string | null };

function combineToolResults(messages: ConversationMessageRecord[]): CombinedMessageRecord[] {
  const result: CombinedMessageRecord[] = [];
  const calls = new Map<string, number>();
  for (const message of messages) {
    const key = toolCallKey(message);
    const index = key ? calls.get(key) : undefined;
    if (message.kind === 'tool_result' && index !== undefined) {
      const call = result[index]!;
      result[index] = { ...call, toolOutputSummary: [call.toolOutputSummary, message.toolOutputSummary].filter(Boolean).join('\n') || null,
        toolStatus: message.toolStatus ?? call.toolStatus, redactionCount: (call.redactionCount ?? 0) + (message.redactionCount ?? 0),
        providerCompletedAt: message.providerCreatedAt ?? call.providerCompletedAt ?? null };
    } else {
      if (key && message.kind === 'tool_call') calls.set(key, result.length);
      result.push(message);
    }
  }
  return result;
}

export function toolCallKey(message: ConversationMessageRecord): string | null {
  const value = message.metadata?.callId ?? message.metadata?.toolUseId;
  return typeof value === 'string' && value ? value : null;
}

function cachedDisplay(message: ConversationMessageRecord, projectPath: string | null, cache: ArchiveDisplayCache): ArchiveDisplayEntry {
  const cached = cache.get(message.id);
  if (cached) return cached;

  const value = message.metadata?.fileReferences;
  const metadataReferences = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
  const text = message.text.trim();
  const references = [...new Set([...metadataReferences, ...inlineFileReferences(text)].map((item) => projectRelativePath(item, projectPath)))];
  const name = message.toolName ?? toolNameFromMetadata(message) ?? (references.length ? 'read' : 'tool');
  const entry: ArchiveDisplayEntry = {
    displayText: summarizeInlineFiles(text, projectPath),
    fileReferences: references,
    toolDetail: toolDetail(message, name, references, projectPath),
    approvalDetails: parseApprovalDetails(text)
  };
  cache.set(message.id, entry);
  return entry;
}

function hasVisibleContent(message: ConversationMessageRecord, options: ArchiveTranscriptOptions, cache: ArchiveDisplayCache): boolean {
  if (isReasoningMessage(message) && !options.showReasoning) return false;
  const display = cachedDisplay(message, options.projectPath, cache);
  return Boolean(display.displayText || display.approvalDetails || message.redactionCount || message.toolName || message.toolInputSummary || message.toolOutputSummary || display.fileReferences.length);
}

function toolNameFromMetadata(message: ConversationMessageRecord): string | null {
  const value = message.metadata?.toolName ?? message.metadata?.name;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function toolDetail(message: ConversationMessageRecord, name: string, fileReferences: string[], projectPath: string | null): string | null {
  const input = parseObject(message.toolInputSummary);
  const normalized = name.toLowerCase();
  if (normalized.includes('patch')) {
    const patch = firstString(input, ['patch', 'patchText', 'patch_text']) ?? message.toolInputSummary;
    const paths = [...(patch ?? '').matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map(match => match[1]!);
    if (paths.length) return paths.length === 1 ? projectRelativePath(paths[0]!, projectPath) : `${paths.length} files`;
  }
  if (isShellTool(normalized)) return firstLine(firstString(input, ['command', 'cmd', 'shell', 'script']) ?? message.toolInputSummary);

  const keyGroups = normalized.includes('skill')
    ? [['title', 'skill', 'name']]
    : normalized.includes('grep') || normalized.includes('search')
      ? [['path', 'filePath', 'file_path', 'include'], ['pattern', 'query']]
      : normalized.includes('glob')
        ? [['path', 'cwd'], ['pattern', 'glob']]
        : [['filePath', 'file_path', 'path', 'filename'], ['pattern', 'query', 'title']];

  for (const keys of keyGroups) {
    const value = firstString(input, keys);
    if (value) return projectRelativePath(value, projectPath);
  }

  return fileReferences[0] ?? null;
}

function isShellTool(normalizedName: string): boolean {
  return ['bash', 'shell', 'terminal', 'command'].some((part) => normalizedName.includes(part));
}

function firstLine(value: string | null): string | null {
  const line = value?.split(/\r?\n/).find((item) => item.trim());
  return line?.trim() || null;
}

function firstString(record: Record<string, unknown> | null, keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function projectRelativePath(value: string, projectPath: string | null): string {
  const path = value.trim();
  const root = projectPath?.trim();
  if (!path || !root) return path;

  const normalizedPath = path.replace(/\\/g, '/');
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalizedPath === normalizedRoot) return '.';
  if (!normalizedPath.startsWith(`${normalizedRoot}/`)) return path;
  return normalizedPath.slice(normalizedRoot.length + 1);
}

function summarizeInlineFiles(text: string, projectPath: string | null): string {
  return text.replace(/<path>([\s\S]*?)<\/path>\s*<type>([\s\S]*?)<\/type>\s*<content>([\s\S]*?)<\/content>/g, (_match, rawPath: string, rawType: string, rawContent: string) => {
    const filePath = projectRelativePath(rawPath.trim(), projectPath);
    const type = rawType.trim();
    return [`File: ${filePath || 'unknown'}`, type ? `Type: ${type}` : '', `Preview:\n${capText(rawContent.trim(), 2_000)}`].filter(Boolean).join('\n');
  });
}

function inlineFileReferences(text: string): string[] {
  return [...text.matchAll(/<path>([\s\S]*?)<\/path>\s*<type>[\s\S]*?<\/type>\s*<content>[\s\S]*?<\/content>/g)].map((match) => match[1]?.trim() ?? '').filter(Boolean);
}

function capText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n\n[truncated ${value.length - limit} chars]`;
}

function parseApprovalDetails(text: string): ApprovalDetails | null {
  if (!text.startsWith('{')) return null;
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const details = {
      riskLevel: stringField(record.risk_level),
      userAuthorization: stringField(record.user_authorization),
      outcome: stringField(record.outcome),
      rationale: stringField(record.rationale)
    };
    return details.riskLevel || details.userAuthorization || details.outcome || details.rationale ? details : null;
  } catch {
    return null;
  }
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

// Imported history has a different storage shape from a live native stream.
// Adapt it once, then let both surfaces use the same transcript rows.
export function archiveTranscriptMessage(message: CombinedMessageRecord, display: ArchiveDisplay): TranscriptMessage {
  const createdAt = isoTime(message.providerCreatedAt);
  const completedAt = isoTime(message.providerCompletedAt);
  const base: TranscriptMessage = {
    id: message.id,
    role: message.role === 'user' ? 'user' : 'assistant',
    kind: isArchivedTool(message) ? 'tool' : message.metadata?.type === 'reasoning' ? 'reasoning' : 'text',
    text: display.text,
    archived: true,
    ...(createdAt ? { createdAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(message.redactionCount ? { redactionCount: message.redactionCount } : {}),
    ...(display.fileReferences.length ? { fileReferences: display.fileReferences } : {}),
    ...(display.approval ? { approval: display.approval } : {})
  };
  if (base.kind !== 'tool') return base;

  const nativeName = message.metadata?.toolName ?? message.metadata?.name;
  const name = message.toolName ?? (typeof nativeName === 'string' ? nativeName : null) ?? (display.fileReferences.length ? 'read' : 'tool');
  const input = archiveToolInput(message.toolInputSummary, name);
  const output = message.toolOutputSummary ?? '';
  const tool = buildTranscriptTool(name, { input, state: { status: message.toolStatus ?? (output ? 'completed' : 'pending') } }, output);
  const files = archivedPatchFiles(message.toolInputSummary);
  if (files.length) {
    const additions = files.reduce((total, file) => total + (file.additions ?? 0), 0);
    const deletions = files.reduce((total, file) => total + (file.deletions ?? 0), 0);
    tool.files = files;
    tool.patch = '';
    tool.changes = { additions, deletions };
  }
  if (!tool.target && display.toolDetail) tool.target = display.toolDetail;
  return { ...base, text: output, title: name, tool };
}

// Imported provider times are stored as given; only parseable ones are kept.
function isoTime(value: string | null | undefined): string | undefined {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function isArchivedTool(message: ConversationMessageRecord): boolean {
  return message.role === 'tool' || message.kind.includes('tool') || Boolean(message.toolName || message.toolInputSummary || message.toolOutputSummary);
}

function archiveToolInput(summary: string | null, name: string): unknown {
  if (!summary) return undefined;
  const parsed = parseObject(summary);
  if (!/patch|edit|write/i.test(name)) return parsed ?? summary;
  const patch = patchValue(parsed) ?? summary;
  if (!patch.startsWith('*** Begin Patch\n') && !patch.startsWith('diff --git ')) return parsed ?? summary;
  return { ...(parsed ?? {}), patch };
}

function archivedPatchFiles(summary: string | null): TranscriptToolFile[] {
  if (!summary) return [];
  const patch = patchValue(parseObject(summary)) ?? summary;
  if (!patch.startsWith('*** Begin Patch\n')) return [];
  const files: TranscriptToolFile[] = [];
  for (const line of patch.split('\n')) {
    const path = line.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/)?.[1];
    if (path) files.push({ name: path, patch: '' });
    else if (files.length && line !== '*** Begin Patch' && line !== '*** End Patch') files.at(-1)!.patch += `${line}\n`;
  }
  return files.map((file) => ({ ...file, ...diffChangeCounts(file.patch ?? '') }));
}

function parseObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function patchValue(input: Record<string, unknown> | null): string | null {
  for (const key of ['patch', 'patchText', 'patch_text']) {
    const value = input?.[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}
