import type { McpServerSpec } from './HarnessProvider';
import type { McpLaunchServer } from '../Services/McpServerRegistry';

// Turns Patterm's global MCP servers into each harness's own configuration.
// Remote servers never carry secrets here: Claude Code and Codex run a header
// helper, and OpenCode, which only take fixed headers, run a stdio
// bridge. Both ask Patterm for current headers over the local socket.

type ShimMode = '--mcp-headers' | '--mcp-bridge' | '--mcp-exec';

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

// Claude Code and Codex run header helpers through `sh -c`.
export function headersHelperCommand(patterm: McpServerSpec, serverId: string): string {
  const helper = shim(patterm, '--mcp-headers', serverId);
  return [
    ...Object.entries(helper.env).map(([key, value]) => `${key}=${shellQuote(value)}`),
    ...[helper.command, ...helper.args].map(shellQuote)
  ].join(' ');
}

export function claudeMcpServers(servers: McpLaunchServer[], patterm: McpServerSpec): Record<string, unknown> {
  return Object.fromEntries(servers.map((server) => [server.name, server.transport === 'stdio'
    ? { command: server.command, args: server.args, env: server.env }
    : { type: 'http', url: server.url, ...(server.managedHeaders ? { headersHelper: headersHelperCommand(patterm, server.id) } : {}) }]));
}

// Codex `-c` values appear in `ps` and in Patterm's process records, so a
// local server with environment runs through the exec bridge, which fetches
// it from Patterm. `enabled = true` overrides a same-named native entry that
// is turned off.
export function codexMcpOverrides(servers: McpLaunchServer[], patterm: McpServerSpec): string[] {
  return servers.flatMap((server) => {
    const key = `mcp_servers.${server.name}`;
    if (server.transport === 'http') {
      return [
        `${key}.url=${tomlString(server.url)}`,
        `${key}.enabled=true`,
        ...(server.managedHeaders ? [`${key}.http_headers_helper=${tomlString(headersHelperCommand(patterm, server.id))}`] : [])
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

// Codex prefers its own saved login for a server name over Patterm's header
// helper, so an expired native login hides a server that works in Patterm.
// Without either login, Codex reports the server as not logged in.
export function codexMcpStartupNotice(server: McpLaunchServer, error: string): { title: string; body: string } {
  const managed = server.transport === 'http' && server.managedHeaders;
  const reason = error || 'Codex could not start this MCP server.';
  // Advice leads because notification lists show only the first lines.
  const advice = managed && /refresh/i.test(error)
    ? `Codex has its own saved login for ${server.name}, which it uses instead of Patterm's. Remove it with codex -c 'mcp_servers.${server.name}.url="${server.url}"' mcp logout ${server.name} (add -c mcp_oauth_credentials_store="file" if no keyring is available), then restart the agent.`
    : managed && /not logged in/i.test(error)
      ? `Sign in to ${server.name} in Patterm's MCP server settings, then restart the agent.`
      : null;
  return {
    title: `${server.name} did not start in Codex`,
    body: advice ? `${advice}\n\nCodex reported: ${reason}` : `${reason}\n\nThe agent runs without its tools until it restarts.`
  };
}

export function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}
