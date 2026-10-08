import { z } from 'zod';
import { diffFileInput, type DiffService } from '../Services/DiffService';
import type { ProjectContextService } from '../Services/ProjectContextService';
import { defaultDiffWorktree } from './GetCurrentDiffAction';

// As for diff.current, agents may omit worktree_id.
export const getDiffFileInput = diffFileInput.extend({ worktree_id: z.string().min(1).optional() });
export type GetDiffFileInput = z.input<typeof getDiffFileInput>;

export class GetDiffFileAction {
  constructor(private readonly diffs: DiffService, private readonly sessions: Pick<ProjectContextService, 'defaultWorktreeId'>) {}

  async execute(raw: GetDiffFileInput, callerSessionId: string | null = null) {
    const input = getDiffFileInput.parse(raw);
    return this.diffs.file({ scope: input.scope, path: input.path, worktree_id: input.worktree_id ?? defaultDiffWorktree(this.sessions, callerSessionId) });
  }
}
