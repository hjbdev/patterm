// Follow's decisions, kept apart from the router and DOM so they can be tested.

import type { AssistantFocus } from './assistantFocus';

export interface FollowState {
  // The latest turn when this client loaded, which is not followed again.
  // Undefined until the transcript arrives.
  baselineTurnId: string | null | undefined;
  // The turn and target last shown, so each is shown at most once.
  applied: string;
  // Set when the user navigates elsewhere: the turn then in progress and what
  // the assistant was discussing.
  paused: { turnId: string | null; targetKey: string | null } | null;
}

export function initialFollowState(): FollowState {
  return { baselineTurnId: undefined, applied: '', paused: null };
}

export function focusKey(focus: AssistantFocus): string {
  return `${focus.turnId}|${focus.target.key}`;
}

export interface FollowContext {
  enabled: boolean;
  // The workspace is in view beside the assistant.
  visible: boolean;
  // The workspace already shows the focus.
  shown: boolean;
  // The user is typing in the workspace or a dialog is open.
  busy: boolean;
}

// Whether to show a settled focus now. A pause holds until the user raises a
// new topic: a later turn they started, about something else. Background
// turns never end a pause.
export function decideFollow(state: FollowState, focus: AssistantFocus | null, context: FollowContext): { show: boolean; state: FollowState } {
  // Until the transcript has loaded, any turn may be an old one.
  if (state.baselineTurnId === undefined) return { show: false, state };
  if (!focus || !context.enabled || !context.visible || focus.turnId === state.baselineTurnId) return { show: false, state };
  const key = focusKey(focus);
  if (key === state.applied) return { show: false, state };
  const { paused } = state;
  if (paused && (focus.background || focus.turnId === paused.turnId || focus.target.key === paused.targetKey)) return { show: false, state };
  const resumed = { ...state, paused: null };
  if (context.shown) return { show: false, state: { ...resumed, applied: key } };
  // The chip offers it instead.
  if (context.busy) return { show: false, state: resumed };
  return { show: true, state: { ...resumed, applied: key } };
}

// A route change Follow did not make. Only one the user caused counts: the
// app also redirects by itself, such as from a project to its first agent.
export function routeChanged(state: FollowState, change: { enabled: boolean; manual: boolean; showsFocus: boolean; latestTurnId: string | null; focus: AssistantFocus | null }): FollowState {
  if (!change.enabled || !change.manual) return state;
  if (change.showsFocus) return { ...state, paused: null };
  return { ...state, paused: { turnId: change.latestTurnId, targetKey: change.focus?.target.key ?? null } };
}

// Shown on request, from the chip or by turning Follow on.
export function showRequested(state: FollowState, focus: AssistantFocus): FollowState {
  return { ...state, paused: null, applied: focusKey(focus) };
}
