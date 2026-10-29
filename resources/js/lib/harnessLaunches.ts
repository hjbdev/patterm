import { shallowReactive } from 'vue';
import { harnessLabel } from './harnessLabels';
import type { AgentInterface } from '../types';

export interface HarnessLaunchInput {
  projectId: string;
  targetProjectId: string;
  harness: string;
  preset?: string;
  interfaceMode?: AgentInterface;
  host?: string;
  // Sent as the agent's first message once it is ready.
  initialPrompt?: string;
}

export interface HarnessLaunch {
  id: string;
  input: HarnessLaunchInput;
  state: 'starting' | 'ready' | 'failed';
  sessionId?: string;
  error?: string;
}

export function harnessLaunchLabel(launch: HarnessLaunch): string {
  const name = harnessLabel(launch.input.harness);
  return launch.state === 'failed' ? `${name} · Launch failed` : `Starting ${name}…`;
}

// Temporary renderer records, not processes or sessions. Native launch and
// registration still belong to the backend. Never persist or replay requests.
const launches = shallowReactive<HarnessLaunch[]>([]);
let sequence = 0;
function update(id: string, fields: Partial<HarnessLaunch>): void {
  const index = launches.findIndex((launch) => launch.id === id);
  if (index >= 0) launches[index] = { ...launches[index]!, ...fields };
}
function start(input: HarnessLaunchInput, call: (args: Record<string, unknown>) => Promise<unknown>) {
  const launch: HarnessLaunch = { id: `launch_${++sequence}`, input: { ...input }, state: 'starting' };
  launches.push(launch);
  const finished = Promise.resolve().then(() => call({
    harness: launch.input.harness,
    project_id: launch.input.targetProjectId,
    ...(launch.input.preset ? { preset: launch.input.preset } : {}),
    ...(launch.input.interfaceMode ? { interface_mode: launch.input.interfaceMode } : {}),
    ...(launch.input.initialPrompt ? { initial_prompt: launch.input.initialPrompt } : {})
  })).then((result) => {
    const sessionId = (result as { session_id?: unknown } | null)?.session_id;
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('The launch returned no session. Check the project’s agents before launching again.');
    update(launch.id, { state: 'ready', sessionId });
    return sessionId;
  }).catch((error: unknown) => {
    update(launch.id, { state: 'failed', error: error instanceof Error ? error.message : 'Could not launch the agent.' });
    return null;
  });
  return { id: launch.id, finished };
}
function dismiss(id: string): void {
  const index = launches.findIndex((launch) => launch.id === id);
  if (index >= 0 && launches[index]?.state !== 'starting') launches.splice(index, 1);
}

export const harnessLaunches = { launches, start, dismiss };
