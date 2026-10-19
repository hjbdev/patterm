import { z } from 'zod';
import type { DatabaseService } from '../Services/DatabaseService';
import type { NotificationService, RaiseNotificationInput } from '../Services/NotificationService';
import type { TimelineService } from '../Services/TimelineService';

const id = z.string().min(1).max(200);

export const projectSnoozeInput = z.object({
  project_id: id,
  // When it wakes, as an ISO date-time in the future.
  until: z.string().datetime({ offset: true })
}).strict();

export const projectWakeInput = z.object({ project_id: id }).strict();

// Checks again at least this often, so a clock change or a missed timer
// delays a wake by a minute at most.
const MAX_TIMER_MS = 60_000;

interface ProjectRow {
  id: string;
  name: string;
  snoozed_until: string | null;
}

// The user snoozes a project until a time, such as the start of their next
// workday. Its notifications are held meanwhile (see NotificationService);
// waking, at that time or by hand, sends one summary of what was held. The
// deadline lives in the database, so a wake that falls due while Patterm is
// stopped happens once it starts again.
export class ProjectSnoozeActions {
  private timer: NodeJS.Timeout | null = null;
  private active = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly timeline: Pick<TimelineService, 'append'>,
    private readonly notifications: Pick<NotificationService, 'releaseHeld'>,
    private readonly raise: (input: RaiseNotificationInput) => void,
    private readonly onChanged: () => void,
    private readonly now: () => number = Date.now
  ) {}

  snooze(raw: unknown): { snoozed_until: string } {
    const input = projectSnoozeInput.parse(raw);
    const until = Date.parse(input.until);
    if (until <= this.now()) throw new Error('Choose a time in the future');
    const project = this.project(input.project_id);
    if (!project) throw new Error('Project not found');
    const snoozedUntil = new Date(until).toISOString();
    this.database.connection.prepare(`update projects set snoozed_until = ? where id = ?`).run(snoozedUntil, project.id);
    this.timeline.append({ event_type: 'project.snoozed', project_id: project.id, actor_type: 'user', metadata: { snoozed_until: snoozedUntil } });
    this.onChanged();
    this.tick();
    return { snoozed_until: snoozedUntil };
  }

  wake(raw: unknown): { woke: boolean; held: number } {
    const project = this.project(projectWakeInput.parse(raw).project_id);
    if (!project) throw new Error('Project not found');
    return this.wakeProject(project, 'user');
  }

  // Started after runtime reconciliation, like routines.
  activate(): void {
    if (this.active) return;
    this.active = true;
    this.tick();
  }

  dispose(): void {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private tick(): void {
    if (!this.active) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const db = this.database.connection;
    const due = db.prepare(`select id, name, snoozed_until from projects where snoozed_until is not null and snoozed_until <= ?`)
      .all(new Date(this.now()).toISOString()) as unknown as ProjectRow[];
    for (const project of due) this.wakeProject(project, 'system');
    const soonest = db.prepare(`select min(snoozed_until) as at from projects where snoozed_until is not null`).get() as { at: string | null };
    if (!soonest.at) return;
    this.timer = setTimeout(() => this.tick(), Math.min(MAX_TIMER_MS, Math.max(1_000, Date.parse(soonest.at) - this.now())));
    this.timer.unref?.();
  }

  private wakeProject(project: ProjectRow, actor: 'user' | 'system'): { woke: boolean; held: number } {
    if (!project.snoozed_until) return { woke: false, held: 0 };
    this.database.connection.prepare(`update projects set snoozed_until = null where id = ?`).run(project.id);
    const held = this.notifications.releaseHeld(project.id);
    this.timeline.append({ event_type: 'project.woke', project_id: project.id, actor_type: actor, metadata: { held } });
    this.onChanged();
    if (held) {
      this.raise({
        projectId: project.id,
        source: 'system',
        kind: 'message',
        urgency: 'normal',
        title: project.name,
        body: `${held} ${held === 1 ? 'notification' : 'notifications'} while snoozed`,
        dedupeKey: `project-snooze:${project.id}:${this.now()}`
      });
    }
    return { woke: true, held };
  }

  private project(projectId: string): ProjectRow | null {
    return (this.database.connection.prepare(`select id, name, snoozed_until from projects where id = ?`).get(projectId) as ProjectRow | undefined) ?? null;
  }
}
