// Harness providers describe the agent CLIs Patterm can drive: which binary to
// look for on PATH and how to read its version.

export type HarnessId = 'claude' | 'codex' | 'opencode' | 'agy';

export type HarnessStatus = 'available' | 'missing' | 'broken';

// The Patterm MCP server a harness should connect back to: a `command args`
// invocation plus the env it needs (socket path, Electron-as-node flag).
export interface McpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  httpProxyUrl?: string;
}

export interface HarnessProvider {
  readonly id: HarnessId;
  readonly displayName: string;
  // Executable names to look for on PATH, tried in order.
  readonly executableCandidates: string[];
  // Args that print a version, or null to skip probing. Output is matched by
  // parseVersion() against combined stdout+stderr.
  readonly versionArgs: string[] | null;
  parseVersion(output: string): string | null;
}

const SEMVER = /\bv?(\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?)\b/;

// Most CLIs print a line like "1.2.3 (Claude Code)" or "codex 0.4.1"; pull the
// first semver-looking token out of whatever they emit.
export function firstSemver(output: string): string | null {
  return SEMVER.exec(output)?.[1] ?? null;
}
