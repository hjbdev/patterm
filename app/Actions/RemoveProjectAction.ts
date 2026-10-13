import { z } from 'zod';
import type { ProjectLinkActions } from './ProjectLinkActions';
import type { DatabaseService } from '../Services/DatabaseService';
import { isUserProjectKind } from '../Services/PersonalProject';
import type { ProjectLinkService } from '../Services/ProjectLinkService';
import type { TimelineService } from '../Services/TimelineService';
import type { TimerService } from '../Services/TimerService';

export const removeProjectInput = z.object({
  project_id: z.string().min(1),
  actor_type: z.enum(['user', 'agent', 'system']).default('user'),
  actor_id: z.string().nullable().default(null)
});

export type RemoveProjectInput = z.infer<typeof removeProjectInput>;

export interface RemoveProjectDeps {
  database: DatabaseService;
  timeline: TimelineService;
  timers?: Pick<TimerService, 'cancelOwnedBy'>;
  links?: Pick<ProjectLinkService, 'links'>;
  unlink?: Pick<ProjectLinkActions, 'unlink'>;
}

// Takes a project out of Patterm without deleting anything. Its folder,
// worktrees, branches, todos, scratchpads, references, history, and stopped
// agents are kept, hidden, until the same folder is added again. Its routines
// wait while it is removed. Nothing may be running there, so no agent loses
// its project mid-turn. Links to other hosts are undone, because their agents
// could otherwise still reach a project the user no longer sees.
export class RemoveProjectAction {
  constructor(private readonly deps: RemoveProjectDeps) {}

  async execute(input: RemoveProjectInput): Promise<{ project_id: string; removed: true }> {
    const db = this.deps.database.connection;
    const project = db.prepare(`select name, kind from projects where id = ? and removed_at is null`)
      .get(input.project_id) as { name: string; kind: string } | undefined;
    if (!project || !isUserProjectKind(project.kind)) throw new Error(`unknown project ${input.project_id}`);
    if (project.kind === 'personal') throw new Error('The Personal project cannot be removed. Turn it off in Settings › Appearance to hide it.');
    const running = (db.prepare(`select count(*) as count from processes where project_id = ? and status = 'running'`)
      .get(input.project_id) as { count: number }).count;
    if (running > 0) {
      throw new Error(`Stop the ${running === 1 ? 'agent or process' : `${running} agents and processes`} running in ${project.name} before removing it.`);
    }

    const at = new Date().toISOString();
    db.prepare(`update projects set removed_at = ?, updated_at = ? where id = ?`).run(at, at, input.project_id);
    // Stopped agents can still own timers; none should fire into a hidden project.
    const owners = (db.prepare(`select id from processes where project_id = ?`).all(input.project_id) as Array<{ id: string }>).map((row) => row.id);
    this.deps.timers?.cancelOwnedBy(owners);
    this.deps.timeline.append({
      event_type: 'project.removed',
      project_id: input.project_id,
      actor_type: input.actor_type,
      actor_id: input.actor_id,
      metadata: { name: project.name }
    });

    for (const link of this.deps.links?.links().filter((candidate) => candidate.project_id === input.project_id) ?? []) {
      await this.deps.unlink?.unlink({ host_id: link.host_id, project_id: input.project_id });
    }
    return { project_id: input.project_id, removed: true };
  }
}
