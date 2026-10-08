import { z } from 'zod';
import type { DatabaseService } from '../Services/DatabaseService';
import { BODY_LIMIT, clean, displayName, type NotificationService } from '../Services/NotificationService';
import type { TimelineService } from '../Services/TimelineService';
import type { CloseProcessAction } from './CloseProcessAction';

const id = z.string().min(1).max(200);

export const requestCloseInput = z.object({
  summary: z.string().trim().min(1).max(BODY_LIMIT)
}).strict();

export const closeRequestAnswerInput = z.object({
  process_id: id,
  decision: z.enum(['close', 'keep_open']),
  // Typed into the agent when the user keeps it open with a reason.
  feedback: z.string().trim().max(BODY_LIMIT).optional()
}).strict();

interface ProcessContext {
  id: string;
  project_id: string;
  session_id: string | null;
  parent_process_id: string | null;
  parent_running: number;
  status: string;
  integrated: number;
  name: string;
  close_requested_at: string | null;
  close_request_summary: string | null;
}

export type RequestCloseResult =
  | { status: 'requested' }
  | { status: 'routed_to_parent'; parent_process_id: string };

// An agent that thinks its work is done asks to be closed. Root agents wait
// for the user; children ask their parent, which already decides when to
// close them.
export class CloseRequestActions {
  constructor(
    private readonly database: DatabaseService,
    private readonly timeline: Pick<TimelineService, 'append'>,
    private readonly close: Pick<CloseProcessAction, 'execute'>,
    private readonly messageProcess: (processId: string, text: string, fromProcessId: string) => Promise<unknown>,
    private readonly onChanged: () => void,
    private readonly notifications?: Pick<NotificationService, 'raise' | 'resolve'>
  ) {}

  async request(processId: string, raw: unknown): Promise<RequestCloseResult> {
    const input = requestCloseInput.parse(raw);
    const process = this.process(processId);
    if (!process || process.status !== 'running') throw new Error('request_close: your process is not running');
    const summary = clean(input.summary, BODY_LIMIT);

    if (process.parent_process_id && process.parent_running) {
      this.timeline.append({ event_type: 'agent.close_requested', project_id: process.project_id, session_id: process.session_id, process_id: process.id, actor_type: 'agent', metadata: { routed_to_process_id: process.parent_process_id, summary } });
      await this.messageProcess(process.parent_process_id, [
        `[Close requested by ${process.id} (${displayName(process.name)})]`,
        summary,
        'Close it with close_process once its work is settled, or send it follow-ups with send_message.'
      ].join('\n'), process.id);
      return { status: 'routed_to_parent', parent_process_id: process.parent_process_id };
    }

    const at = new Date().toISOString();
    this.database.connection.prepare(`update processes set close_requested_at = ?, close_request_summary = ? where id = ?`).run(at, summary, process.id);
    this.timeline.append({ event_type: 'agent.close_requested', project_id: process.project_id, session_id: process.session_id, process_id: process.id, actor_type: 'agent', metadata: { summary } });
    this.onChanged();
    // An Integrated agent is still mid-turn; it announces the request when the
    // turn ends, in place of the turn-finished notice.
    if (!process.integrated) await this.announce(process.id);
    return { status: 'requested' };
  }

  pending(processId: string): boolean {
    return Boolean(this.process(processId)?.close_requested_at);
  }

  async announce(processId: string): Promise<void> {
    const process = this.process(processId);
    if (!process?.close_requested_at) return;
    await this.notifications?.raise({ processId: process.id, source: 'mcp', kind: 'attention', title: 'Ready to close', body: process.close_request_summary ?? '', dedupeKey: 'close_request' });
  }

  // The user talked to the agent again, or it started new work, so the
  // request is stale. Accepts a Patterm or PTY process id.
  clear(processId: string): boolean {
    const process = this.process(processId);
    if (!process?.close_requested_at) return false;
    this.database.connection.prepare(`update processes set close_requested_at = null, close_request_summary = null where id = ?`).run(process.id);
    this.onChanged();
    return true;
  }

  async answer(raw: unknown): Promise<{ closed: string[] } | { kept_open: true }> {
    const input = closeRequestAnswerInput.parse(raw);
    const process = this.process(input.process_id);
    if (!process?.close_requested_at) throw new Error('This agent has no pending close request');
    this.timeline.append({ event_type: 'agent.close_answered', project_id: process.project_id, session_id: process.session_id, process_id: process.id, actor_type: 'user', metadata: { decision: input.decision, feedback: input.feedback ?? null } });
    if (input.decision === 'close') return this.close.execute(process.id);

    this.clear(process.id);
    this.notifications?.resolve({ process_id: process.id, kinds: ['attention', 'turn_finished'] });
    // Without a reason the agent is left idle rather than handed a new turn.
    if (input.feedback) await this.messageProcess(process.id, `[Close request declined by the user]\n${input.feedback}`, process.id);
    return { kept_open: true };
  }

  private process(processId: string): ProcessContext | null {
    return (this.database.connection.prepare(`select processes.id, processes.project_id, processes.parent_process_id, processes.status, sessions.interface_mode = 'integrated' as integrated,
        processes.close_requested_at, processes.close_request_summary,
        coalesce(sessions.display_name, sessions.last_title, processes.name) as name, sessions.id as session_id,
        exists(select 1 from processes parent where parent.id = processes.parent_process_id and parent.status = 'running') as parent_running
      from processes
      left join sessions on sessions.process_id = processes.id
      where processes.id = ? or processes.pty_process_id = ?
      order by processes.status = 'running' desc, sessions.started_at desc limit 1`).get(processId, processId) as ProcessContext | undefined) ?? null;
  }
}
