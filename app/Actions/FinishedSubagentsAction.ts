import type { DatabaseService } from '../Services/DatabaseService';

export interface FinishedSubagent {
  process_id: string;
  name: string;
}

// Child agents that have reported to their parent and gone idle. Closing them
// stays the user's decision, because a parent may still send follow-ups. A
// child with a running agent or process anywhere below it is left out, because
// closing cascades through stopped agents and would close it too.
export class FinishedSubagentsAction {
  constructor(private readonly database: DatabaseService) {}

  execute(parentProcessId: string): FinishedSubagent[] {
    return this.database.connection
      .prepare(
        `with recursive descendants(candidate_id, id, status) as (
           select parent_process_id, id, status from processes
           where parent_process_id in (select id from processes where parent_process_id = ?)
           union
           select descendants.candidate_id, processes.id, processes.status
           from processes join descendants on processes.parent_process_id = descendants.id
         )
         select processes.id as process_id, coalesce(sessions.title, processes.name) as name
         from processes
         join sessions on sessions.process_id = processes.id
         where processes.parent_process_id = ?
           and processes.kind = 'agent'
           and processes.status = 'running'
           and processes.activity = 'idle'
           and sessions.exited_at is null
           and not exists (
             select 1 from descendants
             where descendants.candidate_id = processes.id and descendants.status = 'running'
           )
           and exists (
             select 1 from timeline_events
             where timeline_events.event_type = 'agent.reported' and timeline_events.process_id = processes.id
           )
         group by processes.id
         order by processes.created_at`
      )
      .all(parentProcessId, parentProcessId) as unknown as FinishedSubagent[];
  }
}
