import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import type { McpHarness, McpServerInput, McpServerRegistry } from './McpServerRegistry';

// Reads each harness's own MCP configuration and adds servers the registry
// does not have yet. Source files are never modified.

export interface McpImportCandidate {
  harness: McpHarness;
  source: string;
  input: McpServerInput;
}

export interface McpImportSkip {
  harness: McpHarness | null;
  name: string;
  reason: string;
}

export interface McpImportResult {
  added: Array<{ name: string; from: McpHarness[] }>;
  skipped: McpImportSkip[];
}

export interface McpImportOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
}

// Earlier harnesses win when two define the same name differently.
const ORDER: McpHarness[] = ['claude', 'codex', 'opencode', 'amp'];

export class McpServerImportService {
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly registry: Pick<McpServerRegistry, 'findByName' | 'save'>, options: McpImportOptions = {}) {
    this.env = options.env ?? process.env;
    this.home = options.home ?? this.env.HOME ?? os.homedir();
  }

  discover(): { candidates: McpImportCandidate[]; skipped: McpImportSkip[] } {
    const candidates: McpImportCandidate[] = [];
    const skipped: McpImportSkip[] = [];
    const add = (harness: McpHarness, source: string, name: string, entry: unknown) => {
      try {
        const input = convert(harness, name, entry, this.env);
        if (typeof input === 'string') skipped.push({ harness, name, reason: input });
        else candidates.push({ harness, source, input });
      } catch (error) {
        skipped.push({ harness, name, reason: error instanceof Error ? error.message : String(error) });
      }
    };
    const configHome = this.env.XDG_CONFIG_HOME || path.join(this.home, '.config');

    const claudePath = path.join(this.home, '.claude.json');
    const claude = readJson(claudePath);
    for (const [name, entry] of Object.entries(record(claude?.mcpServers))) add('claude', claudePath, name, entry);
    for (const [project, value] of Object.entries(record(claude?.projects))) {
      for (const name of Object.keys(record(record(value).mcpServers))) {
        skipped.push({ harness: 'claude', name, reason: `Only configured for ${project}; Patterm servers are global` });
      }
    }

    const codexPath = path.join(this.env.CODEX_HOME || path.join(this.home, '.codex'), 'config.toml');
    const codex = readToml(codexPath);
    for (const [name, entry] of Object.entries(record(codex?.mcp_servers))) add('codex', codexPath, name, entry);

    for (const file of ['opencode.jsonc', 'opencode.json', 'config.json']) {
      const openCodePath = path.join(configHome, 'opencode', file);
      const openCode = readJson(openCodePath);
      if (!openCode) continue;
      const mcp = record(openCode.mcp);
      // OpenCode 2 nests servers under mcp.servers and still accepts mcp.NAME.
      for (const [name, entry] of Object.entries(record(mcp.servers))) add('opencode', openCodePath, name, entry);
      for (const [name, entry] of Object.entries(mcp)) {
        if (name !== 'servers' && name !== 'timeout' && record(entry).type) add('opencode', openCodePath, name, entry);
      }
      break;
    }

    for (const file of ['settings.json', 'settings.jsonc']) {
      const ampPath = path.join(configHome, 'amp', file);
      const amp = readJson(ampPath);
      if (!amp) continue;
      for (const [name, entry] of Object.entries(record(amp['amp.mcpServers']))) add('amp', ampPath, name, entry);
      break;
    }
    return { candidates, skipped };
  }

  import(): McpImportResult {
    const { candidates, skipped } = this.discover();
    const byName = new Map<string, McpImportCandidate[]>();
    for (const candidate of candidates) {
      const key = candidate.input.name.toLowerCase();
      byName.set(key, [...(byName.get(key) ?? []), candidate]);
    }
    const added: McpImportResult['added'] = [];
    for (const group of byName.values()) {
      group.sort((left, right) => ORDER.indexOf(left.harness) - ORDER.indexOf(right.harness));
      const [chosen, ...others] = group as [McpImportCandidate, ...McpImportCandidate[]];
      const name = chosen.input.name;
      if (this.registry.findByName(name)) {
        skipped.push({ harness: null, name, reason: 'Already in Patterm' });
        continue;
      }
      const from = [chosen.harness];
      for (const other of others) {
        if (sameEndpoint(chosen.input, other.input)) from.push(other.harness);
        else skipped.push({ harness: other.harness, name, reason: `Differs from the ${chosen.harness} definition, which was imported` });
      }
      try {
        this.registry.save(chosen.input);
        added.push({ name, from: [...new Set(from)] });
      } catch (error) {
        skipped.push({ harness: chosen.harness, name, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { added, skipped };
  }
}

// Returns a registry input, or a reason the entry cannot be imported.
function convert(harness: McpHarness, name: string, raw: unknown, env: NodeJS.ProcessEnv): McpServerInput | string {
  const entry = record(raw);
  let command: string | null = null;
  let args: string[] = [];
  let environment: Record<string, string> = {};
  let url: string | null = null;
  let headers: Record<string, string> = {};

  if (harness === 'opencode') {
    if (entry.type === 'local') {
      const parts = strings(entry.command);
      command = parts[0] ?? null;
      args = parts.slice(1);
      environment = stringRecord(entry.environment);
    } else if (entry.type === 'remote') {
      url = string(entry.url);
      headers = stringRecord(entry.headers);
    }
  } else {
    command = string(entry.command);
    args = strings(entry.args);
    environment = stringRecord(entry.env);
    url = string(entry.url);
    headers = stringRecord(harness === 'codex' ? entry.http_headers : entry.headers);
    if (harness === 'claude' && (entry.type === 'sse' || entry.type === 'ws')) return `${String(entry.type).toUpperCase()} servers are not supported by every harness`;
    if (harness === 'codex') {
      for (const [header, variable] of Object.entries(stringRecord(entry.env_http_headers))) {
        const value = env[variable];
        if (value === undefined) return `Header ${header} reads ${variable}, which is not set`;
        headers[header] = value;
      }
      const bearer = string(entry.bearer_token_env_var);
      if (bearer) {
        const value = env[bearer];
        if (value === undefined) return `The bearer token variable ${bearer} is not set`;
        headers.Authorization = `Bearer ${value}`;
      }
      for (const variable of strings(entry.env_vars)) {
        const value = env[variable];
        if (value !== undefined) environment[variable] = value;
      }
    }
  }

  const enabled = entry.enabled !== false && entry.disabled !== true;
  if (command) return { name, transport: 'stdio', command, args, env: environment, enabled };
  if (url) {
    const hasAuthorization = Object.keys(headers).some((header) => header.toLowerCase() === 'authorization');
    return { name, transport: 'http', url, headers, auth: hasAuthorization ? 'none' : 'oauth', enabled };
  }
  return 'Has neither a command nor a URL';
}

function sameEndpoint(left: McpServerInput, right: McpServerInput): boolean {
  if (left.transport === 'http' && right.transport === 'http') return left.url === right.url;
  if (left.transport === 'stdio' && right.transport === 'stdio') return left.command === right.command && JSON.stringify(left.args ?? []) === JSON.stringify(right.args ?? []);
  return false;
}

function readJson(filename: string): Record<string, unknown> | null {
  try { return record(parseJsonc(fs.readFileSync(filename, 'utf8'))); } catch { return null; }
}

function readToml(filename: string): Record<string, unknown> | null {
  try { return record(parseToml(fs.readFileSync(filename, 'utf8'))); } catch { return null; }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}
