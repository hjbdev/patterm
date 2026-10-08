import path from 'node:path';
import {
  firstSemver,
  type HarnessLaunchInput,
  type HarnessLaunchPlan,
  type HarnessProvider
} from './HarnessProvider';
import { ampMcpServers, claudeMcpServers, codexMcpOverrides, tomlString, tomlStringArray } from './McpDelivery';

// Built-in harness providers: the agent CLIs
// (claude | codex | opencode | amp) plus the always-available raw PTY fallback. Each
// knows how to inject the Patterm MCP server in its harness's own dialect.

export const CLAUDE_MCP_CONFIG = /^claude-mcp-(mcp_[0-9a-f-]+)\.json$/;

function claudeMcpConfigName(identity: string): string {
  return `claude-mcp-${identity}.json`;
}

const claude: HarnessProvider = {
  id: 'claude',
  displayName: 'Claude Code',
  executableCandidates: ['claude'],
  versionArgs: ['--version'],
  parseVersion: firstSemver,
  // Claude Code takes an MCP config file path via --mcp-config. Each launch
  // gets its own file, so agents started together keep their own identity.
  buildLaunch({ executablePath, mcp, mcpServers = [], runtimeDir, agentContext, resumeId, model, reasoning }: HarnessLaunchInput): HarnessLaunchPlan {
    const configPath = path.join(runtimeDir, claudeMcpConfigName(mcp.env.PATTERM_MCP_IDENTITY ?? 'patterm'));
    const contents = JSON.stringify(
      { mcpServers: { ...claudeMcpServers(mcpServers, mcp), patterm: { command: mcp.command, args: mcp.args, env: mcp.env } } },
      null,
      2
    );
    const args = ['--permission-mode', 'auto', '--mcp-config', configPath];
    if (model) {
      args.push('--model', model);
    }
    if (reasoning) {
      args.push('--effort', reasoning);
    }
    const context = agentContext?.trim();
    if (context) {
      args.push('--append-system-prompt', context);
    }
    if (resumeId) {
      args.push('--resume', resumeId);
    }
    return {
      command: executablePath,
      args,
      env: {},
      files: [{ path: configPath, contents }],
      agentContextInjected: Boolean(context)
    };
  }
};

const codex: HarnessProvider = {
  id: 'codex',
  displayName: 'Codex',
  executableCandidates: ['codex'],
  versionArgs: ['--version'],
  parseVersion: firstSemver,
  // Codex merges inline TOML overrides passed as repeated `-c key=value` flags.
  buildLaunch({ executablePath, mcp, mcpServers = [], agentContext, resumeId, model, reasoning, serviceTier }: HarnessLaunchInput): HarnessLaunchPlan {
    const context = agentContext?.trim();
    const overrides = [
      ...codexMcpOverrides(mcpServers, mcp),
      `mcp_servers.patterm.command=${tomlString(mcp.command)}`,
      `mcp_servers.patterm.args=${tomlStringArray(mcp.args)}`,
      ...Object.entries(mcp.env).map(([key, value]) => `mcp_servers.patterm.env.${key}=${tomlString(value)}`),
      ...(context ? [`developer_instructions=${tomlString(context)}`] : []),
      ...(model ? [`model=${tomlString(model)}`] : []),
      ...(reasoning ? [`model_reasoning_effort=${tomlString(reasoning)}`] : []),
      ...(serviceTier ? [`service_tier=${tomlString(serviceTier)}`] : [])
    ];
    return {
      command: executablePath,
      args: resumeId
        ? ['resume', ...overrides.flatMap((override) => ['-c', override]), resumeId]
        : overrides.flatMap((override) => ['-c', override]),
      env: {},
      files: [],
      agentContextInjected: Boolean(context)
    };
  }
};

const opencode: HarnessProvider = {
  id: 'opencode',
  displayName: 'OpenCode',
  executableCandidates: ['opencode'],
  versionArgs: ['--version'],
  parseVersion: firstSemver,
  // The shared-server service creates/resolves the session and installs MCP
  // before attaching this native TUI. Keep the stored provider ID for history.
  buildLaunch({ executablePath, resumeId }: HarnessLaunchInput): HarnessLaunchPlan {
    return {
      command: executablePath,
      args: resumeId ? ['--session', resumeId] : [],
      env: {},
      files: []
    };
  }
};

const amp: HarnessProvider = {
  id: 'amp',
  displayName: 'Amp',
  executableCandidates: ['amp'],
  versionArgs: ['--version'],
  parseVersion: firstSemver,
  buildLaunch({ executablePath, mcp, mcpServers = [], runtimeDir, resumeId, model, reasoning }: HarnessLaunchInput): HarnessLaunchPlan {
    if (!resumeId) throw new Error('Amp needs a thread ID before launching');
    if (!/^T-[A-Za-z0-9-]+$/.test(resumeId)) throw new Error('Invalid Amp thread ID');
    if (reasoning) throw new Error('Amp does not support reasoning overrides in the TUI');
    const configPath = path.join(runtimeDir, `amp-${resumeId}.json`);
    return {
      command: executablePath,
      args: ['threads', 'continue', resumeId,
        '--mcp-config', configPath,
        ...(model ? ['--mode', model] : [])],
      // Amp only copies through OSC 52 when it recognises the terminal, and
      // otherwise needs xclip/wl-copy on the host. Amp's own web terminal sets
      // this flag to force OSC 52, which Patterm relays to the viewing client.
      env: { AMP_WEB_TERMINAL: '1' },
      files: [{ path: configPath, contents: JSON.stringify({ ...ampMcpServers(mcpServers, mcp), patterm: mcp }) }]
    };
  }
};

// RawPty has no CLI to discover — it spawns the user's shell directly, so it is
// always available, carries no version, and gets no MCP injection.
const rawpty: HarnessProvider = {
  id: 'rawpty',
  displayName: 'Raw terminal',
  executableCandidates: [],
  versionArgs: null,
  parseVersion: () => null,
  buildLaunch({ executablePath, resumeId }: HarnessLaunchInput): HarnessLaunchPlan {
    if (resumeId) {
      throw new Error('raw PTY sessions cannot be resumed');
    }
    return { command: executablePath, args: [], env: {}, files: [] };
  }
};

export const harnessProviders: HarnessProvider[] = [claude, codex, opencode, amp, rawpty];

