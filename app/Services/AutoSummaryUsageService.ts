import type { DatabaseService } from './DatabaseService';
import type { AutoSummarySettings } from './AutoSummarySettings';

// Summary invocations have no saved conversation. Keep only their accounting
// metadata, including calls whose final summary fails validation.
export class AutoSummaryUsageService {
  constructor(private readonly database: DatabaseService) {}

  record(provider: AutoSummarySettings['provider'], model: string, output: string, projectId: string | null = null): void {
    let envelopes: Record<string, unknown>[];
    try {
      envelopes = (provider === 'codex' ? output.trim().split('\n') : [output]).map(line => object(JSON.parse(line)));
    } catch { return; }
    const insert = this.database.connection.prepare(`insert into auto_summary_usage
      (project_id, provider, model, occurred_at, input_tokens, cache_read_tokens, cache_write_tokens,
       cache_write_1h_tokens, output_tokens, reasoning_tokens, cost_usd) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const stamp = new Date().toISOString();
    const save = (name: string, input: unknown, read: unknown, write: unknown, hour: unknown, out: unknown, reasoning: unknown, cost: unknown) => {
      const tokens = [input, read, write, hour, out, reasoning].map(count);
      if (!tokens.some(value => value > 0)) return;
      insert.run(projectId, provider, name, stamp, ...tokens, typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null);
    };
    for (const envelope of envelopes) {
      const usage = object(envelope.usage);
      if (provider === 'codex') {
        if (envelope.type !== 'turn.completed') continue;
        const read = count(usage.cached_input_tokens), write = count(usage.cache_write_input_tokens);
        save(model, Math.max(0, count(usage.input_tokens) - read - write), read, write, 0,
          usage.output_tokens, usage.reasoning_output_tokens, null);
      } else if (provider === 'claude') {
        const models = Object.entries(object(envelope.modelUsage));
        if (models.length) {
          for (const [name, raw] of models) {
            const row = object(raw);
            save(name, row.inputTokens, row.cacheReadInputTokens, row.cacheCreationInputTokens,
              models.length === 1 ? object(usage.cache_creation).ephemeral_1h_input_tokens : 0,
              row.outputTokens, models.length === 1 ? object(usage.output_tokens_details).thinking_tokens : 0, row.costUSD);
          }
        } else {
          save(model, usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens,
            object(usage.cache_creation).ephemeral_1h_input_tokens, usage.output_tokens,
            object(usage.output_tokens_details).thinking_tokens, envelope.total_cost_usd);
        }
      } else {
        // The stateless endpoint returns AI SDK usage alongside its text.
        const data = object(envelope.data), tokens = object(data.usage);
        const details = object(tokens.inputTokenDetails);
        const read = count(details.cacheReadTokens ?? tokens.cachedInputTokens);
        const write = count(details.cacheWriteTokens);
        save(model.replace(/^openai\//, ''), Math.max(0, count(tokens.inputTokens) - read - write), read, write, 0,
          tokens.outputTokens, object(tokens.outputTokenDetails).reasoningTokens ?? tokens.reasoningTokens, data.cost);
      }
    }
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
