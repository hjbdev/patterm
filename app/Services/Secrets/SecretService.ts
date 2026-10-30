import { randomUUID } from 'node:crypto';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import type { DatabaseService } from '../DatabaseService';
import type { SecretVault } from './SecretVault';

export type SecretKind = 'api_key' | 'login';
export type SecretUse = 'env' | 'proxy' | 'browser';
export type SecretField = 'value' | 'username' | 'password';

export const SECRET_USES: readonly SecretUse[] = ['env', 'proxy', 'browser'];
export const SECRET_NAME = /^[a-z][a-z0-9_]{0,63}$/;

// Where the proxy puts the credential on a request it forwards.
export interface SecretInjection {
  in: 'header' | 'query';
  name: string;
  prefix: string;
}

export const DEFAULT_INJECTION: SecretInjection = { in: 'header', name: 'Authorization', prefix: 'Bearer ' };

// What anyone may see: never the value.
export interface SecretRecord {
  id: string;
  project_id: string;
  session_id: string;
  name: string;
  kind: SecretKind;
  purpose: string;
  status: 'requested' | 'ready';
  allowed_hosts: string[];
  uses: SecretUse[];
  injection: SecretInjection | null;
  created_at: string;
  updated_at: string;
}

export type SecretValues = { value: string } | { username: string; password: string };

interface SecretRow {
  id: string;
  project_id: string;
  session_id: string;
  name: string;
  kind: SecretKind;
  purpose: string;
  status: 'requested' | 'ready';
  allowed_hosts: string;
  uses: string;
  injection: string | null;
  ciphertext: Uint8Array | null;
  created_at: string;
  updated_at: string;
}

export interface SecretRequestInput {
  name: string;
  kind: SecretKind;
  purpose: string;
  hosts: string[];
  uses: SecretUse[];
  injection: SecretInjection | null;
}

export interface SecretSaveInput {
  name: string;
  kind: SecretKind;
  values: SecretValues | null;
  allowed_hosts: string[];
  uses: SecretUse[];
  injection: SecretInjection | null;
}

export interface SecretServiceHooks {
  // A request is waiting for the user, or no longer is.
  requested(processId: string, secret: SecretRecord): void;
  settled(processId: string, secretId: string): void;
  messageAgent(processId: string, text: string): Promise<unknown>;
  // A fresh proxy base URL that stands in for `https://<host>/`.
  proxyUrl(secret: SecretRecord, host: string): string;
  changed(): void;
}

export interface LiveSession {
  id: string;
  project_id: string;
  process_id: string | null;
}

// Hostnames, optionally `*.` wildcards or with a port. No schemes or paths.
export function normaliseHost(raw: string): string {
  const host = raw.trim().toLowerCase().replace(/\.$/, '');
  if (!/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/.test(host)) throw new Error(`Not a hostname: ${raw}`);
  return host;
}

export function hostAllowed(allowed: readonly string[], host: string): boolean {
  const target = host.toLowerCase();
  const bare = target.replace(/:\d+$/, '');
  // An entry without a port allows any port on that host.
  return allowed.some((entry) => {
    const candidate = entry.includes(':') ? target : bare;
    return entry.startsWith('*.') ? candidate.endsWith(entry.slice(1)) : candidate === entry;
  });
}

export function fieldsOf(kind: SecretKind): SecretField[] {
  return kind === 'login' ? ['username', 'password'] : ['value'];
}

// Session-scoped secrets. The values stay in the vault and leave Patterm
// only for the uses the user allowed: a child process's environment, the
// egress proxy's outbound requests, or a field in the agent's browser.
export class SecretService {
  private known: string[] | null = null;

  constructor(
    private readonly database: DatabaseService,
    private readonly vault: SecretVault,
    private readonly hooks: SecretServiceHooks
  ) {}

  get keyringProtected(): boolean {
    return this.vault.protectedByKeyring;
  }

  liveSession(identity: string | null): LiveSession {
    const row = identity
      ? this.database.connection.prepare('select id, project_id, process_id from sessions where mcp_identity = ? and exited_at is null').get(identity) as LiveSession | undefined
      : undefined;
    if (!row) throw new Error('Secrets belong to a running Patterm agent');
    return row;
  }

  sessionForProcess(processId: string): LiveSession {
    const row = this.database.connection.prepare(`select id, project_id, process_id from sessions where process_id = ?
      order by exited_at is null desc, started_at desc limit 1`).get(processId) as LiveSession | undefined;
    if (!row) throw new Error('That agent has no session');
    return row;
  }

  list(sessionId: string): SecretRecord[] {
    return (this.database.connection.prepare('select * from session_secrets where session_id = ? order by created_at, rowid').all(sessionId) as unknown as SecretRow[]).map(toRecord);
  }

  get(id: string): SecretRecord {
    return toRecord(this.row(id));
  }

  request(session: LiveSession, input: SecretRequestInput): { secret: SecretRecord; created: boolean } {
    const db = this.database.connection;
    const existing = db.prepare('select * from session_secrets where session_id = ? and name = ?').get(session.id, input.name) as SecretRow | undefined;
    if (existing?.status === 'ready') return { secret: toRecord(existing), created: false };
    const at = new Date().toISOString();
    const hosts = unique(input.hosts.map(normaliseHost));
    const uses = unique(input.uses);
    if (existing) {
      db.prepare(`update session_secrets set kind = ?, purpose = ?, allowed_hosts = ?, uses = ?, injection = ?, updated_at = ? where id = ?`)
        .run(input.kind, input.purpose, JSON.stringify(hosts), JSON.stringify(uses), input.injection ? JSON.stringify(input.injection) : null, at, existing.id);
    } else {
      db.prepare(`insert into session_secrets (id, project_id, session_id, name, kind, purpose, status, allowed_hosts, uses, injection, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?)`)
        .run(`secret_${randomUUID()}`, session.project_id, session.id, input.name, input.kind, input.purpose, JSON.stringify(hosts), JSON.stringify(uses),
          input.injection ? JSON.stringify(input.injection) : null, at, at);
    }
    const secret = toRecord(db.prepare('select * from session_secrets where session_id = ? and name = ?').get(session.id, input.name) as unknown as SecretRow);
    if (session.process_id) this.hooks.requested(session.process_id, secret);
    this.hooks.changed();
    return { secret, created: !existing };
  }

  // The user fills a request, edits a secret, or adds one unasked. Leaving
  // values out keeps the stored ones.
  async save(session: LiveSession, id: string | null, input: SecretSaveInput): Promise<SecretRecord> {
    if (!SECRET_NAME.test(input.name)) throw new Error('Names use lower-case letters, digits and underscores');
    const uses = unique(input.uses);
    const hosts = unique(input.allowed_hosts.map(normaliseHost));
    if (uses.includes('proxy') && !hosts.length) throw new Error('The proxy needs at least one allowed host');
    if (uses.includes('browser') && !hosts.length) throw new Error('Browser filling needs at least one allowed site');
    if (uses.includes('proxy') && input.kind !== 'api_key') throw new Error('Only API keys go through the proxy');
    const db = this.database.connection;
    const previous = id ? this.row(id) : null;
    if (previous && previous.session_id !== session.id) throw new Error('That secret belongs to another session');
    const secretId = previous?.id ?? `secret_${randomUUID()}`;
    let ciphertext = previous?.ciphertext ?? null;
    if (input.values) ciphertext = this.vault.seal(secretId, JSON.stringify(checkValues(input.kind, input.values)));
    else if (!ciphertext || previous?.kind !== input.kind) throw new Error('Enter the secret');
    const at = new Date().toISOString();
    const chosen = input.injection ?? DEFAULT_INJECTION;
    if (uses.includes('proxy') && chosen.in === 'header') {
      const values = JSON.parse(this.vault.open(secretId, ciphertext)) as { value?: string };
      checkHeader(chosen, values.value ?? '');
    }
    const injection = uses.includes('proxy') ? JSON.stringify(chosen) : null;
    if (previous) {
      db.prepare(`update session_secrets set name = ?, kind = ?, status = 'ready', allowed_hosts = ?, uses = ?, injection = ?, ciphertext = ?, updated_at = ? where id = ?`)
        .run(input.name, input.kind, JSON.stringify(hosts), JSON.stringify(uses), injection, ciphertext, at, secretId);
    } else {
      db.prepare(`insert into session_secrets (id, project_id, session_id, name, kind, purpose, status, allowed_hosts, uses, injection, ciphertext, created_at, updated_at)
        values (?, ?, ?, ?, ?, '', 'ready', ?, ?, ?, ?, ?, ?)`)
        .run(secretId, session.project_id, session.id, input.name, input.kind, JSON.stringify(hosts), JSON.stringify(uses), injection, ciphertext, at, at);
    }
    this.known = null;
    const secret = this.get(secretId);
    if (session.process_id) {
      this.hooks.settled(session.process_id, secretId);
      const lead = previous?.status === 'requested' ? `The user provided the secret "${secret.name}".`
        : previous ? `The user updated the secret "${secret.name}".` : `The user gave you a secret, "${secret.name}".`;
      await this.hooks.messageAgent(session.process_id, `[secrets] ${lead} ${this.usage(secret).join(' ')}`).catch(() => undefined);
    }
    this.hooks.changed();
    return secret;
  }

  // Declining a request or forgetting a secret deletes it.
  async remove(id: string, note?: string): Promise<void> {
    const row = this.row(id);
    this.database.connection.prepare('delete from session_secrets where id = ?').run(id);
    this.known = null;
    const live = this.database.connection.prepare('select process_id from sessions where id = ? and exited_at is null').get(row.session_id) as { process_id: string | null } | undefined;
    if (live?.process_id) {
      this.hooks.settled(live.process_id, id);
      const lead = row.status === 'requested' ? `The user declined your request for the secret "${row.name}".` : `The user removed the secret "${row.name}"; it no longer works.`;
      await this.hooks.messageAgent(live.process_id, `[secrets] ${lead}${note ? ` ${note}` : ''}`).catch(() => undefined);
    }
    this.hooks.changed();
  }

  // One field of a ready secret, for a use the user allowed.
  reveal(sessionId: string, name: string, use: SecretUse, field?: SecretField): { secret: SecretRecord; value: string } {
    const row = this.database.connection.prepare('select * from session_secrets where session_id = ? and name = ?').get(sessionId, name) as SecretRow | undefined;
    if (!row) throw new Error(`No secret named "${name}" in this session. Ask for it with secret_request.`);
    const secret = toRecord(row);
    if (secret.status !== 'ready' || !row.ciphertext) throw new Error(`The secret "${name}" is waiting for the user`);
    if (!secret.uses.includes(use)) throw new Error(`The user did not allow "${name}" ${USE_LABEL[use]}`);
    const fields = fieldsOf(secret.kind);
    const chosen = field ?? fields[fields.length - 1]!;
    if (!fields.includes(chosen)) throw new Error(`"${name}" has no ${chosen}; its fields are ${fields.join(' and ')}`);
    const values = JSON.parse(this.vault.open(row.id, row.ciphertext)) as Record<string, string>;
    return { secret, value: values[chosen]! };
  }

  // `patterm-secret`'s view: values by `name` or `name.field`, for the
  // caller's live session.
  envValues(identity: string | null, refs: string[]): string[] {
    const session = this.liveSession(identity);
    return refs.map((ref) => {
      const [name, field] = ref.split('.', 2) as [string, SecretField?];
      return this.reveal(session.id, name, 'env', field).value;
    });
  }

  // `patterm-secret run --url`'s view: proxy URLs by `name` or `name@host`.
  // They go only to the command's environment, never to a conversation.
  proxyUrls(identity: string | null, refs: string[]): string[] {
    const session = this.liveSession(identity);
    return refs.map((ref) => {
      const [name, requested] = ref.split('@', 2) as [string, string?];
      const { secret } = this.reveal(session.id, name, 'proxy');
      const host = requested ? normaliseHost(requested) : secret.allowed_hosts.length === 1 && !secret.allowed_hosts[0]!.startsWith('*.') ? secret.allowed_hosts[0]! : null;
      if (!host) throw new Error(`"${name}" allows ${secret.allowed_hosts.join(', ')}; name one as ${name}@<host>`);
      if (host.startsWith('*.') || !hostAllowed(secret.allowed_hosts, host)) throw new Error(`The user allowed "${name}" only for ${secret.allowed_hosts.join(', ')}`);
      return this.hooks.proxyUrl(secret, host);
    });
  }

  // The proxy's view: a ready secret of a live session that allows it.
  proxyCredential(id: string): { secret: SecretRecord; value: string } {
    const row = this.database.connection.prepare(`select s.* from session_secrets s join sessions x on x.id = s.session_id
      where s.id = ? and x.exited_at is null`).get(id) as SecretRow | undefined;
    if (!row) throw new Error('This secret is gone or its agent has stopped');
    return this.reveal(row.session_id, row.name, 'proxy');
  }

  // Every stored value, so transcripts and summaries can mask them.
  knownValues(): string[] {
    if (this.known) return this.known;
    const rows = this.database.connection.prepare(`select id, ciphertext from session_secrets where status = 'ready' and ciphertext is not null`).all() as Array<{ id: string; ciphertext: Uint8Array }>;
    const values = new Set<string>();
    for (const row of rows) {
      try {
        for (const value of Object.values(JSON.parse(this.vault.open(row.id, row.ciphertext)) as Record<string, string>)) {
          if (value.length >= MASK_MIN_LENGTH) values.add(value);
        }
      } catch {
        // An unreadable secret can't leak either.
      }
    }
    this.known = [...values];
    return this.known;
  }

  // How the agent uses a ready secret, given in its messages and listings.
  usage(secret: SecretRecord): string[] {
    if (secret.status !== 'ready') return ['The user has not filled it in yet; you will get a message when they do.'];
    const lines: string[] = [];
    const env = secret.name.toUpperCase();
    if (secret.uses.includes('env')) {
      lines.push(secret.kind === 'login'
        ? `Run a command with it: \`patterm-secret run --env ${env}_USER=${secret.name}.username --env ${env}_PASSWORD=${secret.name}.password -- <command>\`.`
        : `Run a command with it: \`patterm-secret run --env ${env}=${secret.name} -- <command>\`, or write it to a git-excluded file with \`patterm-secret write .env.local ${env}=${secret.name}\`. Output that contains it is masked.`);
    }
    if (secret.uses.includes('proxy')) {
      const [host] = secret.allowed_hosts;
      const ref = secret.allowed_hosts.length === 1 && !host!.startsWith('*.') ? secret.name : `${secret.name}@<host>`;
      lines.push(`Call ${secret.allowed_hosts.join(', ')} through Patterm's proxy, which adds the credential: \`patterm-secret run --url ${env}_URL=${ref} -- <command>\` sets ${env}_URL to a local address that stands in for https://<host>/. Use it as the API's base URL and leave out your own authentication.`);
    }
    if (secret.uses.includes('browser')) {
      lines.push(`Fill it into a page on ${secret.allowed_hosts.join(', ')} with browser_fill_secret.`);
    }
    return lines;
  }

  private row(id: string): SecretRow {
    const row = this.database.connection.prepare('select * from session_secrets where id = ?').get(id) as SecretRow | undefined;
    if (!row) throw new Error('That secret no longer exists');
    return row;
  }
}

const USE_LABEL: Record<SecretUse, string> = {
  env: 'in commands (patterm-secret)',
  proxy: 'through the proxy',
  browser: 'in the browser'
};

// Shorter values would mask ordinary words in transcripts.
const MASK_MIN_LENGTH = 6;

// The proxy sends it as a header, which can't hold line breaks or other
// control characters.
function checkHeader(injection: SecretInjection, value: string): void {
  try {
    validateHeaderName(injection.name);
    validateHeaderValue(injection.name, `${injection.prefix}${value}`);
  } catch {
    throw new Error('That value or prefix can\'t go in an HTTP header. Remove line breaks and control characters, or send it as a query parameter.');
  }
}

function checkValues(kind: SecretKind, values: SecretValues): SecretValues {
  if (kind === 'login') {
    if (!('username' in values) || !values.password) throw new Error('Enter the username and password');
    return { username: values.username, password: values.password };
  }
  if (!('value' in values) || !values.value) throw new Error('Enter the secret');
  return { value: values.value };
}

function toRecord(row: SecretRow): SecretRecord {
  return {
    id: row.id,
    project_id: row.project_id,
    session_id: row.session_id,
    name: row.name,
    kind: row.kind,
    purpose: row.purpose,
    status: row.status,
    allowed_hosts: JSON.parse(row.allowed_hosts) as string[],
    uses: JSON.parse(row.uses) as SecretUse[],
    injection: row.injection ? JSON.parse(row.injection) as SecretInjection : null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
