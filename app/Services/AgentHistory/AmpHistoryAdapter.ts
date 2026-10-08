import { execFile, execFileSync } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { HistoryFileFingerprint, HistoryImportScope, HistorySourceCandidate, ParsedConversation, ParsedHistoryFile, ParsedMessage, ProviderHistoryAdapter } from './AgentHistoryTypes';
import { digestJson, isoFromMillis, isoFromString, skillUsesFromMessages, stringValue, textFromUnknown } from './HistoryAdapterUtils';

const AMP_THREAD_PREFIX = 'amp://thread/';
const PAGE_SIZE = 100;
const MAX_THREAD_PAGES = 1_000;

export type AmpCommandRunner = (executable: string, args: string[]) => string;
export type AmpAsyncCommandRunner = (executable: string, args: string[]) => Promise<string>;
const execFileAsync = promisify(execFile);

interface AmpThreadSummary {
  id: string;
  title?: string;
  updated?: string;
  tree?: string;
  messageCount?: number;
}

export class AmpHistoryAdapter implements ProviderHistoryAdapter {
  readonly provider = 'amp' as const;
  readonly parserVersion = 'amp-export-v3';
  private readonly threads = new Map<string, AmpThreadSummary>();
  private executablePath: string | null = null;

  constructor(
    private readonly runCommand: AmpCommandRunner = runAmpCommand,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly runCommandAsync: AmpAsyncCommandRunner = runAmpCommandAsync
  ) {}

  defaultSources(homeDir: string): HistorySourceCandidate[] {
    const executable = resolveAmpExecutable(homeDir, this.env);
    return executable ? [{ provider: this.provider, sourceKind: 'amp_cli', path: executable, exists: true, watch_enabled: false }] : [];
  }

  discoverFiles(sourcePath: string): string[] {
    this.executablePath = sourcePath;
    this.threads.clear();
    for (let page = 0; page < MAX_THREAD_PAGES; page += 1) {
      const offset = page * PAGE_SIZE;
      const payload = parseJson(this.runCommand(sourcePath, ['threads', 'list', '--include-archived', '--limit', String(PAGE_SIZE), '--offset', String(offset), '--json']), 'thread list');
      if (!Array.isArray(payload)) throw new Error('Amp history thread list did not return an array');
      this.addThreadPage(payload);
      if (payload.length < PAGE_SIZE) break;
      if (page === MAX_THREAD_PAGES - 1) throw new Error('Amp history thread list exceeded the pagination limit');
    }
    return [...this.threads.keys()].sort();
  }

  async discoverFilesAsync(sourcePath: string): Promise<string[]> {
    this.executablePath = sourcePath;
    this.threads.clear();
    for (let page = 0; page < MAX_THREAD_PAGES; page += 1) {
      const offset = page * PAGE_SIZE;
      const payload = parseJson(await this.runCommandAsync(sourcePath, ['threads', 'list', '--include-archived', '--limit', String(PAGE_SIZE), '--offset', String(offset), '--json']), 'thread list');
      if (!Array.isArray(payload)) throw new Error('Amp history thread list did not return an array');
      this.addThreadPage(payload);
      if (payload.length < PAGE_SIZE) break;
      if (page === MAX_THREAD_PAGES - 1) throw new Error('Amp history thread list exceeded the pagination limit');
    }
    return [...this.threads.keys()].sort();
  }

  private addThreadPage(payload: unknown[]): void {
    for (const row of payload.filter(isAmpThreadSummary)) this.threads.set(threadPath(row.id), row);
  }

  filterDiscoveredFiles(filePaths: string[], scope: HistoryImportScope): string[] {
    const resumeIds = new Set(scope.providerConversationIds);
    const excludedIds = new Set(scope.excludedProviderConversationIds);
    const roots = scope.projectPaths.map(normalizePath).filter((value): value is string => Boolean(value));
    return filePaths.filter((filePath) => {
      const thread = this.threads.get(filePath);
      if (!thread) return false;
      if (excludedIds.has(thread.id)) return false;
      if (resumeIds.has(thread.id)) return true;
      const treePath = localPath(thread.tree);
      return treePath !== null && roots.some((root) => treePath === root || treePath.startsWith(`${root}${path.sep}`));
    });
  }

  fingerprintFile(filePath: string): HistoryFileFingerprint {
    const thread = this.threads.get(filePath);
    if (!thread) throw new Error(`Amp history thread was not discovered: ${threadId(filePath)}`);
    const metadata = { schema: this.parserVersion, id: thread.id, updated: thread.updated ?? null, messageCount: thread.messageCount ?? null, tree: thread.tree ?? null };
    const digest = digestJson(metadata);
    return { sizeBytes: thread.messageCount ?? null, mtimeMs: isoMillis(thread.updated), contentHash: digest, metadata, digest };
  }

  parseFile(filePath: string): ParsedHistoryFile {
    const id = threadId(filePath);
    const executable = this.executablePath ?? resolveAmpExecutable(process.env.HOME ?? '', this.env);
    if (!executable) throw new Error('Amp history import requires an Amp executable');
    const payload = parseJson(this.runCommand(executable, ['threads', 'export', id]), `thread ${id}`);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(`Amp history thread ${id} did not return an object`);
    return parseAmpThread(payload as Record<string, unknown>, filePath, this.parserVersion);
  }

  async parseFileAsync(filePath: string): Promise<ParsedHistoryFile> {
    const id = threadId(filePath);
    const executable = this.executablePath ?? resolveAmpExecutable(process.env.HOME ?? '', this.env);
    if (!executable) throw new Error('Amp history import requires an Amp executable');
    const payload = parseJson(await this.runCommandAsync(executable, ['threads', 'export', id]), `thread ${id}`);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(`Amp history thread ${id} did not return an object`);
    return parseAmpThread(payload as Record<string, unknown>, filePath, this.parserVersion);
  }
}

function parseAmpThread(thread: Record<string, unknown>, sourcePath: string, parserVersion: string): ParsedHistoryFile {
  const warnings: string[] = [];
  const id = stringValue(thread.id) ?? threadId(sourcePath);
  const messages: ParsedMessage[] = [];
  const toolNames = new Map<string, string>();
  let seq = 0;
  const rawMessages = Array.isArray(thread.messages) ? thread.messages : [];

  for (const rawMessage of rawMessages) {
    if (!rawMessage || typeof rawMessage !== 'object' || Array.isArray(rawMessage)) {
      warnings.push('skipped non-object Amp message');
      continue;
    }
    const message = rawMessage as Record<string, unknown>;
    const role = ampRole(message.role);
    const createdAt = isoFromString(message.createdAt) ?? isoFromMillis(message.createdAt);
    const messageId = scalarId(message.protocolMessageID) ?? scalarId(message.messageId) ?? `${id}:${seq}`;
    const turnId = scalarId(message.protocolMessageID);
    const content = Array.isArray(message.content) ? message.content : [];
    for (let index = 0; index < content.length; index += 1) {
      const rawBlock = content[index];
      if (!rawBlock || typeof rawBlock !== 'object' || Array.isArray(rawBlock)) continue;
      const block = rawBlock as Record<string, unknown>;
      const type = stringValue(block.type);
      const providerMessageId = content.length > 1 ? `${messageId}:${index}` : messageId;
      if (type === 'thinking') continue;
      if (type === 'text') {
        const text = textFromUnknown(block.text);
        if (!text.trim()) continue;
        messages.push(parsedMessage({ providerMessageId, turnId, seq: seq++, role, kind: 'message', text, providerCreatedAt: createdAt, metadata: { type, source: 'amp-export' } }));
        continue;
      }
      if (type === 'tool_use') {
        const toolUseId = scalarId(block.id) ?? scalarId(block.providerToolUseId);
        const toolName = stringValue(block.name);
        if (toolUseId && toolName) toolNames.set(toolUseId, toolName);
        messages.push(parsedMessage({ providerMessageId, turnId, seq: seq++, role: 'tool', kind: 'tool_call', text: '', toolName, toolStatus: block.complete === true ? 'completed' : 'pending', toolInputSummary: textFromUnknown(block.input) || null, providerCreatedAt: createdAt, metadata: { type, source: 'amp-export', toolUseId } }));
        continue;
      }
      if (type === 'tool_result') {
        const toolUseId = scalarId(block.toolUseID);
        const run = objectValue(block.run);
        const result = run?.result ?? run?.error;
        const output = toolResultText(result);
        const status = stringValue(run?.status) ?? 'completed';
        if (!output && status !== 'error' && status !== 'failed') continue;
        messages.push(parsedMessage({ providerMessageId, turnId, seq: seq++, role: 'tool', kind: 'tool_result', text: '', toolName: toolUseId ? toolNames.get(toolUseId) ?? null : null, toolStatus: status, toolOutputSummary: output || null, providerCreatedAt: createdAt, metadata: { type, source: 'amp-export', toolUseId } }));
        continue;
      }
      warnings.push('skipped unsupported Amp content type');
    }
  }

  const env = objectValue(thread.env);
  const initial = objectValue(env?.initial);
  const meta = objectValue(thread.meta);
  const createdAt = isoFromMillis(thread.created) ?? isoFromString(thread.created);
  const updatedAt = isoFromString(thread.updatedAt) ?? createdAt;
  const state = stringValue(objectValue(meta?.lastKnownAgentState)?.state);
  const cwd = stringValue(initial?.workingDirectory) ?? firstTreePath(initial?.trees);
  const conversation: ParsedConversation = {
    provider: 'amp',
    providerConversationId: id,
    title: stringValue(thread.title),
    cwd,
    providerVersion: typeof thread.v === 'number' ? String(thread.v) : null,
    startedAt: createdAt,
    updatedAt,
    endedAt: state === 'working' || state === 'thinking' ? null : updatedAt,
    status: state === 'working' || state === 'thinking' ? 'active' : 'imported',
    sourcePath,
    metadata: { source: 'amp-export', executorType: stringValue(meta?.executorType), visibility: stringValue(meta?.visibility) },
    messages,
    skills: skillUsesFromMessages(messages)
  };
  if (messages.length === 0) warnings.push('no supported Amp conversation messages found');
  return { provider: 'amp', sourcePath, sourceKind: 'amp-export', parserVersion, warnings, conversations: messages.length ? [conversation] : [] };
}

function parsedMessage(input: Partial<ParsedMessage> & Pick<ParsedMessage, 'providerMessageId' | 'turnId' | 'seq' | 'role' | 'kind' | 'text' | 'providerCreatedAt' | 'metadata'>): ParsedMessage {
  return {
    parentProviderMessageId: null,
    toolName: null,
    toolStatus: null,
    toolInputSummary: null,
    toolOutputSummary: null,
    tokenCount: null,
    ...input
  };
}

function toolResultText(value: unknown): string {
  if (typeof value === 'string') return value;
  const result = objectValue(value);
  if (!result) return textFromUnknown(value);
  return textFromUnknown(result.output ?? result.content ?? result);
}

function runAmpCommand(executable: string, args: string[]): string {
  try {
    return execFileSync(executable, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 128 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) { throw ampCommandError(error); }
}

async function runAmpCommandAsync(executable: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync(executable, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 128 * 1024 * 1024, windowsHide: true });
    return result.stdout;
  } catch (error) { throw ampCommandError(error); }
}

function ampCommandError(error: unknown): Error {
  const failure = error as Error & { stderr?: string | Buffer; signal?: string; code?: string | number };
  const stderr = typeof failure.stderr === 'string' ? failure.stderr : Buffer.isBuffer(failure.stderr) ? failure.stderr.toString('utf8') : '';
  if (failure.code === 'ETIMEDOUT' || failure.signal === 'SIGTERM') return new Error('Amp history command timed out');
  if (failure.code === 'ENOBUFS' || failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return new Error('Amp history export exceeded the size limit');
  if (/unauthorized|unauthenticated|not logged in|sign in|login required|401/i.test(stderr)) return new Error('Amp history authentication failed; sign in with the native Amp CLI');
  if (/network|connection|dns|offline|fetch failed|ENOTFOUND|ECONN/i.test(stderr)) return new Error('Amp history could not reach the Amp service');
  return new Error(`Amp history command failed${typeof failure.code === 'number' ? ` (exit ${failure.code})` : ''}`);
}

function resolveAmpExecutable(homeDir: string, env: NodeJS.ProcessEnv): string | null {
  const candidates: string[] = [];
  const rawPath = env.PATH ?? env.Path ?? '';
  for (const directory of rawPath.split(path.delimiter).filter(Boolean)) candidates.push(path.join(directory, process.platform === 'win32' ? 'amp.exe' : 'amp'));
  candidates.push(path.join(homeDir, '.local', 'bin', 'amp'), path.join(homeDir, '.amp', 'bin', 'amp'));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue through the native executable candidates.
    }
  }
  return null;
}

function parseJson(value: string, description: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Amp history ${description} returned invalid JSON`);
  }
}

function isAmpThreadSummary(value: unknown): value is AmpThreadSummary {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && /^T-[A-Za-z0-9-]+$/.test(String((value as Record<string, unknown>).id ?? '')));
}

function threadPath(id: string): string {
  return `${AMP_THREAD_PREFIX}${id}`;
}

function threadId(filePath: string): string {
  if (!filePath.startsWith(AMP_THREAD_PREFIX)) throw new Error(`Invalid Amp history thread path: ${filePath}`);
  const id = filePath.slice(AMP_THREAD_PREFIX.length);
  if (!/^T-[A-Za-z0-9-]+$/.test(id)) throw new Error('Invalid Amp history thread ID');
  return id;
}

function isoMillis(value: unknown): number | null {
  const iso = isoFromString(value);
  return iso ? Date.parse(iso) : null;
}

function localPath(value: unknown): string | null {
  const uri = stringValue(value);
  if (!uri) return null;
  try {
    if (uri.startsWith('file:')) return normalizePath(fileURLToPath(uri));
    return path.isAbsolute(uri) ? normalizePath(uri) : null;
  } catch {
    return null;
  }
}

function normalizePath(value: string): string {
  return path.resolve(value);
}

function firstTreePath(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    const uri = objectValue(item)?.uri;
    const resolved = localPath(uri);
    if (resolved) return resolved;
  }
  return null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function scalarId(value: unknown): string | null {
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function ampRole(value: unknown): ParsedMessage['role'] {
  return value === 'user' ? 'user' : value === 'assistant' ? 'assistant' : 'unknown';
}
