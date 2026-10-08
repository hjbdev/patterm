import { worktreeCreateInput, type WorktreeCreateInput, type WorktreeService } from '../Services/WorktreeService';
import type { ProjectContextAction } from './ProjectContextAction';

export const createWorktreeInput = worktreeCreateInput;
export type CreateWorktreeInput = WorktreeCreateInput;

// The authenticated agent session behind an MCP call.
export interface WorktreeAgentCaller {
  sessionId: string;
  projectId: string;
}

export class CreateWorktreeAction {
  constructor(
    private readonly worktrees: WorktreeService,
    private readonly projectContext: Pick<ProjectContextAction, 'linkAgentWorktree'>
  ) {}

  // Agents are recorded as the creator, and the new worktree is linked to
  // their session. Owner and UI calls keep their own actor fields.
  async execute(input: WorktreeCreateInput, caller: WorktreeAgentCaller | null = null) {
    if (!caller) return this.worktrees.create(input);
    const result = await this.worktrees.create({ ...input, actor_type: 'agent', actor_id: caller.sessionId });
    return { ...result, ...this.projectContext.linkAgentWorktree(caller, result.worktree.id) };
  }
}
