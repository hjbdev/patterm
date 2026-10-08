import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_06_000036_add_routine_run_report',
  up(schema) {
    // The full report, so a run's notification can open what the agent said.
    schema.sql('alter table routine_runs add column report text');
  },
  down(schema) {
    schema.sql('alter table routine_runs drop column report');
  }
} satisfies Migration;
