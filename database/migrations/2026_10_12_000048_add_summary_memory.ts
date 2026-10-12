import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_12_000048_add_summary_memory',
  up(schema) {
    schema.sql(`
      alter table processes add column auto_summary_coverage text;
      create table auto_summary_enrollments (
        process_id text primary key references processes(id) on delete cascade
      );
      create table auto_summary_memory (
        project_id text not null references projects(id) on delete cascade,
        provider text not null,
        native_id text not null,
        position integer not null default 0,
        byte_offset integer not null default 0,
        prefix_hash text not null default '',
        message_hash text not null default '',
        recap text not null default '{}',
        origin text not null default 'beginning',
        stale integer not null default 0,
        paused integer not null default 0,
        rebuild_end integer,
        revision integer not null default 0,
        updated_at text,
        primary key (project_id, provider, native_id)
      );
      insert into auto_summary_enrollments select id from processes where kind = 'agent' and auto_summary is not null;
      update processes set auto_summary_coverage = 'partial' where kind = 'agent' and auto_summary is not null;
    `);
  },
  down(schema) {
    schema.dropTableIfExists('auto_summary_memory');
    schema.dropTableIfExists('auto_summary_enrollments');
    schema.sql('alter table processes drop column auto_summary_coverage');
  }
} satisfies Migration;
