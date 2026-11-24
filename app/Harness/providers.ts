import { firstSemver, type HarnessProvider } from './HarnessProvider';

// Built-in harness providers: the agent CLIs Patterm discovers and runs in
// Integrated mode.

const claude: HarnessProvider = {
  id: 'claude',
  displayName: 'Claude Code',
  executableCandidates: ['claude'],
  versionArgs: ['--version'],
  parseVersion: firstSemver
};

const codex: HarnessProvider = {
  id: 'codex',
  displayName: 'Codex',
  executableCandidates: ['codex'],
  versionArgs: ['--version'],
  parseVersion: firstSemver
};

const opencode: HarnessProvider = {
  id: 'opencode',
  displayName: 'OpenCode',
  executableCandidates: ['opencode'],
  versionArgs: ['--version'],
  parseVersion: firstSemver
};

const agy: HarnessProvider = {
  id: 'agy',
  displayName: 'Antigravity',
  executableCandidates: ['agy'],
  versionArgs: ['--version'],
  parseVersion: firstSemver
};

export const harnessProviders: HarnessProvider[] = [claude, codex, opencode, agy];
