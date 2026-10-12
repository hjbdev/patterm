// Harness names without the icon assets, so plain modules and tests can use
// them.
import type { HarnessInstallationRecord } from '../types';

export const HARNESS_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  rawpty: 'Raw terminal'
};

export function harnessLabel(id: string): string {
  return HARNESS_LABELS[id] ?? id;
}

export function launchableHarnesses(harnesses: readonly HarnessInstallationRecord[]): HarnessInstallationRecord[] {
  return harnesses.filter((harness) => harness.status === 'available' && harness.harness !== 'rawpty');
}
