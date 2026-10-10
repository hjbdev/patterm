export type AgentHistoryProvider = 'claude' | 'codex' | 'opencode' | 'amp';

export const HISTORY_IMPORT_STALE_MS = 5 * 60_000;

export interface ParsedConversation {
  provider: AgentHistoryProvider;
  providerConversationId: string;
  title: string | null;
  cwd: string | null;
  providerVersion: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  endedAt: string | null;
  status: 'active' | 'imported';
  sourcePath: string;
  metadata: Record<string, unknown>;
  messages: ParsedMessage[];
  // One row per model response. Input excludes cached tokens; output
  // includes reasoning, which is also reported on its own.
  usage?: ParsedUsage[];
  // The newest quota windows the transcript recorded.
  rateLimits?: ParsedRateLimit[];
  // Each time a skill was loaded, by the agent or by the user's command.
  skills?: ParsedSkillUse[];
  // Images the user pasted or the agent viewed, in transcript order.
  media?: ParsedMedia[];
}

// An image stays in the native transcript; the index records where to read
// it back. A JSONL image is a string at `pointer` inside the record at
// `offset`; an OpenCode image is one in a row's JSON data.
export type MediaLocator =
  | { type: 'jsonl'; offset: number; length: number; pointer: Array<string | number> }
  | { type: 'sqlite'; table: 'part' | 'session_message'; rowId: string; pointer: Array<string | number> };

export interface ParsedMedia {
  // The seq of the message the image belongs to, or the one before it.
  messageSeq: number | null;
  kind: 'pasted' | 'viewed';
  mime: string;
  sha256: string;
  sizeBytes: number;
  // The image's file path or name, when the transcript records one.
  name: string | null;
  occurredAt: string | null;
  locator: MediaLocator;
}

export interface ParsedSkillUse {
  name: string;
  invokedBy: 'agent' | 'user';
  occurredAt: string | null;
  subagent: boolean;
}

export interface ParsedUsage {
  model: string | null;
  occurredAt: string | null;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  // The part of cacheWriteTokens cached for an hour, which costs more.
  cacheWrite1hTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
  subagent: boolean;
}

export interface ParsedRateLimit {
  key: string;
  label: string;
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: string | null;
  observedAt: string;
}

export interface ParsedMessage {
  providerMessageId: string | null;
  parentProviderMessageId: string | null;
  turnId: string | null;
  seq: number;
  role: 'user' | 'assistant' | 'system' | 'tool' | 'unknown';
  kind: 'message' | 'tool_call' | 'tool_result' | 'summary' | 'event';
  text: string;
  toolName: string | null;
  toolStatus: string | null;
  toolInputSummary: string | null;
  toolOutputSummary: string | null;
  providerCreatedAt: string | null;
  tokenCount: number | null;
  metadata: Record<string, unknown>;
}

export interface ParsedHistoryStream {
  provider: AgentHistoryProvider;
  sourcePath: string;
  sourceKind: string;
  parserVersion: string;
  warnings: string[];
  conversations: Iterable<ParsedConversation>;
}

export interface ParsedHistoryFile extends ParsedHistoryStream {
  conversations: ParsedConversation[];
}

export interface ParseHistoryFileOptions {
  providerConversationIds?: string[];
}

export interface HistoryFileFingerprint {
  sizeBytes: number | null;
  mtimeMs: number | null;
  contentHash: string | null;
  metadata: Record<string, unknown>;
  digest: string;
}

export interface HistorySourceCandidate {
  provider: AgentHistoryProvider;
  sourceKind: 'default' | 'manual_file' | 'manual_directory' | 'opencode_db' | 'amp_cli';
  path: string;
  exists: boolean;
  enabled?: boolean;
  watch_enabled?: boolean;
}

export interface ProviderHistoryAdapter {
  readonly provider: AgentHistoryProvider;
  readonly parserVersion: string;
  defaultSources(homeDir: string): HistorySourceCandidate[];
  discoverFiles(sourcePath: string): string[];
  discoverFilesAsync?(sourcePath: string): Promise<string[]>;
  discoverFilesSince?(sourcePath: string, sinceMtimeMs: number, forcePaths?: string[]): string[];
  quickFingerprintFile?(filePath: string): HistoryFileFingerprint;
  changedProviderConversationIds?(previousFingerprint: Record<string, unknown> | null, currentFingerprint: Record<string, unknown>): string[] | null;
  parseFile(filePath: string, options?: ParseHistoryFileOptions): ParsedHistoryFile;
  parseFileAsync?(filePath: string, options?: ParseHistoryFileOptions): Promise<ParsedHistoryFile>;
  parseFileStream?(filePath: string, options?: ParseHistoryFileOptions): ParsedHistoryStream;
  fingerprintFile?(filePath: string): HistoryFileFingerprint;
  filterDiscoveredFiles?(filePaths: string[], scope: HistoryImportScope): string[];
}

export interface HistoryImportScope {
  projectPaths: string[];
  providerConversationIds: string[];
  excludedProviderConversationIds: string[];
}

export interface RedactedText {
  text: string;
  redactionCount: number;
}

export const TOOL_INPUT_CAP = 8_192;
export const TOOL_OUTPUT_CAP = 16_384;
export const MESSAGE_TEXT_CAP = 128_000;
