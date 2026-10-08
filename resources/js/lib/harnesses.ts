export { HARNESS_LABELS, harnessLabel, launchableHarnesses } from './harnessLabels';
import claudeCodeIcon from '../assets/agents/claude-code.svg';
import codexIcon from '../assets/agents/codex.svg';
import opencodeIcon from '../assets/agents/opencode.svg';
import ampIcon from '../assets/agents/amp.svg';

export const HARNESS_ICONS: Record<string, string> = {
  claude: claudeCodeIcon,
  codex: codexIcon,
  opencode: opencodeIcon,
  amp: ampIcon
};

export function harnessIcon(id: string | null | undefined): string | null {
  return id ? HARNESS_ICONS[id] ?? null : null;
}
