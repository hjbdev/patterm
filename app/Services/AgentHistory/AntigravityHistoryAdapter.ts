import fs from 'node:fs';
import path from 'node:path';
import type { HistorySourceCandidate, ParsedHistoryFile, ParsedMessage, ParsedUsage, ProviderHistoryAdapter } from './AgentHistoryTypes';
import { isoFromString, nonNegative, readJsonl, statOnlyFingerprint, stringValue, walkFiles } from './HistoryAdapterUtils';

// Native step logs, not Patterm recordings. Only user requests and model
// responses are conversation text; generated settings/system metadata stays out.
export class AntigravityHistoryAdapter implements ProviderHistoryAdapter {
  readonly provider = 'agy' as const;
  readonly parserVersion = 'agy-jsonl-v1';

  defaultSources(home: string): HistorySourceCandidate[] {
    const source = path.join(home, '.gemini', 'antigravity-cli', 'brain');
    return [{ provider: this.provider, sourceKind: 'default', path: source, exists: fs.existsSync(source) }];
  }
  discoverFiles(source: string): string[] { return walkFiles(source, (file) => path.basename(file) === 'transcript.jsonl'); }
  quickFingerprintFile(file: string) { return statOnlyFingerprint([file]); }

  parseFile(file: string): ParsedHistoryFile {
    const parsed = readJsonl(file);
    const messages: ParsedMessage[] = [];
    const usage: ParsedUsage[] = [];
    const id = path.basename(path.resolve(file, '../../..'));
    let startedAt: string | null = null;
    let updatedAt: string | null = null;
    let title: string | null = null;
    let turnId: string | null = null;
    let lastTool: string | null = null;
    const seen = new Set<number>();
    const add = (row: Record<string, unknown>, suffix: string, message: Partial<ParsedMessage>) => {
      messages.push({ providerMessageId: `${id}:${row.step_index}:${suffix}`, parentProviderMessageId: null, turnId, seq: messages.length, role: 'unknown', kind: 'event', text: '', toolName: null, toolStatus: null, toolInputSummary: null, toolOutputSummary: null, providerCreatedAt: isoFromString(row.created_at), tokenCount: null, metadata: { source: 'agy-jsonl', type: row.type }, ...message });
    };
    for (const value of parsed.records) {
      if (!value || typeof value !== 'object') continue;
      const row = value as Record<string, unknown>;
      if (typeof row.step_index !== 'number' || seen.has(row.step_index)) continue;
      seen.add(row.step_index);
      const time = isoFromString(row.created_at); startedAt ??= time; updatedAt = time ?? updatedAt;
      const content = stringValue(row.content) ?? '';
      if (row.type === 'USER_INPUT' && row.source === 'USER_EXPLICIT') {
        // Native logs wrap the request, local clock and model changes together.
        // If the wrapper is absent do not guess which part is user content.
        const match = /^<USER_REQUEST>\n([\s\S]*?)\n<\/USER_REQUEST>(?:\n|$)/.exec(content);
        if (!match) continue;
        const text = match[1]!;
        turnId = `${id}:${row.step_index}`; lastTool = null;
        title ??= text.split('\n')[0]!.slice(0, 160);
        add(row, 'user', { role: 'user', kind: 'message', text });
      } else if (row.type === 'PLANNER_RESPONSE' && row.source === 'MODEL') {
        if (content) add(row, 'text', { role: 'assistant', kind: 'message', text: content });
        if (Array.isArray(row.tool_calls)) for (const [index, value] of row.tool_calls.entries()) {
          if (!value || typeof value !== 'object') continue;
          const tool = value as Record<string, unknown>;
          lastTool = stringValue(tool.name);
          const args = tool.args && typeof tool.args === 'object' ? Object.fromEntries(Object.entries(tool.args).map(([key, value]) => {
            if (typeof value !== 'string') return [key, value];
            try { return [key, JSON.parse(value) as unknown]; } catch { return [key, value]; }
          })) : {};
          add(row, `tool:${index}`, { role: 'assistant', kind: 'tool_call', toolName: lastTool, toolInputSummary: JSON.stringify(args), toolStatus: String(row.status ?? '') });
        }
        if (nonNegative(row.input_tokens) + nonNegative(row.output_tokens) + nonNegative(row.cache_read_tokens)) usage.push({ model: null, occurredAt: time, inputTokens: nonNegative(row.input_tokens), cacheReadTokens: nonNegative(row.cache_read_tokens), cacheWriteTokens: 0, cacheWrite1hTokens: 0, outputTokens: nonNegative(row.output_tokens), reasoningTokens: 0, costUsd: null, subagent: false });
      } else if (row.type === 'GENERIC' && row.source === 'MODEL' && lastTool && content) {
        add(row, 'result', { role: 'tool', kind: 'tool_result', toolName: lastTool, text: content, toolOutputSummary: content, toolStatus: String(row.status ?? '') });
        lastTool = null;
      } else if (row.type === 'ERROR_MESSAGE') {
        add(row, 'error', { role: 'system', kind: 'event', text: content });
      }
    }
    return { provider: this.provider, sourcePath: file, sourceKind: 'jsonl', parserVersion: this.parserVersion, warnings: [...parsed.warnings, ...(parsed.partialTrailingLine ? ['partial trailing JSONL line; will retry'] : [])], conversations: messages.length ? [{ provider: this.provider, providerConversationId: id, title, cwd: null, providerVersion: null, startedAt, updatedAt, endedAt: updatedAt, status: parsed.partialTrailingLine ? 'active' : 'imported', sourcePath: file, metadata: { source: 'agy-jsonl' }, messages, usage }] : [] };
  }
}
