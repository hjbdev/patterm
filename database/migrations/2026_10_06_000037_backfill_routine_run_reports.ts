import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_06_000037_backfill_routine_run_reports',
  up(schema) {
    // Runs that reported before full reports were kept have only a 300-character
    // excerpt. Their agent.reported timeline event still holds the whole report,
    // formatted as RoutineService.report stores it.
    schema.sql(`update routine_runs set report = (
      select case when coalesce(json_extract(event.metadata, '$.title'), '') = '' then json_extract(event.metadata, '$.body')
        else json_extract(event.metadata, '$.title') || char(10) || char(10) || json_extract(event.metadata, '$.body') end
      from timeline_events event
      where event.event_type = 'agent.reported' and json_extract(event.metadata, '$.run_id') = routine_runs.id
      order by event.created_at desc limit 1
    ) where report is null`);
  },
  down() {
    // The backfilled reports match what newer runs store, so they stay.
  }
} satisfies Migration;
