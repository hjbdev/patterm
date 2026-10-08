import { z } from 'zod';
import type { DatabaseService } from '../Services/DatabaseService';
import type { TimelineService } from '../Services/TimelineService';

export const registerProcessInput = z.object({
  project_id: z.string().min(1),
  parent_process_id: z.string().nullable().default(null),
  pty_process_id: z.string().nullable().default(null),
  kind: z.string().default('command'),
  name: z.string().min(1),
  status: z.string().default('running'),
  cwd: z.string().nullable().default(null),
  argv: z.array(z.string()).default([]),
  worktree_id: z.string().nullable().default(null),
  auto_restart: z.boolean().default(false),
  created_by_actor: z.string().default('user')
});

export type RegisterProcessInput = z.infer<typeof registerProcessInput>;

// Records a spawned process (a shell or freeform command) as a processes row.
// The process_N id is the stable domain key; pty_process_id holds the live sidecar
// PTY handle the terminal view attaches to.
export class RegisterProcessAction {
  constructor(
    private readonly database: DatabaseService,
    private readonly timeline: TimelineService
  ) {}

  execute(input: RegisterProcessInput): { process_id: string } {
    const now = new Date().toISOString();
    const db = this.database.connection;
    let id = '';

    // FK: timeline_events.process_id references processes(id), so insert the
    // row before the timeline event. One transaction keeps them atomic.
    db.transaction(() => {
      id = nextProcessId(this.database);
      db.prepare(
        `insert into processes
         (id, project_id, parent_process_id, kind, name, status, cwd, argv,
          pty_process_id, worktree_id, auto_restart, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        input.project_id,
        input.parent_process_id,
        input.kind,
        input.name,
        input.status,
        input.cwd,
        JSON.stringify(input.argv),
        input.pty_process_id,
        input.worktree_id,
        input.auto_restart ? 1 : 0,
        now,
        now
      );

      this.timeline.append({
        event_type: 'process.started',
        project_id: input.project_id,
        process_id: id,
        actor_type: 'system',
        metadata: { name: input.name, kind: input.kind, auto_restart: input.auto_restart, worktree_id: input.worktree_id }
      });
    })();

    return { process_id: id };
  }
}

export function nextProcessId(database: DatabaseService): string {
  const row = database.connection
    .prepare(
      `select coalesce(max(cast(substr(id, 9) as integer)), 0) as max
       from processes
       where id glob 'process_[0-9]*'
         and substr(id, 9) not glob '*[^0-9]*'`
    )
    .get() as { max: number } | undefined;
  const max = row?.max ?? 0;
  return `process_${max + 1}`;
}
