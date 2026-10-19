import { z } from 'zod';
import { awaitingUser } from '../Services/Activity';
import type { DatabaseService } from '../Services/DatabaseService';
import { BODY_LIMIT, clean, type RaiseNotificationInput } from '../Services/NotificationService';
import type { TimelineService } from '../Services/TimelineService';

const id = z.string().min(1).max(200);

export const snoozeInput = z.object({
  process_id: id,
  // Shown on the agent when it wakes.
  reminder: z.string().trim().max(BODY_LIMIT).optional()
}).strict();

export const snoozeTargetInput = z.object({ process_id: id }).strict();

interface ProcessContext {
  id: string;
  project_id: string;
  session_id: string | null;
  status: string;
  integrated: number;
  snoozed_at: string | null;
  snooze_reminder: string | null;
}

// The user snoozes an agent until its next message: the end of a turn, or a
// request for the user. Talking to it wakes it too. A reminder left with the
// snooze stays on the agent after it wakes, until the user dismisses it.
// Waking at the end of a turn announces itself, with the reminder, in place
// of the turn-finished notice; requests and errors keep their own notices.
export class SnoozeActions {
  // Agents whose turn just woke them, until the turn-finished notice is skipped.
  private readonly announced = new Set<string>();

  constructor(
    private readonly database: DatabaseService,
    private readonly timeline: Pick<TimelineService, 'append'>,
    private readonly onChanged: () => void,
    private readonly raise: (input: RaiseNotificationInput) => void = () => undefined
  ) {}

  snooze(raw: unknown): { snoozed: true } {
    const input = snoozeInput.parse(raw);
    const process = this.process(input.process_id);
    if (!process || process.status !== 'running') throw new Error('Only a running agent can be snoozed');
    const reminder = input.reminder ? clean(input.reminder, BODY_LIMIT) : null;
    this.database.connection.prepare(`update processes set snoozed_at = ?, snooze_reminder = ? where id = ?`)
      .run(new Date().toISOString(), reminder || null, process.id);
    this.timeline.append({ event_type: 'agent.snoozed', project_id: process.project_id, session_id: process.session_id, process_id: process.id, actor_type: 'user', metadata: { reminder } });
    this.onChanged();
    return { snoozed: true };
  }

  // Wakes it now and drops the reminder, which the user has just seen.
  unsnooze(raw: unknown): { snoozed: false } {
    const process = this.process(snoozeTargetInput.parse(raw).process_id);
    if (process && (process.snoozed_at || process.snooze_reminder)) {
      this.database.connection.prepare(`update processes set snoozed_at = null, snooze_reminder = null where id = ?`).run(process.id);
      this.onChanged();
    }
    return { snoozed: false };
  }

  dismissReminder(raw: unknown): { dismissed: boolean } {
    const process = this.process(snoozeTargetInput.parse(raw).process_id);
    if (!process?.snooze_reminder || process.snoozed_at) return { dismissed: false };
    this.database.connection.prepare(`update processes set snooze_reminder = null where id = ?`).run(process.id);
    this.onChanged();
    return { dismissed: true };
  }

  // An agent's activity changed. A finished turn, a question, a permission
  // request, or an error is its next message. Accepts a Patterm or PTY
  // process id.
  activity(processId: string, previous: string | null | undefined, activity: string): void {
    const turnEnded = (previous === 'working' || previous === 'thinking') && activity !== 'working' && activity !== 'thinking';
    if (awaitingUser(activity) || activity === 'error') this.wake(processId, 'message');
    else if (turnEnded) this.wake(processId, 'message', true);
  }

  // Whether the turn that just ended woke the agent and announced it, so the
  // turn-finished notice is left out. Answers once per wake.
  announcedWake(processId: string): boolean {
    return this.announced.delete(processId);
  }

  // The user typed to the agent. Accepts a Patterm or PTY process id.
  userInput(processId: string): void {
    this.wake(processId, 'user');
  }

  private wake(processId: string, reason: 'message' | 'user', announce = false): void {
    const process = this.process(processId);
    if (!process?.snoozed_at) return;
    this.database.connection.prepare(`update processes set snoozed_at = null where id = ?`).run(process.id);
    this.timeline.append({ event_type: 'agent.woke', project_id: process.project_id, session_id: process.session_id, process_id: process.id, actor_type: reason === 'user' ? 'user' : 'agent', metadata: { reason } });
    this.onChanged();
    if (!announce) return;
    // Only Integrated agents announce finished turns.
    if (process.integrated) this.announced.add(process.id);
    // Keyed by the snooze, so each wake alerts afresh.
    this.raise({ processId: process.id, source: 'runtime', kind: 'turn_finished', body: process.snooze_reminder ? `Woke from snooze: ${process.snooze_reminder}` : 'Woke from snooze', dedupeKey: `snooze:woke:${process.snoozed_at}` });
  }

  private process(processId: string): ProcessContext | null {
    return (this.database.connection.prepare(`select processes.id, processes.project_id, processes.status, sessions.interface_mode = 'integrated' as integrated,
        processes.snoozed_at, processes.snooze_reminder, sessions.id as session_id
      from processes
      left join sessions on sessions.process_id = processes.id
      where processes.id = ? or processes.pty_process_id = ?
      order by processes.status = 'running' desc, sessions.started_at desc limit 1`).get(processId, processId) as ProcessContext | undefined) ?? null;
  }
}
