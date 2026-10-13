import { z } from 'zod';
import type { CloseProcessAction } from './CloseProcessAction';
import type { ProjectLinkActions } from './ProjectLinkActions';
import { recordProcessIdHighWater } from './RegisterProcessAction';
import type { AgentHistoryImportQueueService } from '../Services/AgentHistory/AgentHistoryImportQueueService';
import type { DatabaseService } from '../Services/DatabaseService';
import type { IntegratedAgentService } from '../Services/IntegratedAgentService';
import { isUserProjectKind } from '../Services/PersonalProject';
import type { ProjectLaunchFence } from '../Services/ProjectLaunchFence';
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
  fence: ProjectLaunchFence;
  integrated?: Pick<IntegratedAgentService, 'stopIfLive'>;
  timers?: Pick<TimerService, 'cancelOwnedBy'>;
  links?: Pick<ProjectLinkService, 'links'>;
  unlink?: Pick<ProjectLinkActions, 'unlink'>;
  history?: Pick<AgentHistoryImportQueueService, 'deleteProjectHistory'> | null;
}

// Rows that hold a project's data but have no foreign key to cascade from.
const UNLINKED_ROWS = [
  'delete from integrated_submissions where process_id in (select id from processes where project_id = ?)',
  'delete from integrated_held_prompts where process_id in (select id from processes where project_id = ?)',
  'delete from assistant_inbox where source_process_id in (select id from processes where project_id = ?)',
  'delete from routine_runs where project_id = ?',
  'delete from peer_messages where project_id = ?',
  'delete from app_artifacts_fts where project_id = ?',
  // Copies from before history had its own database, purged there already.
  'delete from conversations where project_id = ?'
];

// Deletes everything Patterm holds for a project: its agents and processes
// (stopped first), worktree records, todos, scratchpads, references,
// routines, timers, notifications, summaries, links with other hosts, and
// imported conversation history. Files on disk are never touched: the
// project folder, worktree directories, branches, and the CLIs' own
// transcripts all stay. Every step that can fail runs before anything is
// deleted, so a failed removal leaves the project in place to try again.
export class RemoveProjectAction {
  constructor(private readonly deps: RemoveProjectDeps) {}

  async execute(input: RemoveProjectInput): Promise<{ project_id: string; removed: true; stopped: number }> {
    const db = this.deps.database.connection;
    const project = db.prepare(`select name, kind from projects where id = ?`)
      .get(input.project_id) as { name: string; kind: string } | undefined;
    if (!project || !isUserProjectKind(project.kind)) throw new Error(`unknown project ${input.project_id}`);
    if (project.kind === 'personal') throw new Error('The Personal project cannot be removed. Turn it off in Settings › Appearance to hide it.');

    // No launch starts once the fence is closed, and those already starting
    // finish first, so the list below is complete.
    await this.deps.fence.close(input.project_id);
    try {
      const processes = db.prepare(`select processes.id, processes.status,
          exists(select 1 from sessions where sessions.process_id = processes.id and sessions.interface_mode = 'integrated') as integrated
        from processes where project_id = ?`).all(input.project_id) as Array<{ id: string; status: string; integrated: number }>;
      // Closing stops live agents and frees their terminals, but treats a
      // stopped Integrated agent's host as best effort. Removal must know it
      // is gone, so a host that refuses to stop fails the removal here.
      for (const process of processes) if (process.integrated) await this.deps.integrated?.stopIfLive(process.id);
      for (const process of processes) if (process.status !== 'closed') await this.deps.closeProcess.execute(process.id);
      this.deps.timers?.cancelOwnedBy(processes.map((process) => process.id));

      for (const link of this.deps.links?.links().filter((candidate) => candidate.project_id === input.project_id) ?? []) {
        await this.deps.unlink?.unlink({ host_id: link.host_id, project_id: input.project_id });
      }
      // History is purged while the project still exists, so imports queued
      // before it still link their conversations to the project. The worker
      // copies conversations left in app.db from before history had its own
      // database before purging, so those get tombstones too. Nothing awaits
      // between the purge and the deletion, so no import copies them back.
      await this.deps.history?.deleteProjectHistory(input.project_id);

      // Everything else cascades from the project row, including the
      // timeline, so the removal itself is recorded without a project.
      db.transaction(() => {
        recordProcessIdHighWater(this.deps.database);
        for (const sql of UNLINKED_ROWS) db.prepare(sql).run(input.project_id);
        db.prepare(`delete from projects where id = ?`).run(input.project_id);
      })();
      this.deps.timeline.append({
        event_type: 'project.removed',
        project_id: null,
        actor_type: input.actor_type,
        actor_id: input.actor_id,
        metadata: { project_id: input.project_id, name: project.name }
      });
      return { project_id: input.project_id, removed: true, stopped: processes.filter((process) => process.status === 'running').length };
    } finally {
      this.deps.fence.open(input.project_id);
    }
  }
}
