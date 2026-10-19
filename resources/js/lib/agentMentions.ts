// Agent mentions. The Integrated composer offers the project's other live
// agents and processes in its @ menu, shows a picked one as a chip, and sends
// it as its process ID, which agents pass to send_message or
// get_process_output. The menu also offers
// presets and harnesses, sent as launch tokens such as
// `[patterm_preset:smartypants]` that ask the agent to spawn_agent with them.
// Transcripts show IDs and tokens as chips too.

import { agentLabel, buildAgentTabFamilies } from './agentTabs';
import { activeProcesses, type LiveProcessRecord } from './processTabs';
import { HARNESS_LABELS, harnessLabel, launchableHarnesses } from './harnessLabels';
import { FIGURE_ID } from '../../../app/Services/TranscriptProjection';
import type { HarnessInstallationRecord, ProcessRecord, ProjectWorkbench, SessionRecord } from '../types';

export interface MentionAgent {
  session: SessionRecord;
  processId: string;
  // The agent's title, which the menu searches.
  name: string;
  // The parent agent's title, for subagents.
  parent: string | null;
}

export interface MentionProcess {
  process: LiveProcessRecord;
  processId: string;
  // The process's name, which the menu searches.
  name: string;
  // The title of the agent that started it.
  owner: string | null;
}

export interface MentionLauncher {
  kind: 'preset' | 'harness';
  // The preset's name or the harness's label, which the menu searches.
  name: string;
  harness: string;
  token: string;
}

export interface MentionPart {
  text: string;
  processId?: string | undefined;
  launch?: { kind: 'preset' | 'harness'; name: string; harness: string | null } | undefined;
  // A rendered page the reply places here.
  figure?: string | undefined;
}

// A process ID may name an agent on a paired host, such as `beta:process_7`;
// host names are lowercase letters, digits, and hyphens.
const MENTION = new RegExp(String.raw`(?<![\w-])(?:[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?:)?process_\d+\b|\[patterm_(preset|harness):([^\]\n]+)\]|\[patterm_figure:(${FIGURE_ID})\]`, 'g');

export function launchToken(kind: 'preset' | 'harness', value: string): string {
  return `[patterm_${kind}:${value}]`;
}

// Presets, then harnesses, for the installed harnesses. A preset name that
// several harnesses share is sent as `harness/name`, since spawn_agent needs
// the harness to tell them apart.
type LaunchPreset = { harness: string; name: string };

export function mentionLaunchers(harnesses: readonly HarnessInstallationRecord[], presets: readonly LaunchPreset[]): MentionLauncher[] {
  const installed = launchableHarnesses(harnesses).map((item) => item.harness);
  const shared = (preset: LaunchPreset): boolean => presets.some((other) => other !== preset && other.name.toLowerCase() === preset.name.toLowerCase());
  return [
    ...presets.filter((preset) => installed.includes(preset.harness)).map((preset) => ({
      kind: 'preset' as const, name: preset.name, harness: preset.harness,
      token: launchToken('preset', shared(preset) ? `${preset.harness}/${preset.name}` : preset.name)
    })),
    ...installed.map((harness) => ({ kind: 'harness' as const, name: harnessLabel(harness), harness, token: launchToken('harness', harness) }))
  ];
}

function launchPart(kind: 'preset' | 'harness', value: string): NonNullable<MentionPart['launch']> {
  if (kind === 'harness') return { kind, name: harnessLabel(value), harness: value };
  const slash = value.indexOf('/');
  const harness = slash > 0 ? value.slice(0, slash) : '';
  return harness in HARNESS_LABELS ? { kind, name: value.slice(slash + 1), harness } : { kind, name: value, harness: null };
}

// Live agents in tab order, each root followed by its subagents, without the
// agent being messaged.
export function mentionableAgents(sessions: readonly SessionRecord[], selfProcessId: string): MentionAgent[] {
  const options = buildAgentTabFamilies(sessions).flatMap((family) => family.options);
  const byId = new Map(options.map((option) => [option.session.id, option.session]));
  return options.flatMap(({ session }) => {
    if (!session.processId || session.processId === selfProcessId) return [];
    const parent = session.parentId ? byId.get(session.parentId) : undefined;
    return [{ session, processId: session.processId, name: agentLabel(session), parent: parent ? agentLabel(parent) : null }];
  });
}

// Live processes, such as shells and dev servers, each naming the agent that
// started it.
export function mentionableProcesses(processes: readonly ProcessRecord[], sessions: readonly SessionRecord[]): MentionProcess[] {
  return activeProcesses(processes).map((process) => {
    const owner = process.parentProcessId ? sessionForProcess(sessions, process.parentProcessId) : null;
    return { process, processId: process.id, name: process.name, owner: owner ? agentLabel(owner) : null };
  });
}

// Splits text into plain runs, process IDs, and launch tokens.
export function splitProcessMentions(text: string): MentionPart[] {
  const parts: MentionPart[] = [];
  let last = 0;
  for (const match of text.matchAll(MENTION)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index) });
    const kind = match[1] as 'preset' | 'harness' | undefined;
    parts.push(match[3] ? { text: match[0], figure: match[3] } : kind ? { text: match[0], launch: launchPart(kind, match[2]!) } : { text: match[0], processId: match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length || !parts.length) parts.push({ text: text.slice(last) });
  return parts;
}

// The session behind a process: the live one, otherwise the latest.
export function sessionForProcess(sessions: Iterable<SessionRecord>, processId: string): SessionRecord | null {
  let latest: SessionRecord | null = null;
  for (const session of sessions) {
    if (session.processId !== processId) continue;
    if (!session.exitedAt) return session;
    if (!latest || session.startedAt > latest.startedAt) latest = session;
  }
  return latest;
}

// The agent or process a process ID names, in any project. A preferred
// project is searched first: the assistant works across projects, so its
// messages name agents outside the one on screen.
export function findProcess(projects: readonly ProjectWorkbench[], processId: string, preferProjectId?: string | null): { projectId: string; session: SessionRecord | null; process: ProcessRecord | null } | null {
  const preferred = projects.find((item) => item.project.id === preferProjectId);
  const ordered = preferred ? [preferred, ...projects.filter((item) => item !== preferred)] : projects;
  for (const item of ordered) {
    const session = sessionForProcess(item.projectSessions, processId);
    if (session) return { projectId: item.project.id, session, process: null };
    const process = item.processes.find((candidate) => candidate.id === processId);
    if (process) return { projectId: item.project.id, session: null, process };
  }
  return null;
}
