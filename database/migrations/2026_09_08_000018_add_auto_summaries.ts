import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_09_08_000018_add_auto_summaries',
  up({ sql }) {
    sql(`alter table processes add column auto_summary text;
      alter table processes add column auto_summary_at text;
      alter table processes add column auto_summary_provider text;
      alter table processes add column auto_summary_model text;`);
  },
  down({ sql }) {
    sql(`alter table processes drop column auto_summary;
      alter table processes drop column auto_summary_at;
      alter table processes drop column auto_summary_provider;
      alter table processes drop column auto_summary_model;`);
  }
} satisfies Migration;
