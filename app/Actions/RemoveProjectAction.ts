import { z } from 'zod';
import type { CloseProcessAction } from './CloseProcessAction';
import type { ProjectLinkActions } from './ProjectLinkActions';
import type { AgentHistoryImportQueueService } from '../Services/AgentHistory/AgentHistoryImportQueueService';
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
  closeProcess: Pick<CloseProcessAction, 'execute'>;
  timers?: Pick<TimerService, 'cancelOwnedBy'>;
  links?: Pick<ProjectLinkService, 'links'>;
  unlink?: Pick<ProjectLinkActions, 'unlink'>;
  history?: Pick<AgentHistoryImportQueueService, 'deleteProjectHistory'> | null;
}

// Deletes everything Patterm holds for a project: its agents and processes
// (stopped first), worktree records, todos, scratchpads, references,
// routines, timers, notifications, summaries, links with other hosts, and
// imported conversation history. Files on disk are never touched: the
// project folder, worktree directories, branches, and the CLIs' own
// transcripts all stay.
export class RemoveProjectAction {
  constructor(private readonly deps: RemoveProjectDeps) {}

  async execute(input: RemoveProjectInput): Promise<{ project_id: string; removed: true; stopped: number }> {
    const db = this.deps.database.connection;
    const project = db.prepare(`select name, kind from projects where id = ?`)
      .get(input.project_id) as { name: string; kind: string } | undefined;
    if (!project || !isUserProjectKind(project.kind)) throw new Error(`unknown project ${input.project_id}`);
    if (project.kind === 'personal') throw new Error('The Personal project cannot be removed. Turn it off in Settings › Appearance to hide it.');

    // Closing stops live agents and processes and frees their terminals. A
    // stop that fails throws here, before anything is deleted.
    const processes = db.prepare(`select id, status from processes where project_id = ? and status <> 'closed'`)
      .all(input.project_id) as Array<{ id: string; status: string }>;
    for (const process of processes) await this.deps.closeProcess.execute(process.id);
    const owners = (db.prepare(`select id from processes where project_id = ?`).all(input.project_id) as Array<{ id: string }>).map((row) => row.id);
    this.deps.timers?.cancelOwnedBy(owners);

    for (const link of this.deps.links?.links().filter((candidate) => candidate.project_id === input.project_id) ?? []) {
      await this.deps.unlink?.unlink({ host_id: link.host_id, project_id: input.project_id });
    }

    // Project tables cascade from projects, including the timeline, so the
    // removal itself is recorded without a project. Rows keyed only by
    // process ID and the search index have no foreign key and go by hand.
    db.transaction(() => {
      for (const table of ['integrated_submissions', 'integrated_held_prompts']) {
        db.prepare(`delete from ${table} where process_id in (select id from processes where project_id = ?)`).run(input.project_id);
      }
      db.prepare(`delete from app_artifacts_fts where project_id = ?`).run(input.project_id);
      db.prepare(`delete from projects where id = ?`).run(input.project_id);
    })();
    this.deps.history?.deleteProjectHistory(input.project_id);
    this.deps.timeline.append({
      event_type: 'project.removed',
      project_id: null,
      actor_type: input.actor_type,
      actor_id: input.actor_id,
      metadata: { project_id: input.project_id, name: project.name }
    });
    return { project_id: input.project_id, removed: true, stopped: processes.filter((process) => process.status === 'running').length };
  }
}
