import { randomUUID } from 'node:crypto';
import type { DatabaseService } from './DatabaseService';

export interface TimelineEventInput {
  event_type: string;
  project_id?: string | null;
  session_id?: string | null;
  process_id?: string | null;
  actor_type?: 'user' | 'agent' | 'system' | 'remote_agent';
  actor_id?: string | null;
  metadata?: Record<string, unknown>;
}

export class TimelineService {
  constructor(
    private readonly database: DatabaseService,
    private readonly onAppend?: (eventId: string) => void
  ) {}

  append(input: TimelineEventInput): string {
    const id = `event_${randomUUID()}`;
    const now = new Date().toISOString();

    this.database.connection
      .prepare(
        `insert into timeline_events
         (id, event_type, project_id, session_id, process_id, actor_type, actor_id, metadata, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.event_type,
        input.project_id ?? null,
        input.session_id ?? null,
        input.process_id ?? null,
        input.actor_type ?? 'system',
        input.actor_id ?? null,
        JSON.stringify(input.metadata ?? {}),
        now
      );

    this.onAppend?.(id);
    return id;
  }
}
