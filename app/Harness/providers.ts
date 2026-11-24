import { firstSemver, type HarnessProvider, type HarnessSignIn } from './HarnessProvider';

// Built-in harness providers: the agent CLIs Patterm discovers and runs in
// Integrated mode.

const claude: HarnessProvider = {
  id: 'claude',
  displayName: 'Claude Code',
  executableCandidates: ['claude'],
  versionArgs: ['--version'],
  parseVersion: firstSemver,
  installUrl: 'https://code.claude.com/docs/en/setup',
  signInCommand: 'claude',
  // Prints JSON with loggedIn, and exits 1 when signed out.
  signInCheck: {
    args: ['auth', 'status', '--json'],
    parse: ({ stdout }) => {
      try {
        const loggedIn = (JSON.parse(stdout) as { loggedIn?: unknown }).loggedIn;
        return loggedIn === true ? 'signed_in' : loggedIn === false ? 'signed_out' : 'unknown';
      } catch {
        return 'unknown';
      }
    }
  }
};

const codex: HarnessProvider = {
  id: 'codex',
  displayName: 'Codex',
  executableCandidates: ['codex'],
  versionArgs: ['--version'],
  parseVersion: firstSemver,
  installUrl: 'https://developers.openai.com/codex/cli',
  signInCommand: 'codex',
  // "Logged in using …" and exit 0, or "Not logged in" and exit 1.
  signInCheck: {
    args: ['login', 'status'],
    parse: ({ code, stdout, stderr }): HarnessSignIn => {
      const output = `${stdout}${stderr}`;
      if (/not logged in/i.test(output)) return 'signed_out';
      return code === 0 && /logged in/i.test(output) ? 'signed_in' : 'unknown';
    }
  }
};

const opencode: HarnessProvider = {
  id: 'opencode',
  displayName: 'OpenCode',
  executableCandidates: ['opencode'],
  versionArgs: ['--version'],
  parseVersion: firstSemver,
  installUrl: 'https://opencode.ai/docs',
  signInCommand: 'opencode auth login',
  // Lists saved credentials; an empty list still leaves environment keys and
  // OpenCode's own models.
  signInCheck: {
    args: ['auth', 'list', '--format', 'json'],
    optional: true,
    parse: ({ code, stdout }) => {
      if (code !== 0) return 'unknown';
      try {
        const saved = JSON.parse(stdout) as unknown;
        if (!Array.isArray(saved)) return 'unknown';
        return saved.length ? 'signed_in' : 'signed_out';
      } catch {
        return 'unknown';
      }
    }
  }
};

const agy: HarnessProvider = {
  id: 'agy',
  displayName: 'Antigravity',
  executableCandidates: ['agy'],
  versionArgs: ['--version'],
  parseVersion: firstSemver,
  installUrl: 'https://antigravity.google/download',
  signInCommand: 'agy',
  // agy has no status command. Listing models needs a sign-in and says so;
  // any other failure, such as being offline, is unknown. ACP's session/new
  // also reports it, but creates a session when signed in.
  signInCheck: {
    args: ['models'],
    parse: ({ code, stdout, stderr }) => {
      if (code === 0) return 'signed_in';
      return /sign in/i.test(`${stdout}${stderr}`) ? 'signed_out' : 'unknown';
    }
  }
};

export const harnessProviders: HarnessProvider[] = [claude, codex, opencode, agy];
