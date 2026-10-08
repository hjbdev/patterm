import { worktreeLinkInput, type WorktreeLinkInput, type WorktreeService } from '../Services/WorktreeService';
import type { WorktreeAgentCaller } from './CreateWorktreeAction';
import type { ProjectContextAction } from './ProjectContextAction';

export const linkWorktreeInput = worktreeLinkInput;
export type LinkWorktreeInput = WorktreeLinkInput;

export class LinkWorktreeAction {
  constructor(
    private readonly worktrees: WorktreeService,
    private readonly projectContext: Pick<ProjectContextAction, 'linkAgentWorktree'>
  ) {}

  // As for creation: agents are recorded as the actor and the worktree is
  // linked to their session, including when it was already registered.
  async execute(input: WorktreeLinkInput, caller: WorktreeAgentCaller | null = null) {
    if (!caller) return this.worktrees.link(input);
    const result = await this.worktrees.link({ ...input, actor_type: 'agent', actor_id: caller.sessionId });
    return { ...result, ...this.projectContext.linkAgentWorktree(caller, result.worktree.id) };
  }
}
