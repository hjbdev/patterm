import type { SessionWorktree } from './projectContext';

// Requests from the command palette to the view that shows an agent. That view
// owns the state, such as Integrated controls and the diff viewer.
export type WorkspaceRequest =
  | { kind: 'integrated'; processId: string; action: 'interrupt' | 'new' }
  | { kind: 'integrated'; processId: string; action: 'configure'; selector: string; value: string }
  | { kind: 'session-context'; sessionId: string }
  | { kind: 'review-changes'; sessionId: string; worktree: SessionWorktree };

const WORKSPACE_REQUEST_EVENT = 'patterm:workspace-request';

// Returns false when no open view handled the request.
export function sendWorkspaceRequest(request: WorkspaceRequest): boolean {
  return !window.dispatchEvent(new CustomEvent(WORKSPACE_REQUEST_EVENT, { detail: request, cancelable: true }));
}

// The handler returns true when it handled the request.
export function onWorkspaceRequest(handler: (request: WorkspaceRequest) => boolean): () => void {
  const listener = (event: Event) => {
    if (handler((event as CustomEvent<WorkspaceRequest>).detail)) event.preventDefault();
  };
  window.addEventListener(WORKSPACE_REQUEST_EVENT, listener);
  return () => window.removeEventListener(WORKSPACE_REQUEST_EVENT, listener);
}
