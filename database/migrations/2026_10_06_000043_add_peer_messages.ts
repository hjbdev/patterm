import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_06_000043_add_peer_messages',
  up(schema) {
    // Messages between agents on paired hosts. The sending host keeps each
    // message as `out` until the other host answers, so messages survive the
    // other host being offline. The receiving host keeps it as `in`, so a
    // message sent again after a lost answer is delivered once.
    schema.sql(`create table if not exists peer_messages (
      id text not null,
      direction text not null check (direction in ('out', 'in')),
      host_id text not null,
      project_id text references projects(id) on delete set null,
      from_process_id text not null,
      to_process_id text not null,
      body text not null,
      status text not null check (status in ('queued', 'delivered', 'uncertain', 'bounced')),
      error text,
      attempts integer not null default 0,
      created_at text not null,
      updated_at text not null,
      primary key (id, direction)
    )`);
    schema.sql(`create index if not exists peer_messages_queue_idx on peer_messages(host_id, created_at) where direction = 'out' and status = 'queued'`);
  },
  down(schema) {
    schema.dropTableIfExists('peer_messages');
  }
} satisfies Migration;
