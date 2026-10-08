import { worktreeListInput, type WorktreeListInput, type WorktreeService } from '../Services/WorktreeService';

export const listWorktreesInput = worktreeListInput;
export type ListWorktreesInput = WorktreeListInput;

export class ListWorktreesAction {
  constructor(private readonly worktrees: WorktreeService) {}

  execute(input: WorktreeListInput) {
    return this.worktrees.list(input);
  }
}
