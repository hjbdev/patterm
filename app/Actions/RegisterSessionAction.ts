import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DatabaseService } from '../Services/DatabaseService';
import type { TimelineService } from '../Services/TimelineService';
import { SessionContextService } from '../Services/SessionContextService';

export const registerSessionInput = z.object({
  project_id: z.string().min(1),
  process_id: z.string().nullable().default(null),
  mcp_identity: z.string().nullable().default(null),
  harness: z.string().min(1),
  interface_mode: z.enum(['tui', 'integrated']).default('tui'),
  session_role: z.enum(['orchestrator', 'child', 'process', 'assistant', 'routine']).default('orchestrator'),
  cwd: z.string().nullable().default(null),
  worktree_id: z.string().nullable().default(null),
  last_title: z.string().nullable().default(null),
  display_name: z.string().nullable().default(null),
  resume_id: z.string().nullable().default(null),
  resume_status: z.enum(['unknown', 'found', 'missing', 'imported']).default('unknown'),
  model: z.string().trim().min(1).max(160).nullable().default(null),
  reasoning: z.string().trim().min(1).max(60).nullable().default(null),
  service_tier: z.string().trim().min(1).max(60).nullable().default(null),
  resumed_conversation_id: z.string().nullable().default(null),
  resumed_from_session_id: z.string().min(1).nullable().optional(),
  created_by_actor: z.string().default('user')
});

export type RegisterSessionInput = z.infer<typeof registerSessionInput>;

// Records a launched harness as a session row. Fresh sessions start
// with an unknown resume ID; resumed sessions can persist their known ID.
export class RegisterSessionAction {
  constructor(
    private readonly database: DatabaseService,
    private readonly timeline: TimelineService
  ) {}

  execute(input: RegisterSessionInput): { session_id: string } {
    return this.database.connection.transaction(() => this.register(input))();
  }

  private register(input: RegisterSessionInput): { session_id: string } {
    const id = `session_${randomUUID()}`;
    const now = new Date().toISOString();

    this.database.connection
      .prepare(
        `insert into sessions
          (id, project_id, process_id, mcp_identity, harness, interface_mode, session_role, resume_status,
           resume_id, started_at, cwd, worktree_id, last_title, display_name, model, reasoning, service_tier, created_by_actor)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.project_id,
        input.process_id,
        input.mcp_identity,
        input.harness,
        input.interface_mode,
        input.session_role,
        input.resume_status,
        input.resume_id,
        now,
        input.cwd,
        input.worktree_id,
        input.last_title,
        input.display_name,
        input.model,
        input.reasoning,
        input.service_tier,
        input.created_by_actor
      );

    if (input.resume_id && (input.resumed_conversation_id || input.resumed_from_session_id || input.resume_status === 'imported')) {
      new SessionContextService(this.database).inherit(id, input.project_id, input.harness, input.resume_id, this.timeline, input.resumed_from_session_id);
    }

    // Note: timeline_events.process_id FKs to processes(id); the sidecar PTY id
    // isn't a processes row, so carry it in metadata rather than the column.
    this.timeline.append({
      event_type: 'session.started',
      project_id: input.project_id,
      session_id: id,
      actor_type: 'system',
      metadata: {
        harness: input.harness,
        session_role: input.session_role,
        process_id: input.process_id,
        worktree_id: input.worktree_id,
        ...(input.model ? { model: input.model } : {}),
        ...(input.reasoning ? { reasoning: input.reasoning } : {}),
        ...(input.service_tier ? { service_tier: input.service_tier } : {}),
        ...(input.resumed_conversation_id ? { resumed_conversation_id: input.resumed_conversation_id } : {})
      }
    });

    return { session_id: id };
  }
}
