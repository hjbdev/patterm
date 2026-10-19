import type { CloseRequestActions } from '../Actions/CloseRequestActions';
import { awaitingUser } from '../Services/Activity';
import type { IntegratedActivityChange } from '../Services/IntegratedAgentService';
import type { NotificationService } from '../Services/NotificationService';
import type { TriageDecision } from '../Services/NotificationTriage';

export interface IntegratedActivityNotificationContext {
  notifications: Pick<NotificationService, 'turnActivity' | 'waiting' | 'resolveHandled' | 'resolve'>;
  raise(input: Parameters<NotificationService['raise']>[0]): void;
  // Created after this listener is registered.
  closeRequests(): Pick<CloseRequestActions, 'clear' | 'pending' | 'announce'> | null;
  isAssistant(processId: string): boolean;
  // The turn woke a snoozed agent, which announced that instead.
  wokeFromSnooze(processId: string): boolean;
  // An automatic idle compaction is running. Registered before the idle
  // compaction service's listener, so a compaction's end still reads true.
  compacting(processId: string): boolean;
  triage(processId: string): TriageDecision;
  log(event: string, data: Record<string, unknown>): void;
}

// Notifications and close requests follow an Integrated agent's activity.
export function integratedActivityNotifications(context: IntegratedActivityNotificationContext): (change: IntegratedActivityChange) => void {
  return ({ processId, previous, activity, snapshot }) => {
    const reportedThisTurn = context.notifications.turnActivity(processId, previous, activity, snapshot);
    // An automatic compaction is not work for the user: it leaves their open
    // requests alone, and its end or failure is not announced.
    const compacting = context.compacting(processId);
    if (awaitingUser(activity)) {
      void context.notifications.waiting(processId, previous, activity).catch((error: unknown) => {
        context.log('raise.failed', { source: 'integrated', kind: 'permission', message: error instanceof Error ? error.message : String(error) });
      });
    }
    else if (activity === 'working') {
      if (compacting) return;
      context.notifications.resolveHandled(processId);
      // New work makes an earlier close request stale.
      if (!snapshot && (previous === 'idle' || previous === 'error')) context.closeRequests()?.clear(processId);
    }
    else if (activity === 'error') {
      if (!compacting) context.raise({ processId, source: 'integrated', kind: 'failure', body: 'The agent reported an error' });
    }
    else if (activity === 'idle') {
      // Asked on every idle change, so a wake never outlives its turn.
      const woke = context.wokeFromSnooze(processId);
      context.notifications.resolve({ process_id: processId, kinds: ['permission'] });
      // Reconnect snapshots are not turns the user has not seen.
      const turnEnded = !snapshot && !compacting && (previous === 'working' || previous === 'thinking' || awaitingUser(previous));
      if (!turnEnded) return;
      // A turn that asked to be closed announces that instead of finishing.
      const closeRequests = context.closeRequests();
      if (closeRequests?.pending(processId)) void closeRequests.announce(processId).catch(() => undefined);
      // The assistant's own turns are read in its panel, not announced, and
      // neither is a turn that reported or woke a snoozed agent.
      else if (!woke && !context.isAssistant(processId) && !reportedThisTurn) {
        const decision = context.triage(processId);
        if (decision.reason !== 'disabled') context.log('triage', { processId, ...decision });
        context.raise({ processId, source: 'integrated', kind: 'turn_finished', body: 'Finished its turn', dedupeKey: 'integrated:turn_finished', quiet: decision.quiet });
      }
    }
  };
}
