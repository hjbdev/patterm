import { ASSISTANT_BOT_ID } from '../../app/Bots/BotIdentity';
import { BotInbox } from '../../app/Services/BotInbox';
import { BotRelay, type BotRelayState } from '../../app/Services/BotRelay';
import { BotService } from '../../app/Services/BotService';
import type { CodexAppServerService } from '../../app/Services/CodexAppServerService';
import type { DatabaseService } from '../../app/Services/DatabaseService';
import type { HarnessLauncher } from '../../app/Services/HarnessLauncher';
import type { IntegratedAgentService } from '../../app/Services/IntegratedAgentService';
import type { NotificationChange } from '../../app/Services/NotificationService';
import type { SettingsService } from '../../app/Services/SettingsService';

// The assistant as the built-in bot: BotService runs its session and
// BotRelay its voice, digests and Focus mode. `assistant` keeps the shape
// the assistant's tests were written against.
export function assistantBot(
  database: DatabaseService,
  dir: string,
  launcher: Pick<HarnessLauncher, 'launch' | 'resume'>,
  codex: Pick<CodexAppServerService, 'realtimeStart' | 'realtimeStop' | 'realtimeAppendText' | 'onRealtime'>,
  integrated: Pick<IntegratedAgentService, 'prompt' | 'conversation'>,
  settings: SettingsService,
  processes: { stop(processId: string): Promise<unknown>; transferTimers(from: readonly string[], to: string): void },
  options: { digestDelayMs?: number; compacting?: (processId: string) => boolean; log?: (event: string, data: Record<string, unknown>) => void } = {}
) {
  const inbox = new BotInbox(database, (botId) => settings.bots().bots.find((bot) => bot.id === botId)?.focus === true);
  let relay: BotRelay | null = null;
  const bots = new BotService(database, dir, launcher, settings, { listProjects: () => [] }, {
    ...processes,
    holdTimers: () => [],
    releaseTimers: () => undefined
  }, {
    launched: (botId) => relay?.launched(botId),
    stopping: async (botId, processId) => { await relay?.stopping(botId, processId); },
    ...(options.log ? { log: options.log } : {})
  });
  const botRelay = new BotRelay(database, bots, codex, integrated, settings, inbox, options);
  relay = botRelay;
  botRelay.start();
  const id = ASSISTANT_BOT_ID;
  const state = (): BotRelayState => botRelay.state(id);
  const assistant = {
    ensure: async () => { await bots.ensure(id); return state(); },
    restart: async (processId: string) => { await bots.restart(id, false, processId); return state(); },
    newSession: async (processId: string) => { await bots.restart(id, true, processId); return state(); },
    state,
    handleNotification: (change: NotificationChange) => botRelay.handleNotification(change),
    startVoice: async (sdp: string) => { await bots.ensure(id); return botRelay.startVoice(id, sdp); },
    stopVoice: async () => { await botRelay.stopVoice(); return state(); },
    setFocus: (enabled: boolean) => botRelay.setFocus(id, enabled),
    focusItems: (input: { digestId?: string; limit: number; offset: number }) => botRelay.focusItems(id, input),
    deliverAgentMessage: (fromProcessId: string, message: string) => botRelay.deliverAgentMessage(id, fromProcessId, message),
    voiceActive: (processId: string) => botRelay.voiceActive(processId),
    onEvent: botRelay.onEvent.bind(botRelay),
    dispose: () => botRelay.dispose()
  };
  return { inbox, bots, relay: botRelay, assistant };
}

// Updates the assistant's bot settings.
export function setAssistant(settings: SettingsService, change: Record<string, unknown>): void {
  settings.updateBots({ ...settings.bots(), bots: settings.bots().bots.map((bot) => bot.id === ASSISTANT_BOT_ID ? { ...bot, ...change } : bot) });
}
