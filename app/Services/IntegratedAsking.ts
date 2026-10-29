import { normaliseConversation, type IntegratedPermission } from './TranscriptProjection';

// Long enough for a question, short enough for one list row.
export const ASKING_MAX_LENGTH = 120;

// What an Integrated agent waiting on you asks, in one line for its list row:
// the first pending approval, else question, else form, in the order its
// activity reports them. Null while nothing is pending.
export function pendingAsk(conversation: unknown): string | null {
  const state = conversation && typeof conversation === 'object' ? conversation as Record<string, unknown> : {};
  // Only the requests: the transcript is not needed.
  const { permissions, questions, forms } = normaliseConversation({ permissions: state.permissions, questions: state.questions, forms: state.forms });
  const ask = (permissions[0] && permissionAsk(permissions[0])) || questions[0]?.questions[0]?.question || forms[0]?.title;
  return ask ? oneLine(ask) : null;
}

// A permission as the question it asks. Claude names the tool and its target
// ("Edit", "CHANGELOG.md") and OpenCode the tool and its resources; Codex and
// plan approvals already ask ("Apply these file changes?"). A command reads
// best as itself. A phone's docked card heads with it too.
export function permissionAsk(permission: IntegratedPermission): string {
  const subagent = permission.action.startsWith('Subagent: ');
  const action = subagent ? permission.action.slice('Subagent: '.length) : permission.action;
  const command = permission.command && firstLine(permission.command);
  const target = (permission.detail && firstLine(permission.detail)) || permission.resources[0];
  const ask = command ? `Run ${command}?` : action.endsWith('?') ? action : `Allow ${[action, target].filter(Boolean).join(' ')}?`;
  return subagent ? `Subagent: ${ask}` : ask;
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]!.trim();
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > ASKING_MAX_LENGTH ? `${line.slice(0, ASKING_MAX_LENGTH - 1).trimEnd()}…` : line;
}
