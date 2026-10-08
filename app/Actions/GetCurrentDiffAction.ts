import { z } from 'zod';
import { diffCurrentInput, type DiffService } from '../Services/DiffService';
import type { ProjectContextService } from '../Services/ProjectContextService';

// Agents may omit worktree_id: it defaults to their session's own worktree,
// else the first worktree linked to it. Owner requests must name one.
export const getCurrentDiffInput = diffCurrentInput.extend({ worktree_id: z.string().min(1).optional() });
export type GetCurrentDiffInput = z.input<typeof getCurrentDiffInput>;

type SessionWorktrees = Pick<ProjectContextService, 'defaultWorktreeId'>;

export class GetCurrentDiffAction {
  constructor(private readonly diffs: DiffService, private readonly sessions: SessionWorktrees) {}

  async execute(raw: GetCurrentDiffInput, callerSessionId: string | null = null) {
    const input = getCurrentDiffInput.parse(raw);
    return this.diffs.current({ scope: input.scope, worktree_id: input.worktree_id ?? defaultDiffWorktree(this.sessions, callerSessionId) });
  }
}

export function defaultDiffWorktree(sessions: SessionWorktrees, callerSessionId: string | null): string {
  if (!callerSessionId) throw new Error('worktree_id is required for owner requests');
  return sessions.defaultWorktreeId(callerSessionId);
}
