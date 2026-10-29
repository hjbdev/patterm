import { ref } from 'vue';
import type { RouteLocationRaw } from 'vue-router';
import type { SessionWorktree } from './projectContext';

// An image the peek pane steps through, with the message it came from.
export interface PeekImage { key: string; sha256: string; name?: string; to: RouteLocationRaw }

// What the peek pane beside an agent shows: one thing at a time, so opening
// another replaces it. A preview of a server the agent started names it.
export type Peek =
  | { kind: 'context' }
  | { kind: 'preview'; url: string; label: string; port?: string | null; processId?: string | null }
  | { kind: 'image'; images: PeekImage[]; index: number }
  | { kind: 'diff'; worktree: SessionWorktree };

// A peek asked for before its agent was showing, such as a server's preview
// opened from the sidebar. That agent's page opens it when it arrives.
let pending: { sessionId: string; peek: Peek } | null = null;
export function queuePeek(sessionId: string, peek: Peek): void {
  pending = { sessionId, peek };
}
export function takePeek(sessionId: string): Peek | null {
  const queued = pending;
  pending = null;
  return queued?.sessionId === sessionId ? queued.peek : null;
}

// The server whose preview the peek shows, so its sidebar row can say so.
export const peekedProcessId = ref<string | null>(null);
