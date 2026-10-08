import type { Migration } from '../../app/Database/Migration';

const migration = {
  name: '2026_09_30_000025_add_mcp_servers',
  up(schema) {
    // Global MCP servers that Patterm passes to every harness at launch.
    // Values that can hold secrets (environment, headers, tokens) are JSON text.
    schema.sql(`create table mcp_servers (
      id text primary key,
      name text not null unique,
      transport text not null check (transport in ('stdio', 'http')),
      command text,
      args text not null default '[]',
      env text not null default '{}',
      url text,
      headers text not null default '{}',
      auth text not null default 'none' check (auth in ('none', 'oauth')),
      oauth_client_id text,
      oauth_client_secret text,
      oauth_scopes text,
      harnesses text not null default '["claude","codex","opencode","amp"]',
      enabled integer not null default 1,
      created_at text not null,
      updated_at text not null
    )`);
    // Tokens belong to one server entry, not to its URL, so two entries for
    // the same service can sign in to different accounts.
    schema.sql(`create table mcp_server_credentials (
      server_id text primary key references mcp_servers(id) on delete cascade,
      redirect_uri text,
      client_information text,
      tokens text,
      discovery_state text,
      updated_at text not null
    )`);
  },
  down(schema) {
    schema.sql('drop table mcp_server_credentials');
    schema.sql('drop table mcp_servers');
  }
} satisfies Migration;

export default migration;
