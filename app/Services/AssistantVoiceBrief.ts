import type { IntegratedConversationMessage } from './IntegratedConversation';

// Each voice call starts a new realtime model that remembers nothing, while
// the assistant's thread keeps the whole conversation. A short brief from that
// thread lets the voice pick up where the last call left off. It only repeats
// what the thread already holds, and stays well under Codex's 8,192-token
// limit for initial items.
const MESSAGE_LIMIT = 16;
const LINE_CHARS = 300;
const AGENT_CHARS = 160;
export const VOICE_BRIEF_AGENT_LIMIT = 12;
const BRIEF_CHARS = 6_000;

// Headings Patterm puts on messages it sends the assistant for someone else,
// as in resources/js/lib/assistantFocus.ts.
const BACKGROUND_MESSAGE = /^\[(?:Patterm |System notification|system\]|message from |report from |agent message from |Attention requested by |Attention needed by |Failure reported by )/;

export interface VoiceBriefAgent {
  name: string;
  project: string | null;
  activity: string | null;
}

export function voiceBrief(messages: readonly IntegratedConversationMessage[], agents: readonly VoiceBriefAgent[]): string | null {
  const lines = messages
    .filter((message) => message.kind === 'text' && !message.parentId)
    .flatMap((message) => {
      const text = message.role === 'user' ? spokenOrTyped(message.text) : message.text;
      const line = squash(text);
      return line ? [`- ${message.role === 'user' ? 'User' : 'Assistant'}: ${clip(line, LINE_CHARS)}`] : [];
    })
    .slice(-MESSAGE_LIMIT);
  const running = agents.slice(0, VOICE_BRIEF_AGENT_LIMIT).map((agent) =>
    clip(squash(`- ${agent.name}${agent.project ? ` (${agent.project})` : ''}${agent.activity ? `: ${agent.activity}` : ''}`), AGENT_CHARS));
  if (!lines.length && !running.length) return null;

  const head = '[Context from earlier, not from the user. This is a new voice call, so you do not remember earlier calls. Use this for continuity, do not read it out, and hand over anything that needs the current state.]';
  const tail = running.length ? `\n\nAgents the assistant started that are still running:\n${running.join('\n')}` : '';
  // The oldest lines go first when the brief is too long. Agent rows are
  // clipped, so they alone always fit.
  while (lines.length && briefText(head, lines, tail).length > BRIEF_CHARS) lines.shift();
  return briefText(head, lines, tail);
}

function briefText(head: string, lines: string[], tail: string): string {
  return `${head}${lines.length ? `\n\nRecent conversation, oldest first:\n${lines.join('\n')}` : ''}${tail}`;
}

// Messages from agents, timers, and notifications are left out, since the
// assistant's reply carries the result. A spoken request keeps its input only
// when the user said it; one the voice model started by itself is left out
// too. This mirrors turnOrigin in resources/js/lib/assistantFocus.ts.
function spokenOrTyped(text: string): string {
  const trimmed = text.trimStart();
  if (BACKGROUND_MESSAGE.test(trimmed)) return '';
  if (!trimmed.startsWith('<realtime_delegation>')) return text;
  const input = squash(/<input>([\s\S]*?)<\/input>/.exec(trimmed)?.[1] ?? '');
  const delta = /<transcript_delta>([\s\S]*?)<\/transcript_delta>/.exec(trimmed)?.[1] ?? '';
  const spoken = delta.split('\n').filter((line) => line.startsWith('user:')).map((line) => squash(line.slice(5)));
  return input && spoken.some((line) => line && (line.includes(input) || input.includes(line))) ? input : '';
}

// One line of plain text; bold markers mean nothing to a voice.
function squash(text: string): string {
  return text.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
