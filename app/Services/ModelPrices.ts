// Pay-as-you-go API prices in USD per million tokens, so subscription usage
// can be shown as what it would have cost. Claude prices are Anthropic's
// first-party rates; OpenAI prices come from LiteLLM's direct OpenAI entries
// (model_prices_and_context_window.json), both read on 2026-10-05.
// Long-context and priority-tier surcharges are not modelled.
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  // Five-minute cache writes; one-hour writes cost cacheWrite1h.
  cacheWrite: number;
  cacheWrite1h: number;
}

const claude = (input: number, output: number, cacheRead: number): ModelPrice => ({ input, output, cacheRead, cacheWrite: input * 1.25, cacheWrite1h: input * 2 });
// Where no cache-write price is listed, writes cost the input price.
const openai = (input: number, output: number, cacheRead: number, cacheWrite = input): ModelPrice => ({ input, output, cacheRead, cacheWrite, cacheWrite1h: cacheWrite });

const PRICES: Record<string, ModelPrice> = {
  'claude-fable-5-1': claude(10, 50, 0.25),
  'claude-fable-5': claude(10, 50, 1),
  'claude-opus-5-5': claude(4, 20, 0.2),
  'claude-opus-5': claude(5, 25, 0.5),
  'claude-opus-4-8': claude(5, 25, 0.5),
  'claude-opus-4-7': claude(5, 25, 0.5),
  'claude-opus-4-6': claude(5, 25, 0.5),
  'claude-sonnet-5-5': claude(2, 10, 0.2),
  'claude-sonnet-5': claude(2, 10, 0.2),
  'claude-sonnet-4-6': claude(3, 15, 0.3),
  'claude-haiku-4-5': claude(1, 5, 0.1),
  'gpt-6.1-sol': openai(2, 10, 0.1, 2.5),
  'gpt-6-astra': openai(10, 50, 1, 12.5),
  'gpt-6-sol': openai(2, 10, 0.2, 2.5),
  'gpt-6-luna': openai(0.1, 0.5, 0.01, 0.125),
  'gpt-5.6-sol': openai(4, 20, 0.4, 5),
  'gpt-5.6-terra': openai(2, 12, 0.2, 2.5),
  'gpt-5.6-luna': openai(0.2, 1.2, 0.02, 0.25),
  'gpt-5.5': openai(5, 30, 0.5),
  'gpt-5.4': openai(2.5, 15, 0.25),
  'gpt-5.3-codex': openai(1.75, 14, 0.175),
  'gpt-5.2-codex': openai(1.75, 14, 0.175),
  'gpt-5.1-codex': openai(1.25, 10, 0.125),
  'gpt-5-codex': openai(1.25, 10, 0.125),
  'gpt-5': openai(1.25, 10, 0.125)
};

// Dated snapshots, such as claude-haiku-4-5-20251001, share their alias's price.
export function modelPrice(model: string | null): ModelPrice | null {
  if (!model) return null;
  return PRICES[model] ?? PRICES[model.replace(/-\d{8}$/, '')] ?? null;
}

export interface PricedTokens {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
  outputTokens: number;
}

export function apiCost(price: ModelPrice, tokens: PricedTokens): number {
  const fiveMinuteWrites = Math.max(0, tokens.cacheWriteTokens - tokens.cacheWrite1hTokens);
  return (tokens.inputTokens * price.input
    + tokens.outputTokens * price.output
    + tokens.cacheReadTokens * price.cacheRead
    + fiveMinuteWrites * price.cacheWrite
    + tokens.cacheWrite1hTokens * price.cacheWrite1h) / 1_000_000;
}
