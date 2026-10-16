import path from 'node:path';
import {
  firstSemver,
  type HarnessLaunchInput,
  type HarnessLaunchPlan,
  type HarnessProvider
} from './HarnessProvider';
import { claudeMcpServers, CODEX_MCP_PROXY_ENV, codexMcpOverrides, tomlString, tomlStringArray } from './McpDelivery';

// Built-in harness providers: the agent CLIs
// (claude | codex | opencode) plus the always-available raw PTY fallback. Each
// knows how to inject the Patterm MCP server in its harness's own dialect.

export const CLAUDE_MCP_CONFIG = /^claude-mcp-(mcp_[0-9a-f-]+)\.json$/;
export const CLAUDE_CONTEXT_FILE = /^claude-context-(mcp_[0-9a-f-]+)\.md$/;

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
    const identity = mcp.env.PATTERM_MCP_IDENTITY ?? 'patterm';
    const configPath = path.join(runtimeDir, claudeMcpConfigName(identity));
    const contents = JSON.stringify(
      { mcpServers: { ...claudeMcpServers(mcpServers, mcp), patterm: { command: mcp.command, args: mcp.args, env: mcp.env } } },
      null,
      2
    );
    const files = [{ path: configPath, contents }];
    const args = ['--permission-mode', 'auto', '--mcp-config', configPath];
    if (model) {
      args.push('--model', model);
    }
    if (reasoning) {
      args.push('--effort', reasoning);
    }
    const context = agentContext?.trim();
    if (context && process.platform === 'win32') {
      // Windows caps a command line at 32,767 characters, and the assistant's
      // saved memory can approach that. A batch-file Claude runs through
      // cmd.exe, which takes neither line breaks nor more than 8,191.
      const contextPath = path.join(runtimeDir, `claude-context-${identity}.md`);
      files.push({ path: contextPath, contents: context });
      args.push('--append-system-prompt-file', contextPath);
    } else if (context) {
      args.push('--append-system-prompt', context);
    }
    if (resumeId) {
      args.push('--resume', resumeId);
    }
    return {
      command: executablePath,
      args,
      env: {},
      files,
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
  // It has no file form of developer_instructions (model_instructions_file
  // replaces the base prompt), so Windows passes the context inline too: the
  // largest assistant memory budget makes a command line of about 27,000 of
  // the 32,767 characters Windows allows.
  buildLaunch({ executablePath, mcp, mcpServers = [], agentContext, resumeId, model, reasoning, serviceTier }: HarnessLaunchInput): HarnessLaunchPlan {
    const context = agentContext?.trim();
    const overrides = [
      'approval_policy="on-request"',
      'approvals_reviewer="auto_review"',
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
      env: { ...CODEX_MCP_PROXY_ENV },
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

export const harnessProviders: HarnessProvider[] = [claude, codex, opencode, rawpty];

