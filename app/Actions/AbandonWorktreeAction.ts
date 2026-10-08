import { worktreeAbandonInput, type WorktreeAbandonInput, type WorktreeService } from '../Services/WorktreeService';

export const abandonWorktreeInput = worktreeAbandonInput;
export type AbandonWorktreeInput = WorktreeAbandonInput;

export class AbandonWorktreeAction {
  constructor(private readonly worktrees: WorktreeService) {}

  execute(input: WorktreeAbandonInput) {
    return this.worktrees.abandon(input);
  }
}
