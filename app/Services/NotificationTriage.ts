import type { IntegratedConversationEvent, IntegratedConversationMessage, IntegratedConversationTool } from './IntegratedConversation';
import { TRIAGE_WEIGHTS as WEIGHTS } from './NotificationTriageWeights';

// Turns the model scores above this are delivered in the app only. Chosen on
// held-out data to silence about two thirds of routine turns while losing
// roughly one wanted ping in seventy.
export const QUIET_THRESHOLD = 0.75;
const MESSAGE_LIMIT = 3000;
const TOOL_LIMIT = 3;
const TURN_LIMIT = 200;

export type TurnStarter = 'user' | 'agent' | 'timer' | 'system' | 'unknown';

// What the model sees of one Integrated turn.
export interface TurnDigest {
  startedBy: TurnStarter;
  finalMessage: string;
  // The last few tool names, oldest first.
  tools: string[];
  toolCount: number;
}

interface TurnState extends TurnDigest {
  startId: string | null;
  toolIds: Set<string>;
  // The stream dropped mid-turn, so rows may be missing until the next turn.
  lost: boolean;
}

// Who sent the user row that started a turn. Agent messages, timers and
// harness output arrive as user rows with these prefixes.
export function turnStarter(text: string): TurnStarter {
  const t = text.trimStart();
  if (/^\[(agent )?(message|report) from process_/.test(t)) return 'agent';
  if (/^\[Patterm timer /.test(t)) return 'timer';
  if (/^\[Patterm (routine |notifications\])|^<(task-notification|local-command-stdout|command-name>\/compact)/.test(t)) return 'system';
  return 'user';
}

// Keeps the current turn of each Integrated agent from its conversation
// stream: who started it, the last assistant message, and its tool calls.
// Rows from subagents (with a parent row) belong to that subagent, not the turn.
// After a lost connection the provider recovers from a snapshot without
// replaying rows, so that turn has no digest and is announced as before.
export class TurnDigests {
  private readonly turns = new Map<string, TurnState>();

  observe(processId: string, event: IntegratedConversationEvent): void {
    if (event.kind === 'reconnecting' || (event.kind === 'error' && event.id === 'connection_error')) {
      this.current(processId).lost = true;
      return;
    }
    const message = event.message;
    if ((event.kind !== 'append' && event.kind !== 'replace') || !message || message.parentId) return;
    if (message.role === 'user' && message.kind === 'text') this.start(processId, message);
    else if (message.role === 'assistant' && message.kind === 'text' && message.text.trim()) this.say(processId, message);
    else if (message.role === 'assistant' && message.kind === 'tool' && message.tool?.name) this.tool(processId, message);
  }

  get(processId: string): TurnDigest | null {
    const turn = this.turns.get(processId);
    return turn?.finalMessage && !turn.lost ? { startedBy: turn.startedBy, finalMessage: turn.finalMessage, tools: turn.tools, toolCount: turn.toolCount } : null;
  }

  private start(processId: string, message: IntegratedConversationMessage): void {
    if (this.turns.get(processId)?.startId === message.id) return;
    this.turns.delete(processId);
    // Oldest first, so agents that have gone quiet fall out.
    if (this.turns.size >= TURN_LIMIT) this.turns.delete(this.turns.keys().next().value!);
    this.turns.set(processId, { startedBy: turnStarter(message.text), finalMessage: '', tools: [], toolCount: 0, startId: message.id, toolIds: new Set(), lost: false });
  }

  private current(processId: string): TurnState {
    let turn = this.turns.get(processId);
    if (!turn) {
      // A turn already running when Patterm started; its starter is unknown.
      turn = { startedBy: 'unknown', finalMessage: '', tools: [], toolCount: 0, startId: null, toolIds: new Set(), lost: false };
      this.turns.set(processId, turn);
    }
    return turn;
  }

  private say(processId: string, message: IntegratedConversationMessage): void {
    const turn = this.current(processId);
    turn.finalMessage = message.text.slice(0, MESSAGE_LIMIT);
  }

  private tool(processId: string, message: IntegratedConversationMessage): void {
    const turn = this.current(processId);
    if (turn.toolIds.has(message.id)) return;
    turn.toolIds.add(message.id);
    turn.toolCount++;
    turn.tools = [...turn.tools, toolIdentity(message.tool!)].slice(-TOOL_LIMIT);
  }
}

// Codex projects MCP, dynamic and shell calls under generic names. The model
// learned native names (`mcp__<server>__<tool>`, `exec`), so map back to them.
function toolIdentity(tool: IntegratedConversationTool): string {
  const input = (tool.input ?? {}) as Record<string, unknown>;
  const name = typeof input.tool === 'string' ? input.tool : '';
  const server = typeof input.server === 'string' ? input.server : typeof input.namespace === 'string' ? input.namespace : '';
  if ((tool.name === 'mcpToolCall' || tool.name === 'dynamicToolCall') && name) return server ? `mcp__${server}__${name}` : name;
  if (tool.name === 'commandExecution') return 'exec';
  return tool.name;
}

// Probability that a finished turn is routine and can stay quiet. Mirrors the
// scikit-learn pipeline it was trained with: sublinear TF-IDF over lowercase
// words and word pairs, L2-normalised; plain TF-IDF over tool names.
export function quietProbability(turn: TurnDigest, waiting: boolean): number {
  let z = WEIGHTS.intercept;
  z += tfidf(messageTerms(turn.finalMessage), WORD_INDEX, WEIGHTS.wordIdf, WEIGHTS.wordCoef, true);
  const tools = turn.tools.map((name) => name.replace('mcp__patterm__', 'patterm_').toLowerCase());
  z += tfidf(tools, TOOL_INDEX, WEIGHTS.toolIdf, WEIGHTS.toolCoef, false);
  const meta: Record<string, boolean | number> = {
    [`started_by=${turn.startedBy}`]: true,
    patterm_wait: waiting,
    no_tools: turn.toolCount === 0,
    ends_with_question: turn.finalMessage.trimEnd().endsWith('?'),
    length: Math.min(turn.finalMessage.length, MESSAGE_LIMIT) / MESSAGE_LIMIT
  };
  for (const [name, value] of Object.entries(meta)) z += Number(value) * (WEIGHTS.meta[name] ?? 0);
  return 1 / (1 + Math.exp(-z));
}

// scikit-learn's default analyzer: lowercase tokens matching (?u)\b\w\w+\b,
// then word pairs. Python's \w is letters, numbers and underscore; combining
// marks split a token, as they do there.
export function messageTerms(text: string): string[] {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [];
  const terms = tokens.slice();
  for (let i = 0; i + 1 < tokens.length; i++) terms.push(`${tokens[i]} ${tokens[i + 1]}`);
  return terms;
}

function tfidf(terms: string[], index: Map<string, number>, idf: number[], coef: number[], sublinear: boolean): number {
  const counts = new Map<number, number>();
  for (const term of terms) {
    const j = index.get(term);
    if (j !== undefined) counts.set(j, (counts.get(j) ?? 0) + 1);
  }
  let norm = 0;
  let dot = 0;
  for (const [j, count] of counts) {
    const value = (sublinear ? 1 + Math.log(count) : count) * idf[j]!;
    norm += value * value;
    dot += value * coef[j]!;
  }
  return norm ? dot / Math.sqrt(norm) : 0;
}

const WORD_INDEX = new Map(WEIGHTS.words.map((term, j) => [term, j]));
const TOOL_INDEX = new Map(WEIGHTS.tools.map((term, j) => [term, j]));

export type TriageDecision =
  | { quiet: false; reason: 'disabled' | 'no_transcript' }
  | { quiet: boolean; reason: 'model'; probability: number; waiting: boolean };

// Decides whether a finished Integrated turn is worth a toast and a push. The
// model decides, weighing a pending wait on other agents against what the
// final message says. Without a transcript the turn is announced as before.
export class NotificationTriage {
  constructor(
    private readonly turns: Pick<TurnDigests, 'get'>,
    // Whether the agent owns a pending timer waiting on other agents.
    private readonly waiting: (processId: string) => boolean,
    private readonly enabled: () => boolean
  ) {}

  decide(processId: string): TriageDecision {
    if (!this.enabled()) return { quiet: false, reason: 'disabled' };
    const turn = this.turns.get(processId);
    if (!turn) return { quiet: false, reason: 'no_transcript' };
    const waiting = this.waiting(processId);
    const probability = quietProbability(turn, waiting);
    return { quiet: probability >= QUIET_THRESHOLD, reason: 'model', probability, waiting };
  }
}
