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

export type HarnessSignIn = 'signed_in' | 'signed_out' | 'unknown';

export interface SignInCheckResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// Asks the CLI itself whether it is signed in. parse() keeps only that answer:
// several CLIs also print the account's email and organisation.
export interface SignInCheck {
  args: string[];
  parse(result: SignInCheckResult): HarnessSignIn;
  // The CLI also works without saved credentials, such as with an API key in
  // the environment or bundled models, so signed_out is only a hint.
  optional?: boolean;
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
  // The official install page, and what to run in a terminal to sign in.
  readonly installUrl?: string;
  readonly signInCommand?: string;
  readonly signInCheck?: SignInCheck;
}

const SEMVER = /\bv?(\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?)\b/;

// Most CLIs print a line like "1.2.3 (Claude Code)" or "codex 0.4.1"; pull the
// first semver-looking token out of whatever they emit.
export function firstSemver(output: string): string | null {
  return SEMVER.exec(output)?.[1] ?? null;
}
