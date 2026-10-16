// A live agent's activity. `permission` waits on an approval; `question` waits
// on an answer, such as AskUserQuestion or an MCP form. Both block the turn on
// the user.
export const ACTIVITY_STATES = ['working', 'thinking', 'idle', 'permission', 'question', 'error', 'unknown'] as const;
export type ActivityState = typeof ACTIVITY_STATES[number];

export function isActivityState(value: unknown): value is ActivityState {
  return typeof value === 'string' && (ACTIVITY_STATES as readonly string[]).includes(value);
}

// Whether the agent is blocked on the user, by an approval or a question.
export function awaitingUser(activity: unknown): activity is 'permission' | 'question' {
  return activity === 'permission' || activity === 'question';
}

// The state for prompts waiting on the user: any approval makes it
// `permission`, since approving is the more specific ask; otherwise `question`.
export function awaitingActivity(approvals: number): 'permission' | 'question' {
  return approvals ? 'permission' : 'question';
}
