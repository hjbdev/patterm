import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  auth,
  type FetchLike,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens
} from '@modelcontextprotocol/client';
import type { DatabaseService } from './DatabaseService';
import type { McpHttpServer, McpServerRegistry } from './McpServerRegistry';

// Patterm is the OAuth client for remote MCP servers, so each server is signed
// in to once and every harness reuses the token. The SDK's auth() does
// discovery, registration, PKCE, resource indicators, and refresh; this service
// stores the results and owns the redirect.

const SIGN_IN_TTL_MS = 10 * 60_000;
// Refresh a little early so a token does not expire mid-request.
const EXPIRY_MARGIN_MS = 60_000;
export const MCP_OAUTH_CALLBACK_PATH = '/oauth/mcp/callback';

export class McpSignInRequiredError extends Error {
  constructor(serverName: string) {
    super(`Sign in to ${serverName} in Settings → MCP servers`);
  }
}

type StoredTokens = StoredOAuthTokens & { expires_at?: number };

interface CredentialRow {
  redirect_uri: string | null;
  client_information: string | null;
  tokens: string | null;
  discovery_state: string | null;
}

interface PendingSignIn {
  state: string;
  serverId: string;
  redirectUri: string;
  verifier: string;
  authorizationUrl: URL | null;
  expiresAt: number;
  listener: http.Server | null;
}

export interface McpSignInStatus {
  signed_in: boolean;
  expires_at: string | null;
  pending: { authorization_url: string; redirect_uri: string; loopback: boolean } | null;
}

export interface McpSignInStart {
  server_id: string;
  authorization_url: string | null;
  redirect_uri: string;
  // A loopback redirect only completes on its own on the machine running
  // Patterm; elsewhere the browser shows an error and the URL is pasted back.
  loopback: boolean;
  signed_in: boolean;
}

export interface McpOAuthOptions {
  // Browser-server origin. Its callback route receives redirects directly.
  publicOrigin?: string | null;
  fetchFn?: FetchLike;
  now?: () => number;
  onChanged?: () => void;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export class McpOAuthService {
  private readonly pending = new Map<string, PendingSignIn>();
  private readonly refreshing = new Map<string, Promise<void>>();
  private readonly now: () => number;

  constructor(
    private readonly database: DatabaseService,
    private readonly registry: Pick<McpServerRegistry, 'get'>,
    private readonly options: McpOAuthOptions = {}
  ) {
    this.now = options.now ?? Date.now;
  }

  status(serverId: string): McpSignInStatus {
    this.expirePending();
    const tokens = this.readTokens(serverId);
    const flow = [...this.pending.values()].find((candidate) => candidate.serverId === serverId && candidate.authorizationUrl);
    return {
      signed_in: Boolean(tokens?.access_token),
      expires_at: tokens?.expires_at ? new Date(tokens.expires_at).toISOString() : null,
      pending: flow ? { authorization_url: flow.authorizationUrl!.href, redirect_uri: flow.redirectUri, loopback: isLoopback(flow.redirectUri) } : null
    };
  }

  async startSignIn(serverId: string, via: 'auto' | 'loopback' = 'auto'): Promise<McpSignInStart> {
    const server = this.oauthServer(serverId);
    this.cancelSignIn(serverId);
    const useOrigin = via === 'auto' && Boolean(this.options.publicOrigin);
    const flow: PendingSignIn = {
      state: randomBytes(24).toString('base64url'),
      serverId,
      redirectUri: useOrigin ? new URL(MCP_OAUTH_CALLBACK_PATH, this.options.publicOrigin!).href : '',
      verifier: '',
      authorizationUrl: null,
      expiresAt: this.now() + SIGN_IN_TTL_MS,
      listener: null
    };
    if (!useOrigin) {
      const listener = await this.listenLoopback(serverId);
      flow.listener = listener.server;
      flow.redirectUri = listener.redirectUri;
    }
    this.pending.set(flow.state, flow);
    try {
      const result = await auth(this.provider(server, flow.redirectUri, flow), {
        serverUrl: server.url,
        forceReauthorization: true,
        ...(server.oauth_scopes ? { scope: server.oauth_scopes } : {}),
        ...(this.options.fetchFn ? { fetchFn: this.options.fetchFn } : {})
      });
      if (result === 'AUTHORIZED') {
        this.finish(flow);
        this.options.onChanged?.();
        return { server_id: serverId, authorization_url: null, redirect_uri: flow.redirectUri, loopback: isLoopback(flow.redirectUri), signed_in: true };
      }
      if (!flow.authorizationUrl) throw new Error(`${server.name} did not return a sign-in URL`);
      this.options.onChanged?.();
      return { server_id: serverId, authorization_url: flow.authorizationUrl.href, redirect_uri: flow.redirectUri, loopback: isLoopback(flow.redirectUri), signed_in: false };
    } catch (error) {
      this.finish(flow);
      throw error;
    }
  }

  // True when a pasted or redirected URL answers a sign-in in progress.
  matches(rawUrl: string): boolean {
    this.expirePending();
    const url = safeUrl(rawUrl);
    const flow = url ? this.pending.get(url.searchParams.get('state') ?? '') : undefined;
    return Boolean(url && flow && sameEndpoint(url, flow.redirectUri));
  }

  async completeSignIn(rawUrl: string): Promise<{ server_id: string; name: string }> {
    this.expirePending();
    const url = safeUrl(rawUrl.trim());
    if (!url) throw new Error('Paste the full address from the browser, starting with http');
    const flow = this.pending.get(url.searchParams.get('state') ?? '');
    if (!flow || !sameEndpoint(url, flow.redirectUri)) throw new Error('That address does not belong to a sign-in in progress. Start the sign-in again.');
    // One attempt per sign-in: a code is single use.
    this.finish(flow);
    const server = this.oauthServer(flow.serverId);
    const error = url.searchParams.get('error');
    if (error) {
      this.options.onChanged?.();
      throw new Error(`${server.name} did not complete the sign-in: ${url.searchParams.get('error_description') ?? error}`);
    }
    const code = url.searchParams.get('code');
    if (!code) throw new Error('The address has no authorization code');
    try {
      const iss = url.searchParams.get('iss');
      const result = await auth(this.provider(server, flow.redirectUri, flow), {
        serverUrl: server.url,
        authorizationCode: code,
        ...(iss ? { iss } : {}),
        ...(this.options.fetchFn ? { fetchFn: this.options.fetchFn } : {})
      });
      if (result !== 'AUTHORIZED') throw new Error(`${server.name} did not issue a token`);
    } finally {
      this.options.onChanged?.();
    }
    this.options.log?.('signin.completed', { server_id: server.id });
    return { server_id: server.id, name: server.name };
  }

  cancelSignIn(serverId: string): void {
    for (const flow of [...this.pending.values()]) if (flow.serverId === serverId) this.finish(flow);
  }

  signOut(serverId: string): { signed_out: true } {
    this.cancelSignIn(serverId);
    this.database.connection.prepare('delete from mcp_server_credentials where server_id = ?').run(serverId);
    this.options.onChanged?.();
    return { signed_out: true };
  }

  // Headers for one request to a remote server: its static headers plus a
  // current access token. `rejected` is a token the server just refused.
  async headers(serverId: string, rejected?: string | null): Promise<Record<string, string>> {
    const server = this.registry.get(serverId);
    if (server.transport !== 'http') throw new Error(`${server.name} is not a remote server`);
    if (server.auth !== 'oauth') return { ...server.headers };
    let tokens = this.readTokens(serverId);
    if (tokens && (tokens.access_token === rejected || this.expired(tokens))) {
      const refreshing = this.refresh(server);
      // A token inside its expiry margin still works, so a slow authorization
      // server refreshes behind it instead of stalling harness startup.
      if (tokens.access_token === rejected || this.expired(tokens, 0)) {
        await refreshing;
        tokens = this.readTokens(serverId);
      }
    }
    // Without a token the request goes out unauthenticated and the harness
    // reports that the server needs a sign-in.
    return tokens?.access_token ? { ...server.headers, Authorization: `Bearer ${tokens.access_token}` } : { ...server.headers };
  }

  dispose(): void {
    for (const flow of [...this.pending.values()]) this.finish(flow);
  }

  // Only Patterm refreshes, one refresh per server at a time, because a
  // public client's refresh token changes on every use.
  private refresh(server: McpHttpServer): Promise<void> {
    const running = this.refreshing.get(server.id);
    if (running) return running;
    const redirectUri = this.credentials(server.id)?.redirect_uri;
    const attempt = (async () => {
      if (!redirectUri) return;
      try {
        await auth(this.provider(server, redirectUri, null), {
          serverUrl: server.url,
          ...(this.options.fetchFn ? { fetchFn: this.options.fetchFn } : {})
        });
      } catch (error) {
        this.options.log?.('refresh.failed', { server_id: server.id, message: error instanceof Error ? error.message : String(error) });
        if (error instanceof McpSignInRequiredError) this.options.onChanged?.();
      }
    })().finally(() => this.refreshing.delete(server.id));
    this.refreshing.set(server.id, attempt);
    return attempt;
  }

  private expired(tokens: StoredTokens, margin = EXPIRY_MARGIN_MS): boolean {
    return typeof tokens.expires_at === 'number' && tokens.expires_at - margin <= this.now();
  }

  private oauthServer(serverId: string): McpHttpServer {
    const server = this.registry.get(serverId);
    if (server.transport !== 'http' || server.auth !== 'oauth') throw new Error(`${server.name} does not use OAuth`);
    return server;
  }

  private provider(server: McpHttpServer, redirectUri: string, flow: PendingSignIn | null): OAuthClientProvider {
    const store = this;
    return {
      get redirectUrl() { return redirectUri; },
      get clientMetadata(): OAuthClientMetadata {
        return {
          client_name: 'Patterm',
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: server.oauth_client_secret ? 'client_secret_post' : 'none',
          ...(server.oauth_scopes ? { scope: server.oauth_scopes } : {}),
          // A loopback redirect is a native client; the server origin is a web app.
          application_type: isLoopback(redirectUri) ? 'native' : 'web'
        } as OAuthClientMetadata;
      },
      state: () => {
        if (!flow) throw new McpSignInRequiredError(server.name);
        return flow.state;
      },
      clientInformation: () => {
        if (server.oauth_client_id) {
          return { client_id: server.oauth_client_id, ...(server.oauth_client_secret ? { client_secret: server.oauth_client_secret } : {}) };
        }
        // A registration is only valid for the redirect it was made with.
        const row = store.credentials(server.id);
        if (!row?.client_information || row.redirect_uri !== redirectUri) return undefined;
        return JSON.parse(row.client_information) as StoredOAuthClientInformation;
      },
      saveClientInformation: (information: StoredOAuthClientInformation) => {
        store.writeCredentials(server.id, { client_information: JSON.stringify(information), redirect_uri: redirectUri });
      },
      tokens: () => store.readTokens(server.id),
      saveTokens: (tokens: StoredOAuthTokens) => {
        const stored: StoredTokens = { ...tokens, ...(typeof tokens.expires_in === 'number' ? { expires_at: store.now() + tokens.expires_in * 1000 } : {}) };
        store.writeCredentials(server.id, { tokens: JSON.stringify(stored), redirect_uri: redirectUri });
      },
      redirectToAuthorization: (authorizationUrl: URL) => {
        if (!flow) throw new McpSignInRequiredError(server.name);
        flow.authorizationUrl = authorizationUrl;
      },
      saveCodeVerifier: (verifier: string) => {
        if (flow) flow.verifier = verifier;
      },
      codeVerifier: () => {
        if (!flow?.verifier) throw new Error('No sign-in is in progress');
        return flow.verifier;
      },
      invalidateCredentials: (scope) => {
        if (scope === 'all') store.database.connection.prepare('delete from mcp_server_credentials where server_id = ?').run(server.id);
        else if (scope === 'client') store.writeCredentials(server.id, { client_information: null });
        else if (scope === 'tokens') store.writeCredentials(server.id, { tokens: null });
        else if (scope === 'discovery') store.writeCredentials(server.id, { discovery_state: null });
      },
      saveDiscoveryState: (state: OAuthDiscoveryState) => {
        store.writeCredentials(server.id, { discovery_state: JSON.stringify(state) });
      },
      discoveryState: () => {
        const value = store.credentials(server.id)?.discovery_state;
        return value ? JSON.parse(value) as OAuthDiscoveryState : undefined;
      }
    };
  }

  private readTokens(serverId: string): StoredTokens | undefined {
    const value = this.credentials(serverId)?.tokens;
    return value ? JSON.parse(value) as StoredTokens : undefined;
  }

  private credentials(serverId: string): CredentialRow | undefined {
    return this.database.connection.prepare('select redirect_uri, client_information, tokens, discovery_state from mcp_server_credentials where server_id = ?')
      .get(serverId) as unknown as CredentialRow | undefined;
  }

  private writeCredentials(serverId: string, change: Partial<CredentialRow>): void {
    const current = this.credentials(serverId) ?? { redirect_uri: null, client_information: null, tokens: null, discovery_state: null };
    const next = { ...current, ...change };
    this.database.connection.prepare(`insert into mcp_server_credentials (server_id, redirect_uri, client_information, tokens, discovery_state, updated_at)
      values (?, ?, ?, ?, ?, ?) on conflict(server_id) do update set redirect_uri = excluded.redirect_uri, client_information = excluded.client_information,
      tokens = excluded.tokens, discovery_state = excluded.discovery_state, updated_at = excluded.updated_at`)
      .run(serverId, next.redirect_uri, next.client_information, next.tokens, next.discovery_state, new Date(this.now()).toISOString());
  }

  // Reuses the port of an earlier loopback registration when it is free, so
  // services that match redirects exactly keep accepting it.
  private async listenLoopback(serverId: string): Promise<{ server: http.Server; redirectUri: string }> {
    const previous = safeUrl(this.credentials(serverId)?.redirect_uri ?? '');
    const preferred = previous && isLoopback(previous.href) ? Number(previous.port) : 0;
    const server = http.createServer((request, response) => void this.handleLoopback(request, response));
    const port = await listen(server, preferred).catch(() => listen(server, 0));
    server.unref();
    return { server, redirectUri: `http://127.0.0.1:${port}/callback` };
  }

  private async handleLoopback(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = safeUrl(`http://${request.headers.host ?? '127.0.0.1'}${request.url ?? '/'}`);
    if (request.method !== 'GET' || !url || url.pathname !== '/callback') {
      response.writeHead(404).end();
      return;
    }
    const page = await this.callbackPage(url.href);
    response.writeHead(page.status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
    response.end(page.body);
  }

  // The page the browser shows after a redirect lands on Patterm.
  async callbackPage(rawUrl: string): Promise<{ status: number; body: string }> {
    try {
      const { name } = await this.completeSignIn(rawUrl);
      return { status: 200, body: resultPage(`Signed in to ${name}`, 'You can close this tab and return to Patterm.') };
    } catch (error) {
      return { status: 400, body: resultPage('Sign-in failed', error instanceof Error ? error.message : String(error)) };
    }
  }

  private finish(flow: PendingSignIn): void {
    this.pending.delete(flow.state);
    flow.listener?.close();
    flow.listener = null;
  }

  private expirePending(): void {
    const now = this.now();
    for (const flow of [...this.pending.values()]) if (flow.expiresAt <= now) this.finish(flow);
  }
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

export function isLoopback(value: string): boolean {
  const url = safeUrl(value);
  return Boolean(url && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
}

function sameEndpoint(url: URL, redirectUri: string): boolean {
  const expected = new URL(redirectUri);
  const host = (value: URL) => value.hostname === 'localhost' ? '127.0.0.1' : value.hostname;
  return url.protocol === expected.protocol && host(url) === host(expected) && url.port === expected.port && url.pathname === expected.pathname;
}

function safeUrl(value: string): URL | null {
  try { return new URL(value); } catch { return null; }
}

function resultPage(title: string, detail: string): string {
  const escape = (value: string) => value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title>`
    + '<body style="font:14px system-ui,sans-serif;background:#080b10;color:#e6e8eb;display:grid;place-items:center;min-height:90vh;margin:0">'
    + `<main style="max-width:28rem;padding:1.5rem"><h1 style="font-size:1rem;margin:0 0 .5rem">${escape(title)}</h1><p style="color:#9aa3ad;margin:0">${escape(detail)}</p></main>`;
}
