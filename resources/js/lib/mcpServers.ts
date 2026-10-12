import { computed, readonly, ref, shallowRef } from 'vue';
import { useContextRefresh } from './projectContext';

export type McpHarness = 'claude' | 'codex' | 'opencode';
export const MCP_HARNESSES: readonly McpHarness[] = ['claude', 'codex', 'opencode'];

export interface McpSignInPending { authorization_url: string; redirect_uri: string; loopback: boolean }
export interface McpSignInState { signed_in: boolean; expires_at: string | null; pending: McpSignInPending | null }

interface McpServerCommon {
  id: string;
  name: string;
  harnesses: McpHarness[];
  enabled: boolean;
  created_at: string;
  updated_at: string;
  sign_in: McpSignInState | null;
}
export interface McpStdioServer extends McpServerCommon {
  transport: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
}
export interface McpHttpServer extends McpServerCommon {
  transport: 'http';
  url: string;
  headers: Record<string, string>;
  auth: 'none' | 'oauth';
  oauth_client_id: string | null;
  oauth_client_secret: string | null;
  oauth_scopes: string | null;
}
export type McpServerView = McpStdioServer | McpHttpServer;
export type McpRedirectMode = 'origin' | 'loopback';

export interface McpImportResult {
  added: { name: string; from: McpHarness[] }[];
  skipped: { harness: string | null; name: string; reason: string }[];
}
export interface McpTestResult { ok: boolean; tools: string[]; error: string | null }
export type McpTestState = { status: 'running' } | { status: 'done'; result: McpTestResult };

export interface KeyValueRow { key: string; value: string }
export interface McpServerDraft {
  id: string | null;
  name: string;
  transport: 'stdio' | 'http';
  url: string;
  auth: 'none' | 'oauth';
  headers: KeyValueRow[];
  oauthClientId: string;
  oauthClientSecret: string;
  oauthScopes: string;
  command: string;
  args: string;
  env: KeyValueRow[];
  harnesses: McpHarness[];
  enabled: boolean;
}

export function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function call<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
  return window.patterm.call(tool, args) as Promise<T>;
}

// One list is shared by every view. Other clients catch up through the
// change that saving and sign-in announce.
const servers = shallowRef<McpServerView[]>([]);
const redirect = ref<McpRedirectMode>('loopback');
const loaded = ref(false);
const listError = ref('');
const tests = shallowRef<Record<string, McpTestState>>({});
let listRequest: Promise<void> | null = null;

export function loadMcpServers(): Promise<void> {
  listRequest ??= call<{ servers: McpServerView[]; redirect: McpRedirectMode }>('mcp_servers_list')
    .then((value) => {
      servers.value = value.servers;
      redirect.value = value.redirect;
      listError.value = '';
    })
    .catch((caught) => { listError.value = errorMessage(caught); })
    .finally(() => { loaded.value = true; listRequest = null; });
  return listRequest;
}

export function useMcpServers() {
  useContextRefresh(() => void loadMcpServers(), { topics: ['mcp-servers'] });
  void loadMcpServers();
  return {
    servers: computed(() => servers.value),
    redirect: readonly(redirect),
    loaded: readonly(loaded),
    error: readonly(listError),
    tests: computed(() => tests.value)
  };
}

export async function saveMcpServer(draft: McpServerDraft): Promise<McpServerView> {
  const saved = await call<McpServerView>('mcp_servers_save', payloadFromDraft(draft));
  await loadMcpServers();
  return saved;
}

export async function setMcpServerEnabled(server: McpServerView, enabled: boolean): Promise<void> {
  await call('mcp_servers_save', { ...payloadFromDraft(draftFromServer(server)), enabled });
  await loadMcpServers();
}

export async function deleteMcpServer(id: string): Promise<void> {
  await call('mcp_servers_delete', { id });
  const { [id]: _removed, ...rest } = tests.value;
  tests.value = rest;
  await loadMcpServers();
}

export async function importMcpServers(): Promise<McpImportResult> {
  const result = await call<McpImportResult>('mcp_servers_import');
  await loadMcpServers();
  return result;
}

export async function testMcpServer(id: string): Promise<void> {
  tests.value = { ...tests.value, [id]: { status: 'running' } };
  let result: McpTestResult;
  try {
    result = await call<McpTestResult>('mcp_servers_test', { id });
  } catch (caught) {
    result = { ok: false, tools: [], error: errorMessage(caught) };
  }
  tests.value = { ...tests.value, [id]: { status: 'done', result } };
}

// Opens the service's sign-in page. With `loopback`, the service sends the
// browser to a local address that the user pastes back into Patterm.
export async function startMcpSignIn(id: string, via: 'auto' | 'loopback' = 'auto'): Promise<void> {
  const started = await call<{ authorization_url: string | null; signed_in: boolean }>('mcp_servers_signin_start', { id, via });
  if (started.authorization_url) openSignInPage(started.authorization_url);
  await loadMcpServers();
}

export function openSignInPage(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

export async function completeMcpSignIn(url: string): Promise<string> {
  const result = await call<{ server_id: string; name: string }>('mcp_servers_signin_complete', { url: url.trim() });
  await loadMcpServers();
  return result.name;
}

export async function cancelMcpSignIn(id: string): Promise<void> {
  await call('mcp_servers_signin_cancel', { id });
  await loadMcpServers();
}

export async function signOutMcpServer(id: string): Promise<void> {
  await call('mcp_servers_signout', { id });
  await loadMcpServers();
}

export function newMcpServerDraft(): McpServerDraft {
  return {
    id: null,
    name: '',
    transport: 'http',
    url: '',
    auth: 'oauth',
    headers: [],
    oauthClientId: '',
    oauthClientSecret: '',
    oauthScopes: '',
    command: '',
    args: '',
    env: [],
    harnesses: [...MCP_HARNESSES],
    enabled: true
  };
}

function rowsFromRecord(record: Record<string, string>): KeyValueRow[] {
  return Object.entries(record).map(([key, value]) => ({ key, value }));
}

function recordFromRows(rows: KeyValueRow[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key) record[key] = row.value;
  }
  return record;
}

export function draftFromServer(server: McpServerView): McpServerDraft {
  const draft = { ...newMcpServerDraft(), id: server.id, name: server.name, transport: server.transport, harnesses: [...server.harnesses], enabled: server.enabled };
  if (server.transport === 'http') {
    return {
      ...draft,
      url: server.url,
      auth: server.auth,
      headers: rowsFromRecord(server.headers),
      oauthClientId: server.oauth_client_id ?? '',
      oauthClientSecret: server.oauth_client_secret ?? '',
      oauthScopes: server.oauth_scopes ?? ''
    };
  }
  return { ...draft, command: server.command, args: server.args.join('\n'), env: rowsFromRecord(server.env) };
}

const optional = (value: string): string | null => value.trim() || null;

// Arguments are one per line, so an argument can contain spaces.
export function payloadFromDraft(draft: McpServerDraft): Record<string, unknown> {
  const common = {
    ...(draft.id ? { id: draft.id } : {}),
    name: draft.name.trim(),
    harnesses: [...draft.harnesses],
    enabled: draft.enabled
  };
  if (draft.transport === 'http') {
    return {
      ...common,
      transport: 'http',
      url: draft.url.trim(),
      headers: recordFromRows(draft.headers),
      auth: draft.auth,
      oauth_client_id: draft.auth === 'oauth' ? optional(draft.oauthClientId) : null,
      oauth_client_secret: draft.auth === 'oauth' ? optional(draft.oauthClientSecret) : null,
      oauth_scopes: draft.auth === 'oauth' ? optional(draft.oauthScopes) : null
    };
  }
  return {
    ...common,
    transport: 'stdio',
    command: draft.command.trim(),
    args: draft.args.split(/\r?\n/).filter((line) => line.trim()),
    env: recordFromRows(draft.env)
  };
}

export function mcpServerSummary(server: McpServerView): string {
  return server.transport === 'http' ? server.url : [server.command, ...server.args].join(' ');
}

export type McpSignInStatus = 'signed-in' | 'signed-out' | 'pending' | null;

export function mcpSignInStatus(server: McpServerView): McpSignInStatus {
  if (!server.sign_in) return null;
  if (server.sign_in.pending) return 'pending';
  return server.sign_in.signed_in ? 'signed-in' : 'signed-out';
}
