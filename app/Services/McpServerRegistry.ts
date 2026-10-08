import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DatabaseService } from './DatabaseService';

// Global MCP servers that Patterm passes to every harness at launch. Names
// stay the user's own so tool names and permission rules keep matching.
export const MCP_HARNESSES = ['claude', 'codex', 'opencode', 'amp'] as const;
export type McpHarness = typeof MCP_HARNESSES[number];

const name = z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Use 1–64 letters, digits, hyphens, or underscores')
  .refine((value) => value.toLowerCase() !== 'patterm', 'The name patterm is reserved for Patterm\'s own server');
const variableName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Environment variable names use letters, digits, and underscores');
const headerName = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, 'Invalid header name');
const text = (max: number, options: { trim?: boolean; min?: number } = {}) => {
  let schema = z.string();
  if (options.trim) schema = schema.trim();
  schema = schema.max(max);
  if (options.min) schema = schema.min(options.min);
  return schema.refine((value) => !value.includes('\0'), 'Must not contain NUL characters');
};
const httpUrl = z.string().trim().url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), 'Use an http or https URL');

const common = {
  id: z.string().min(1).max(200).optional(),
  name,
  harnesses: z.array(z.enum(MCP_HARNESSES)).max(MCP_HARNESSES.length).default([...MCP_HARNESSES]),
  enabled: z.boolean().default(true)
};

export const mcpServerInput = z.discriminatedUnion('transport', [
  z.object({
    ...common,
    transport: z.literal('stdio'),
    command: text(4096).refine((value) => value.trim().length > 0, 'Command is required'),
    args: z.array(text(4096)).max(100).default([]),
    env: z.record(variableName, text(8192)).default({})
  }).strict(),
  z.object({
    ...common,
    transport: z.literal('http'),
    url: httpUrl,
    headers: z.record(headerName, text(8192)).default({}),
    auth: z.enum(['none', 'oauth']).default('oauth'),
    oauth_client_id: text(512, { trim: true, min: 1 }).nullable().default(null),
    oauth_client_secret: text(1024, { min: 1 }).nullable().default(null),
    oauth_scopes: text(1024, { trim: true, min: 1 }).nullable().default(null)
  }).strict()
]);
export type McpServerInput = z.input<typeof mcpServerInput>;

interface McpServerBase {
  id: string;
  name: string;
  harnesses: McpHarness[];
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface McpStdioServer extends McpServerBase {
  transport: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface McpHttpServer extends McpServerBase {
  transport: 'http';
  url: string;
  headers: Record<string, string>;
  auth: 'none' | 'oauth';
  oauth_client_id: string | null;
  oauth_client_secret: string | null;
  oauth_scopes: string | null;
}

export type McpServer = McpStdioServer | McpHttpServer;

// What a launch needs: local servers run as configured; remote servers take
// their headers from Patterm (a helper or a bridge) when they have any.
export type McpLaunchServer =
  | { id: string; name: string; transport: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { id: string; name: string; transport: 'http'; url: string; managedHeaders: boolean };

interface Row {
  id: string; name: string; transport: 'stdio' | 'http'; command: string | null; args: string; env: string;
  url: string | null; headers: string; auth: 'none' | 'oauth'; oauth_client_id: string | null;
  oauth_client_secret: string | null; oauth_scopes: string | null; harnesses: string; enabled: number;
  created_at: string; updated_at: string;
}

export class McpServerRegistry {
  constructor(private readonly database: DatabaseService, private readonly now: () => Date = () => new Date()) {}

  list(): McpServer[] {
    const rows = this.database.connection.prepare('select * from mcp_servers order by name collate nocase').all() as unknown as Row[];
    return rows.map(toServer);
  }

  get(id: string): McpServer {
    const row = this.database.connection.prepare('select * from mcp_servers where id = ?').get(id) as unknown as Row | undefined;
    if (!row) throw new Error(`Unknown MCP server: ${id}`);
    return toServer(row);
  }

  findByName(serverName: string): McpServer | null {
    const row = this.database.connection.prepare('select * from mcp_servers where name = ? collate nocase').get(serverName) as unknown as Row | undefined;
    return row ? toServer(row) : null;
  }

  save(raw: unknown): McpServer {
    const input = mcpServerInput.parse(raw);
    const existing = input.id ? this.get(input.id) : null;
    const clash = this.findByName(input.name);
    if (clash && clash.id !== existing?.id) throw new Error(`An MCP server named ${input.name} already exists`);
    const now = this.now().toISOString();
    const id = existing?.id ?? `mcpsrv_${randomUUID()}`;
    const http = input.transport === 'http' ? input : null;
    const stdio = input.transport === 'stdio' ? input : null;
    const values = [
      input.name, input.transport, stdio?.command ?? null, JSON.stringify(stdio?.args ?? []), JSON.stringify(stdio?.env ?? {}),
      http?.url ?? null, JSON.stringify(http?.headers ?? {}), http?.auth ?? 'none', http?.oauth_client_id ?? null,
      http?.oauth_client_secret ?? null, http?.oauth_scopes ?? null, JSON.stringify(unique(input.harnesses)), input.enabled ? 1 : 0
    ];
    this.database.connection.transaction(() => {
      if (existing) {
        this.database.connection.prepare(`update mcp_servers set name = ?, transport = ?, command = ?, args = ?, env = ?, url = ?, headers = ?,
          auth = ?, oauth_client_id = ?, oauth_client_secret = ?, oauth_scopes = ?, harnesses = ?, enabled = ?, updated_at = ? where id = ?`)
          .run(...values, now, id);
        // A different endpoint or client needs a new sign-in.
        if (existing.transport !== input.transport || (existing.transport === 'http' && http
          && (existing.url !== http.url || existing.oauth_client_id !== http.oauth_client_id || existing.auth !== http.auth))) {
          this.database.connection.prepare('delete from mcp_server_credentials where server_id = ?').run(id);
        }
      } else {
        this.database.connection.prepare(`insert into mcp_servers (name, transport, command, args, env, url, headers, auth, oauth_client_id,
          oauth_client_secret, oauth_scopes, harnesses, enabled, id, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(...values, id, now, now);
      }
    })();
    return this.get(id);
  }

  delete(id: string): { deleted: boolean } {
    const result = this.database.connection.prepare('delete from mcp_servers where id = ?').run(id);
    return { deleted: Number(result.changes) > 0 };
  }

  // Enabled servers for one harness, in the shape launch plans use.
  forHarness(harness: string): McpLaunchServer[] {
    return this.list()
      .filter((server) => server.enabled && (server.harnesses as string[]).includes(harness))
      .map((server) => server.transport === 'stdio'
        ? { id: server.id, name: server.name, transport: 'stdio', command: server.command, args: server.args, env: server.env }
        : { id: server.id, name: server.name, transport: 'http', url: server.url, managedHeaders: server.auth === 'oauth' || Object.keys(server.headers).length > 0 });
  }
}

function toServer(row: Row): McpServer {
  const base = {
    id: row.id, name: row.name, harnesses: parseJson(row.harnesses, [] as McpHarness[]).filter((value) => (MCP_HARNESSES as readonly string[]).includes(value)),
    enabled: row.enabled === 1, created_at: row.created_at, updated_at: row.updated_at
  };
  if (row.transport === 'stdio') {
    return { ...base, transport: 'stdio', command: row.command ?? '', args: parseJson(row.args, [] as string[]), env: parseJson(row.env, {} as Record<string, string>) };
  }
  return {
    ...base, transport: 'http', url: row.url ?? '', headers: parseJson(row.headers, {} as Record<string, string>), auth: row.auth,
    oauth_client_id: row.oauth_client_id, oauth_client_secret: row.oauth_client_secret, oauth_scopes: row.oauth_scopes
  };
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
