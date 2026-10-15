import type { McpServerSpec } from './HarnessProvider';
import type { McpLaunchServer } from '../Services/McpServerRegistry';
import { escapeCmdArgument } from '../Platform/Executable';

// A public marker, never a credential. Supplying a bearer disables Codex's
// native OAuth lookup; the helper authenticates the proxy in a separate header.
export const CODEX_MCP_PROXY_ENV = { PATTERM_MCP_PROXY: 'patterm-managed' };

// Turns Patterm's global MCP servers into each harness's own configuration.
// Remote servers never carry upstream secrets here. Claude and OpenCode use
// stdio bridges; Codex uses Patterm's HTTP proxy to override native HTTP entries.

type ShimMode = '--mcp-headers' | '--mcp-proxy-headers' | '--mcp-bridge' | '--mcp-exec';

interface Invocation {
  command: string;
  args: string[];
  env: Record<string, string>;
}

// The Patterm shim, reused in another mode. It carries the agent's identity,
// or OpenCode's bridge token, so Patterm answers only for servers assigned to
// that agent's harness.
function shim(patterm: McpServerSpec, mode: ShimMode, serverId: string): Invocation {
  const env: Record<string, string> = {};
  for (const key of ['ELECTRON_RUN_AS_NODE', 'PATTERM_MCP_SOCKET', 'PATTERM_MCP_IDENTITY', 'PATTERM_OPENCODE_BRIDGE']) {
    if (patterm.env[key] !== undefined) env[key] = patterm.env[key]!;
  }
  return { command: patterm.command, args: [...patterm.args, mode, serverId], env };
}

// Claude Code and Codex run header helpers through `sh -c`. On Windows they
// use cmd.exe: Claude runs `cmd.exe /d /s /c "<helper>"` and Codex
// `%ComSpec% /Q /D /C "<helper>"`, which both strip the outer quotes. Neither
// passes the shim's environment through, so the helper sets it first.
export function headersHelperCommand(patterm: McpServerSpec, serverId: string, mode: '--mcp-headers' | '--mcp-proxy-headers' = '--mcp-headers'): string {
  const helper = shim(patterm, mode, serverId);
  if (process.platform === 'win32') return cmdHelperCommand(helper);
  return [
    ...Object.entries(helper.env).map(([key, value]) => `${key}=${shellQuote(value)}`),
    ...[helper.command, ...helper.args].map(shellQuote)
  ].join(' ');
}

export function claudeMcpServers(servers: McpLaunchServer[], patterm: McpServerSpec): Record<string, unknown> {
  return Object.fromEntries(servers.map((server) => {
    if (server.transport === 'stdio') return [server.name, { command: server.command, args: server.args, env: server.env }];
    const bridge = shim(patterm, '--mcp-bridge', server.id);
    return [server.name, { command: bridge.command, args: bridge.args, env: bridge.env }];
  }));
}

// Codex `-c` values appear in `ps` and in Patterm's process records, so a
// local server with environment runs through the exec bridge, which fetches
// it from Patterm. `enabled = true` overrides a same-named native entry that
// is turned off.
export function codexMcpOverrides(servers: McpLaunchServer[], patterm: McpServerSpec): string[] {
  return servers.flatMap((server) => {
    const key = `mcp_servers.${server.name}`;
    if (server.transport === 'http') {
      if (!patterm.httpProxyUrl) throw new Error('Patterm MCP HTTP proxy is unavailable');
      return [
        `${key}.url=${tomlString(`${patterm.httpProxyUrl}/${encodeURIComponent(server.id)}`)}`,
        `${key}.enabled=true`,
        `${key}.bearer_token_env_var="PATTERM_MCP_PROXY"`,
        `${key}.http_headers_helper=${tomlString(headersHelperCommand(patterm, server.id, '--mcp-proxy-headers'))}`
      ];
    }
    const run = Object.keys(server.env).length > 0 ? shim(patterm, '--mcp-exec', server.id) : { command: server.command, args: server.args, env: {} };
    return [
      `${key}.command=${tomlString(run.command)}`,
      `${key}.args=${tomlStringArray(run.args)}`,
      ...Object.entries(run.env).map(([name, value]) => `${key}.env.${name}=${tomlString(value)}`),
      `${key}.enabled=true`
    ];
  });
}

export function openCodeMcpConfigs(servers: McpLaunchServer[], patterm: McpServerSpec): Record<string, Record<string, unknown>> {
  return Object.fromEntries(servers.map((server) => {
    if (server.transport === 'stdio') {
      return [server.name, { type: 'local', command: [server.command, ...server.args], environment: server.env, disabled: false }];
    }
    if (!server.managedHeaders) return [server.name, { type: 'remote', url: server.url, disabled: false }];
    const bridge = shim(patterm, '--mcp-bridge', server.id);
    return [server.name, { type: 'local', command: [bridge.command, ...bridge.args], environment: bridge.env, disabled: false }];
  }));
}

// Patterm owns authentication for its servers; native Codex login advice is
// never a recovery step for these connections (including older live hosts).
export function codexMcpStartupNotice(server: McpLaunchServer, error: string): { title: string; body: string } {
  const reason = error || 'Codex could not start this MCP server.';
  const authFailure = server.transport === 'http' && /oauth|authenticat|not logged in|refresh|sign.?in/i.test(error);
  const advice = authFailure ? `Test ${server.name} in Patterm's MCP server settings and sign in there if needed, then restart the agent.` : null;
  return {
    title: `${server.name} did not start in Codex`,
    body: advice ? advice : `${reason}\n\nThe agent runs without its tools until it restarts.`
  };
}

export function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

// Every token is caret-escaped, so spaces, parentheses, `&`, and `%` in paths
// reach `set` and the shim literally. The values (paths and IDs) never end in a
// backslash, which the escaping would double for `set`.
function cmdHelperCommand(helper: Invocation): string {
  return [
    ...Object.entries(helper.env).map(([key, value]) => `set ${escapeCmdArgument(`${key}=${value}`)}`),
    [helper.command, ...helper.args].map(escapeCmdArgument).join(' ')
  ].join(' && ');
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}
