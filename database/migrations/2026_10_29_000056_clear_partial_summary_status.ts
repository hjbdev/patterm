import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_29_000056_clear_partial_summary_status',
  up(schema) {
    // Partial recaps used to store this label as their status. Clearing it
    // lets the sidebar show the recap until the next one writes a real status.
    schema.sql("update processes set auto_status = null where auto_status = 'Partial conversation recap'");
  },
  // The label was never useful, so rolling back leaves it cleared.
  down() {}
} satisfies Migration;
