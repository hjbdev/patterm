import type { AgentHistoryProvider } from '../Services/AgentHistory/AgentHistoryTypes';
import type { IntegratedActivityChange } from '../Services/IntegratedAgentService';

export interface IntegratedHistoryCheckpointContext {
  provider(processId: string): AgentHistoryProvider | null;
  flush(provider: AgentHistoryProvider): void;
}

const BUSY = new Set(['working', 'thinking']);

// An Integrated turn reaches history when it ends or stops for the user,
// rather than once the history watcher's debounce runs out. Ended sessions
// and older turns are read back from history, so a lagging import shows as a
// gap in the conversation.
export function integratedHistoryCheckpoints(context: IntegratedHistoryCheckpointContext): (change: IntegratedActivityChange) => void {
  return ({ processId, previous, activity }) => {
    if (!BUSY.has(previous) || BUSY.has(activity)) return;
    const provider = context.provider(processId);
    if (provider) context.flush(provider);
  };
}
