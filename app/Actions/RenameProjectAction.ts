import { z } from 'zod';
import type { DatabaseService } from '../Services/DatabaseService';
import type { TimelineService } from '../Services/TimelineService';
import { USER_PROJECT_KINDS_SQL } from '../Services/PersonalProject';

export const renameProjectInput = z.object({
  project_id: z.string().min(1),
  name: z.string().trim().min(1, 'Name the project').max(200),
  actor_type: z.enum(['user', 'agent', 'system']).default('user'),
  actor_id: z.string().nullable().default(null)
});

export type RenameProjectInput = z.infer<typeof renameProjectInput>;

// Changes the name Patterm shows for a project. The folder keeps its name, and
// paired hosts pick the new name up the next time they list projects.
export class RenameProjectAction {
  constructor(
    private readonly database: DatabaseService,
    private readonly timeline: TimelineService
  ) {}

  execute(input: RenameProjectInput): { project_id: string; name: string } {
    const row = this.database.connection
      .prepare(`select name from projects where id = ? and kind in ${USER_PROJECT_KINDS_SQL} and removed_at is null`)
      .get(input.project_id) as { name: string } | undefined;
    if (!row) throw new Error(`unknown project ${input.project_id}`);
    if (row.name === input.name) return { project_id: input.project_id, name: input.name };
    this.database.connection
      .prepare(`update projects set name = ?, updated_at = ? where id = ?`)
      .run(input.name, new Date().toISOString(), input.project_id);
    this.timeline.append({
      event_type: 'project.renamed',
      project_id: input.project_id,
      actor_type: input.actor_type,
      actor_id: input.actor_id,
      metadata: { from: row.name, to: input.name }
    });
    return { project_id: input.project_id, name: input.name };
  }
}
