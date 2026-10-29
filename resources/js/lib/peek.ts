import { ref } from 'vue';
import type { RouteLocationRaw } from 'vue-router';
import type { SessionWorktree } from './projectContext';

// An image the peek pane steps through, with the message it came from.
export interface PeekImage { key: string; sha256: string; name?: string; to: RouteLocationRaw }

// What the peek pane beside an agent shows: one thing at a time, so opening
// another replaces it. The agent's browser may open with a page, such as a
// server the agent started, which it names.
export type Peek =
  | { kind: 'context' }
  | { kind: 'browser'; url?: string | undefined; serverProcessId?: string | null | undefined }
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

// The server whose page the peek's browser opened, so its sidebar row can say so.
export const peekedProcessId = ref<string | null>(null);
