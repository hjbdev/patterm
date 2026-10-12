import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { HistoryFileFingerprint, HistorySourceCandidate, ParseHistoryFileOptions, ParsedConversation, ParsedHistoryFile, ParsedHistoryStream, ParsedMedia, ParsedMessage, ParsedUsage, ProviderHistoryAdapter } from './AgentHistoryTypes';
import { digestJson, isoFromMillis, nonNegative, parsedImage, sqliteSidecarFingerprint, skillUsesFromMessages, sqliteSidecarStatFingerprint, stableJson, stringValue, textFromUnknown } from './HistoryAdapterUtils';

interface OpenCodeSessionRow {
  id: string;
  directory: string;
  title: string;
  version: string;
  time_created: number;
  time_updated: number;
  parent_id: string | null;
  agent: string | null;
  model: string | null;
  metadata: string | null;
}

interface OpenCodeMessageRow {
  type: string | null;
  id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
}

interface OpenCodePartRow {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
}

export class OpenCodeHistoryAdapter implements ProviderHistoryAdapter {
  readonly provider = 'opencode' as const;
  readonly parserVersion = 'opencode-sqlite-v9';

  defaultSources(homeDir: string): HistorySourceCandidate[] {
    const db = path.join(homeDir, '.local', 'share', 'opencode', 'opencode.db');
    return [{ provider: this.provider, sourceKind: 'opencode_db', path: db, exists: fs.existsSync(db) }];
  }

  discoverFiles(sourcePath: string): string[] {
    if (fs.existsSync(sourcePath) && fs.statSync(sourcePath).isFile()) return [sourcePath];
    const db = path.join(sourcePath, 'opencode.db');
    return fs.existsSync(db) ? [db] : [];
  }

  fingerprintFile(filePath: string): HistoryFileFingerprint {
    return openCodeLogicalFingerprint(filePath);
  }

  quickFingerprintFile(filePath: string): HistoryFileFingerprint {
    return sqliteSidecarStatFingerprint(filePath);
  }

  changedProviderConversationIds(previousFingerprint: Record<string, unknown> | null, currentFingerprint: Record<string, unknown>): string[] | null {
    const current = sessionFingerprintStates(currentFingerprint);
    if (!current) return null;
    const previous = sessionFingerprintStates(previousFingerprint);
    const previousById = previous ? new Map(previous.map((state) => [state.id, state.digest])) : null;
    const legacyWatermark = previous ? null : legacyFingerprintWatermark(previousFingerprint);
    if (!previousById && legacyWatermark === null) return null;
    const changed = previousById
      ? current.filter((state) => state.active && previousById.get(state.id) !== state.digest)
      : current.filter((state) => state.active && state.maxUpdated >= legacyWatermark!);
    return changed
      .sort((a, b) => b.maxUpdated - a.maxUpdated)
      .map((state) => state.id);
  }

  parseFile(filePath: string, options: ParseHistoryFileOptions = {}): ParsedHistoryFile {
    const parsed = this.parseFileStream(filePath, options);
    return { ...parsed, conversations: [...parsed.conversations] };
  }

  parseFileStream(filePath: string, options: ParseHistoryFileOptions = {}): ParsedHistoryStream {
    const warnings: string[] = [];
    return { provider: this.provider, sourcePath: filePath, sourceKind: 'opencode_db', parserVersion: this.parserVersion, warnings, conversations: this.readConversations(filePath, options, warnings) };
  }

  private *readConversations(filePath: string, options: ParseHistoryFileOptions, warnings: string[]): Generator<ParsedConversation> {
    const db = new DatabaseSync(filePath, { readOnly: true });
    try {
      try {
        db.exec('pragma busy_timeout = 250');
      } catch {
        // Older node:sqlite builds may not support this pragma in read-only mode.
      }
      const legacy = hasTables(db, ['session', 'message', 'part']);
      const v2 = hasTables(db, ['session_v2', 'session_message']);
      if (!legacy && !v2) {
        warnings.push('unsupported OpenCode database schema');
        return;
      }
      const selectedIds = options.providerConversationIds?.filter(Boolean) ?? [];
      const readSessions = (table: 'session' | 'session_v2') => options.providerConversationIds
        ? selectedIds.length
          ? db.prepare(`select id, directory, title, version, time_created, time_updated, parent_id, agent, model, metadata from ${table} where time_archived is null and id in (${selectedIds.map((_, index) => `?${index + 1}`).join(', ')}) order by time_updated desc`).all(...selectedIds) as unknown as OpenCodeSessionRow[]
          : []
        : db.prepare(`select id, directory, title, version, time_created, time_updated, parent_id, agent, model, metadata from ${table} where time_archived is null order by time_updated desc`).all() as unknown as OpenCodeSessionRow[];
      const seen = new Set<string>();
      let count = 0;
      for (const table of [...(v2 ? ['session_v2' as const] : []), ...(legacy ? ['session' as const] : [])]) {
        for (const session of readSessions(table)) {
          if (seen.has(session.id)) continue;
          seen.add(session.id);
          const warningCount = warnings.length;
          const parsed = this.parseSession(db, session, warnings, filePath, table === 'session_v2');
          // A valid empty session clears stale imported context; corrupt input must not.
          if (parsed.messages.length || warnings.length === warningCount) {
            count += 1;
            // The worker imports this conversation before parsing the next one.
            // Peak transcript memory is still bounded by the largest conversation.
            yield parsed;
          }
        }
      }
      if (count === 0) warnings.push('no supported OpenCode conversations found');
    } finally {
      db.close();
    }
  }

  private parseSession(db: DatabaseSync, session: OpenCodeSessionRow, warnings: string[], sourcePath: string, v2 = false): ParsedConversation {
    const messageRows = db.prepare(`select id, session_id, ${v2 ? 'type' : 'null as type'}, time_created, time_updated, data from ${v2 ? 'session_message' : 'message'} where session_id = ? order by ${v2 ? 'seq' : 'time_created'} asc`).all(session.id) as unknown as OpenCodeMessageRow[];
    const partRows = v2 ? openCode2Parts(messageRows, warnings) : db.prepare(`select id, message_id, session_id, time_created, time_updated, data from part where session_id = ? order by time_created asc`).all(session.id) as unknown as OpenCodePartRow[];
    const messageDataById = new Map<string, Record<string, unknown>>();
    for (const message of messageRows) {
      try {
        const data = JSON.parse(message.data) as Record<string, unknown>;
        messageDataById.set(message.id, v2 ? { ...data, role: message.type === 'compaction' ? 'system' : message.type ?? data.type } : data);
      } catch {
        warnings.push(`message ${message.id}: invalid JSON data`);
      }
    }

    const messages: ParsedMessage[] = [];
    let seq = 0;
    for (const part of partRows) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(part.data) as Record<string, unknown>;
      } catch {
        warnings.push(`part ${part.id}: invalid JSON data`);
        continue;
      }
      const parent = messageDataById.get(part.message_id);
      const type = stringValue(data.type) ?? 'message';
      const role = mapRole(stringValue(parent?.role));
      const tool = parseToolPart(data);
      const textContent = summarizeInlineFiles(tool ? '' : textFromUnknown(data.text ?? data.content ?? data.summary));
      const text = textContent.text;
      if (!text && !tool && type !== 'step-finish' && !(role === 'assistant' && type === 'text' && !completedProse(data, parent))) continue;
      messages.push({
        providerMessageId: part.id,
        parentProviderMessageId: stringValue(parent?.parentID),
        turnId: part.message_id,
        seq: seq++,
        role: tool ? 'tool' : role,
        kind: tool ? (tool.output ? 'tool_result' : 'tool_call') : type === 'step-finish' ? 'summary' : 'message',
        text,
        toolName: tool?.name ?? null,
        toolStatus: tool?.status ?? null,
        toolInputSummary: tool?.input ?? null,
        toolOutputSummary: tool?.output ?? null,
        providerCreatedAt: isoFromMillis(part.time_created),
        tokenCount: tokenCount(data.tokens),
        metadata: { type, prose_finalized: role !== 'assistant' || completedProse(data, parent), messageId: part.message_id, fileReferences: [...textContent.fileReferences, ...(tool?.fileReferences ?? [])], toolMetadata: tool?.metadata ?? {}, source: 'opencode-sqlite' }
      });
    }

    // v2 parts are cut from their message row, so its images are read from
    // the row; legacy parts are rows of their own.
    const firstSeq = new Map<string, number>();
    for (const message of messages) if (message.turnId && !firstSeq.has(message.turnId)) firstSeq.set(message.turnId, message.seq);
    const media = (v2 ? messageRows.map((row) => ({ table: 'session_message' as const, id: row.id, messageId: row.id, created: row.time_created, data: row.data }))
      : partRows.map((row) => ({ table: 'part' as const, id: row.id, messageId: row.message_id, created: row.time_created, data: row.data })))
      .flatMap((row) => openCodeImages(row, messageDataById.get(row.messageId)?.role === 'user' ? 'pasted' : 'viewed', firstSeq.get(row.messageId) ?? null));

    return {
      provider: this.provider,
      providerConversationId: session.id,
      title: session.title || null,
      cwd: session.directory || null,
      providerVersion: session.version || null,
      startedAt: isoFromMillis(session.time_created),
      updatedAt: isoFromMillis(effectiveSessionUpdatedAt(session, messageRows, partRows)),
      endedAt: null,
      status: 'active',
      sourcePath,
      metadata: { parentId: session.parent_id, agent: session.agent, model: session.model, providerMetadata: safeJson(session.metadata) },
      messages,
      media,
      usage: messageRows.flatMap((row) => openCodeUsage(row, messageDataById.get(row.id), Boolean(session.parent_id))),
      skills: skillUsesFromMessages(messages, { subagent: Boolean(session.parent_id), finishedCalls: true })
    };
  }
}

// V1 text parts use time.end; V2 content and its assistant envelope use
// time.completed, matching OpenCodeServerService's native time projection.
function completedProse(part: Record<string, unknown>, parent: Record<string, unknown> | undefined): boolean {
  const partTime = part.time && typeof part.time === 'object' ? part.time as Record<string, unknown> : {};
  const parentTime = parent?.time && typeof parent.time === 'object' ? parent.time as Record<string, unknown> : {};
  return [partTime.end, partTime.completed, parentTime.completed].some(value =>
    typeof value === 'number' && Number.isFinite(value) && value > 0);
}

// Assistant messages carry their own tokens and cost. OpenCode reports
// reasoning apart from output.
function openCodeUsage(row: OpenCodeMessageRow, data: Record<string, unknown> | undefined, subagent: boolean): ParsedUsage[] {
  if (data?.role !== 'assistant' || !data.tokens || typeof data.tokens !== 'object') return [];
  const tokens = data.tokens as Record<string, unknown>;
  const cache = tokens.cache && typeof tokens.cache === 'object' ? tokens.cache as Record<string, unknown> : {};
  const model = data.model && typeof data.model === 'object' ? stringValue((data.model as Record<string, unknown>).id) : stringValue(data.modelID);
  const time = data.time && typeof data.time === 'object' ? (data.time as Record<string, unknown>).created : null;
  const usage: ParsedUsage = {
    model,
    occurredAt: isoFromMillis(typeof time === 'number' ? time : row.time_created),
    inputTokens: nonNegative(tokens.input),
    cacheReadTokens: nonNegative(cache.read),
    cacheWriteTokens: nonNegative(cache.write),
    cacheWrite1hTokens: 0,
    outputTokens: nonNegative(tokens.output) + nonNegative(tokens.reasoning),
    reasoningTokens: nonNegative(tokens.reasoning),
    costUsd: typeof data.cost === 'number' && Number.isFinite(data.cost) ? data.cost : null,
    subagent
  };
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens > 0 ? [usage] : [];
}

// User files keep base64 in `data`; tool results and legacy file parts keep a
// data URI in `uri` or `url`.
function openCodeImages(row: { table: 'part' | 'session_message'; id: string; created: number; data: string }, kind: ParsedMedia['kind'], messageSeq: number | null): ParsedMedia[] {
  if (!row.data.includes('image/')) return [];
  let data: unknown;
  try {
    data = JSON.parse(row.data);
  } catch {
    return [];
  }
  const out: ParsedMedia[] = [];
  const visit = (value: unknown, pointer: Array<string | number>) => {
    if (Array.isArray(value)) return value.forEach((item, index) => visit(item, [...pointer, index]));
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const field = typeof record.mime === 'string' && record.mime.startsWith('image/') ? (['data', 'uri', 'url'] as const).find((key) => typeof record[key] === 'string') : undefined;
    if (field) {
      const name = stringValue(record.name) ?? stringValue(record.filename);
      const image = parsedImage(record[field], record.mime, { messageSeq, kind, name, occurredAt: isoFromMillis(row.created), locator: { type: 'sqlite', table: row.table, rowId: row.id, pointer: [...pointer, field] } });
      if (image) out.push(image);
      return;
    }
    for (const [key, child] of Object.entries(record)) visit(child, [...pointer, key]);
  };
  visit(data, []);
  return out;
}

function openCode2Parts(messages: OpenCodeMessageRow[], warnings: string[]): OpenCodePartRow[] {
  return messages.flatMap((message) => {
    try {
      const data = JSON.parse(message.data) as Record<string, unknown>;
      const type = message.type ?? data.type;
      if (type === 'synthetic' || type === 'system' || type === 'agent-switched' || type === 'model-switched') return [];
      const content = Array.isArray(data.content) ? data.content
        : type === 'user' ? [{ type: 'text', text: [textFromUnknown(data.text), ...openCodeAttachmentLabels(data.files)].filter(Boolean).join('\n') }]
        : type === 'compaction' ? [{ type: 'step-finish', text: data.summary }]
        : type === 'shell' ? [{ type: 'tool', name: 'shell', state: { status: data.status, input: { command: data.command }, output: textFromUnknown(data.output) } }]
        : [];
      return content.flatMap((part: unknown, index: number) => {
        if (!part || typeof part !== 'object') return [];
        const item = part as Record<string, unknown>;
        const state = item.state && typeof item.state === 'object' ? item.state as Record<string, unknown> : {};
        const output = Array.isArray(state.content)
          ? state.content.filter((value) => value?.type === 'text').map((value) => value.text).join('\n')
          : state.output ?? state.error;
        return [{
          ...message, id: `${message.id}:${index}`, message_id: message.id,
          data: JSON.stringify(item.type === 'tool' ? { ...item, tool: item.name, state: { ...state, output } } : item)
        }];
      });
    } catch {
      warnings.push(`message ${message.id}: invalid OpenCode JSON data`);
      return [];
    }
  });
}

function openCodeAttachmentLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(file => {
    if (!file || typeof file !== 'object') return [];
    const name = stringValue(file.name) ?? stringValue(file.filename) ?? stringValue(file.mime) ?? 'file';
    return [`Attachment: ${name}`];
  });
}

function summarizeInlineFiles(text: string): { text: string; fileReferences: string[] } {
  const fileReferences: string[] = [];
  const replaced = text.replace(/<path>([\s\S]*?)<\/path>\s*<type>([\s\S]*?)<\/type>\s*<content>([\s\S]*?)<\/content>/g, (_match, rawPath: string, rawType: string, rawContent: string) => {
    const filePath = rawPath.trim();
    if (filePath) fileReferences.push(filePath);
    const parts = [`File: ${filePath || 'unknown'}`];
    const type = rawType.trim();
    if (type) parts.push(`Type: ${type}`);
    parts.push(`Preview:\n${capText(rawContent.trim(), 2_000)}`);
    return parts.join('\n');
  });
  return { text: replaced, fileReferences };
}

function hasTables(db: DatabaseSync, names: string[]): boolean {
  const rows = db.prepare(`select name from sqlite_master where type = 'table'`).all() as Array<{ name: string }>;
  const existing = new Set(rows.map((row) => row.name));
  return names.every((name) => existing.has(name));
}

function openCodeLogicalFingerprint(filePath: string): HistoryFileFingerprint {
  let db: DatabaseSync | null = null;
  try {
    const physicalBefore = sqliteSidecarStatFingerprint(filePath);
    db = new DatabaseSync(filePath, { readOnly: true });
    try {
      db.exec('pragma busy_timeout = 250');
    } catch {
      // Older node:sqlite builds may not support this pragma in read-only mode.
    }
    const legacy = hasTables(db, ['session', 'message', 'part']);
    const v2 = hasTables(db, ['session_v2', 'session_message']);
    if (!legacy && !v2) return sqliteSidecarFingerprint(filePath);
    // OpenCode advances session.time_updated with child writes; use that boundary
    // instead of scanning multi-gigabyte message and part tables on every sync.
    const sessions = [
      ...(v2 ? db.prepare(`select s.id, max(s.time_updated, coalesce(max(m.time_updated), 0)) as time_updated, s.time_archived, count(m.id) as message_count from session_v2 s left join session_message m on m.session_id = s.id group by s.id order by s.id`).all() as unknown as SessionFingerprintRow[] : []),
      ...(legacy ? db.prepare(`select id, time_updated, time_archived from session order by id`).all() as unknown as SessionFingerprintRow[] : [])
    ];
    const uniqueSessions = [...new Map([...sessions].reverse().map((session) => [session.id, session])).values()].sort((a, b) => a.id.localeCompare(b.id));
    const sessionStates = uniqueSessions.map((session) => ({
      id: session.id,
      active: session.time_archived === null,
      maxUpdated: session.time_updated ?? 0,
      digest: digestJson([session.id, session.time_updated, session.time_archived, ...(session.message_count === undefined ? [] : [session.message_count])])
    }));
    const logicalMetadata = {
      schema: 'opencode-logical-v4',
      sessionStates,
      historyMaxUpdated: sessionStates.reduce((max, state) => Math.max(max, state.maxUpdated), 0)
    };
    const physicalAfter = sqliteSidecarStatFingerprint(filePath);
    const digest = digestJson(physicalBefore.digest === physicalAfter.digest
      ? logicalMetadata
      : { ...logicalMetadata, changedDuringFingerprint: [physicalBefore.digest, physicalAfter.digest] });
    return {
      sizeBytes: physicalAfter.sizeBytes,
      mtimeMs: physicalAfter.mtimeMs,
      contentHash: digest,
      metadata: { ...logicalMetadata, physicalDigest: physicalAfter.digest },
      digest
    };
  } catch {
    return sqliteSidecarFingerprint(filePath);
  } finally {
    db?.close();
  }
}

interface SessionFingerprintRow { id: string; time_updated: number | null; time_archived: number | null; message_count?: number; }
interface SessionFingerprintState { id: string; active: boolean; maxUpdated: number; digest: string; }

function sessionFingerprintStates(metadata: Record<string, unknown> | null): SessionFingerprintState[] | null {
  if (metadata?.schema !== 'opencode-logical-v4' || !Array.isArray(metadata.sessionStates)) return null;
  const states = metadata.sessionStates;
  if (!states.every((state) => state && typeof state === 'object' && typeof state.id === 'string' && typeof state.active === 'boolean' && typeof state.maxUpdated === 'number' && typeof state.digest === 'string')) return null;
  return states as SessionFingerprintState[];
}

function legacyFingerprintWatermark(metadata: Record<string, unknown> | null): number | null {
  const value = metadata?.historyMaxUpdated;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function effectiveSessionUpdatedAt(session: OpenCodeSessionRow, messages: OpenCodeMessageRow[], parts: OpenCodePartRow[]): number {
  let updatedAt = session.time_updated;
  for (const message of messages) updatedAt = Math.max(updatedAt, message.time_updated);
  for (const part of parts) updatedAt = Math.max(updatedAt, part.time_updated);
  return updatedAt;
}

function parseToolPart(data: Record<string, unknown>): { name: string | null; status: string | null; input: string | null; output: string | null; metadata: Record<string, unknown>; fileReferences: string[] } | null {
  if (!('tool' in data) && !('callID' in data)) return null;
  const state = data.state && typeof data.state === 'object' ? data.state as Record<string, unknown> : {};
  const metadata = state.metadata && typeof state.metadata === 'object' ? state.metadata as Record<string, unknown> : {};
  const input = state.input && typeof state.input === 'object' ? state.input as Record<string, unknown> : {};
  const toolName = stringValue(data.tool);
  const filePath = stringValue(input.filePath) ?? stringValue(input.file_path) ?? stringValue(input.path);
  const rawOutput = textFromUnknown(state.output ?? state.error) || null;
  return {
    name: toolName,
    status: stringValue(state.status),
    input: textFromUnknown(state.input) || null,
    output: summarizeToolOutput(toolName, filePath, rawOutput, metadata),
    metadata,
    fileReferences: filePath ? [filePath] : []
  };
}

function summarizeToolOutput(toolName: string | null, filePath: string | null, output: string | null, metadata: Record<string, unknown>): string | null {
  if (!output) return null;
  if (!filePath || !isFileReadTool(toolName)) return capText(output, 8_000);
  const preview = stringValue(metadata.preview);
  const truncated = metadata.truncated === true || /\n\(Showing lines |\n\(Results are truncated|\n\(Output truncated/i.test(output);
  const type = output.match(/<type>([^<]+)<\/type>/)?.[1];
  const parts = [`File: ${filePath}`];
  if (type) parts.push(`Type: ${type}`);
  if (truncated) parts.push('OpenCode reported this output as truncated.');
  const snippet = preview || extractTaggedContent(output) || output;
  parts.push(`Preview:\n${capText(snippet, 2_000)}`);
  return parts.join('\n');
}

function isFileReadTool(toolName: string | null): boolean {
  return ['read', 'view', 'open'].includes((toolName ?? '').toLowerCase());
}

function extractTaggedContent(output: string): string | null {
  const content = output.match(/<content>([\s\S]*?)<\/content>/)?.[1];
  const entries = output.match(/<entries>([\s\S]*?)<\/entries>/)?.[1];
  return (content ?? entries ?? '').trim() || null;
}

function capText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n\n[truncated ${value.length - limit} chars]`;
}

function mapRole(value: string | null): ParsedMessage['role'] {
  if (value === 'user') return 'user';
  if (value === 'assistant') return 'assistant';
  if (value === 'system') return 'system';
  if (value === 'tool') return 'tool';
  return 'unknown';
}

function tokenCount(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null;
  const total = (value as Record<string, unknown>).total;
  return typeof total === 'number' && Number.isFinite(total) ? total : null;
}

function safeJson(value: string | null): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return stableJson(value);
  }
}
