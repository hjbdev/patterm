import type { McpLaunchServer } from '../Services/McpServerRegistry';

// Harness providers describe the agent CLIs Patterm can drive. This
// slice covers discovery only: which binary to look for on PATH and how to read
// its version. Launch/resume/MCP-injection metadata lands in a later slice.

export type HarnessId = 'claude' | 'codex' | 'opencode' | 'rawpty';

export type HarnessStatus = 'available' | 'missing' | 'broken';

// The Patterm MCP server a harness should connect back to: a `command args`
// invocation plus the env it needs (socket path, Electron-as-node flag).
export interface McpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  httpProxyUrl?: string;
}

export interface HarnessLaunchInput {
  executablePath: string;
  mcp: McpServerSpec;
  // The user's global MCP servers for this harness, added beside Patterm's.
  mcpServers?: McpLaunchServer[];
  // Writable directory for any temp injection files the provider emits.
  runtimeDir: string;
  // Patterm startup context that should be injected as harness startup/system
  // context when the harness supports it.
  agentContext?: string | null;
  // Provider-owned conversation/session ID to continue exactly.
  resumeId?: string | null;
  // Resolved preset selection. Providers map these to their own CLI flags;
  // null means the harness's own default is left untouched.
  model?: string | null;
  reasoning?: string | null;
  // Codex service tier ID; other providers reject it before launch.
  serviceTier?: string | null;
}

export interface HarnessLaunchFile {
  path: string;
  contents: string;
}

// A fully-resolved spawn plan: what to exec, with which args/env, plus any
// config files the caller must write to disk before spawning. Providers stay
// pure (no fs/process) so the plan is unit-testable.
export interface HarnessLaunchPlan {
  command: string;
  args: string[];
  env: Record<string, string>;
  files: HarnessLaunchFile[];
  agentContextInjected?: boolean;
}

export interface HarnessProvider {
  readonly id: HarnessId;
  readonly displayName: string;
  // Executable names to look for on PATH, tried in order. An empty list marks a
  // provider that needs no installed binary (RawPty rides the user's shell).
  readonly executableCandidates: string[];
  // Args that print a version, or null to skip probing. Output is matched by
  // parseVersion() against combined stdout+stderr.
  readonly versionArgs: string[] | null;
  parseVersion(output: string): string | null;
  // Build the spawn plan, injecting the Patterm MCP server the way this harness
  // expects (config flag, CLI override, or config env var).
  buildLaunch(input: HarnessLaunchInput): HarnessLaunchPlan;
}

const SEMVER = /\bv?(\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?)\b/;

// Most CLIs print a line like "1.2.3 (Claude Code)" or "codex 0.4.1"; pull the
// first semver-looking token out of whatever they emit.
export function firstSemver(output: string): string | null {
  return SEMVER.exec(output)?.[1] ?? null;
}
