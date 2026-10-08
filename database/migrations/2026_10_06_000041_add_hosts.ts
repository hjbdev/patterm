import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_06_000041_add_hosts',
  up(schema) {
    // This host's identity. The ID never changes; the name is the user's
    // label and the prefix of remote addresses such as `workstation:process_7`.
    schema.sql(`create table if not exists host_identity (
      singleton integer primary key check (singleton = 1),
      host_id text not null,
      name text not null,
      created_at text not null,
      updated_at text not null
    )`);
    // Hosts this host connects to, with the credential each one issued.
    // Pairing is two-way: either host can hide the other's agents.
    schema.sql(`create table if not exists paired_hosts (
      host_id text primary key,
      name text not null,
      url text not null,
      credential text not null,
      show_agents integer not null default 1,
      created_at text not null,
      updated_at text not null,
      last_connected_at text,
      last_error text
    )`);
    // Hosts allowed to connect to this one. Only a hash of each credential
    // is kept; revoked grants stay for the record.
    schema.sql(`create table if not exists peer_grants (
      id text primary key,
      host_id text not null,
      name text not null,
      token_hash text not null unique,
      show_agents integer not null default 1,
      created_at text not null,
      last_used_at text,
      revoked_at text
    )`);
    schema.sql('create index if not exists peer_grants_host_idx on peer_grants(host_id) where revoked_at is null');
  },
  down(schema) {
    schema.dropTableIfExists('peer_grants');
    schema.dropTableIfExists('paired_hosts');
    schema.dropTableIfExists('host_identity');
  }
} satisfies Migration;
