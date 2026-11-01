import { reactive } from 'vue';
import { ASSISTANT_BOT_ID } from '../../../app/Bots/BotIdentity';
import { onBotRealtime, onBotState, refreshBotState, setBotFocus, startBotEvents, type BotRealtimeEvent, type BotRelayState } from './botRelay';

export type AssistantRealtimeEvent = Omit<BotRealtimeEvent, 'botId'>;

// The assistant, the built-in bot, shared by the dock, its sidebar row and
// the palette. Its settings live with the other bots in Settings › Bots.
export const assistant = reactive({
  loaded: false,
  // Hidden until the server says it is on, so a turned-off assistant never flashes in.
  enabled: false,
  processId: null as string | null,
  // Voice needs voice on and a Codex profile.
  voiceAvailable: false,
  voiceActive: false,
  // Focus mode holds notifications, agent messages, reports, and timer
  // callbacks for the assistant; pending counts what is held.
  focusAllowed: false,
  focus: false,
  focusPending: 0,
  // True while the panel or the palette restarts the assistant.
  restarting: false,
  error: ''
});

function apply(state: BotRelayState): void {
  if (state.bot_id !== ASSISTANT_BOT_ID) return;
  assistant.enabled = state.enabled;
  assistant.processId = state.process_id;
  assistant.voiceAvailable = state.voice.available;
  assistant.voiceActive = state.voice.active;
  assistant.focusAllowed = state.focus.allowed;
  assistant.focus = state.focus.enabled;
  assistant.focusPending = state.focus.pending;
  assistant.loaded = true;
}

let listening = false;

export function startAssistantEvents(): void {
  if (listening) return;
  listening = true;
  onBotState(apply);
  startBotEvents();
  void refreshAssistant();
}

export function onAssistantRealtime(listener: (event: AssistantRealtimeEvent) => void): () => void {
  return onBotRealtime(ASSISTANT_BOT_ID, ({ method, params }) => listener({ method, params }));
}

export async function refreshAssistant(): Promise<void> {
  try {
    await refreshBotState(ASSISTANT_BOT_ID);
  } catch (error) {
    assistant.error = message(error);
  }
}

// Starts or resumes the assistant session and returns its process. It
// normally comes back by itself when Patterm starts, like every bot.
export async function ensureAssistant(): Promise<string | null> {
  assistant.error = '';
  try {
    await window.patterm.call('bot_start', { bot_id: ASSISTANT_BOT_ID });
    await refreshBotState(ASSISTANT_BOT_ID);
  } catch (error) {
    assistant.error = message(error);
  }
  return assistant.processId;
}

// Stops the assistant and resumes its thread in a new process. Like sending
// it a message, this needs control of its conversation. Throws, so the caller
// can say what failed.
export async function restartAssistant(processId: string): Promise<void> {
  return replaceAssistant(processId, false);
}

export async function newAssistantSession(processId: string): Promise<void> {
  return replaceAssistant(processId, true);
}

async function replaceAssistant(processId: string, fresh: boolean): Promise<void> {
  if (assistant.restarting) throw new Error('The assistant is already restarting. Wait for it to finish, then try again.');
  assistant.restarting = true;
  assistant.error = '';
  try {
    const args = { process_id: processId, fresh };
    await (window.patterm.integratedCall ? window.patterm.integratedCall('bot_restart', args) : window.patterm.call('bot_restart', args));
    await refreshAssistant();
  } catch (error) {
    // The old process may already have stopped.
    await refreshAssistant();
    assistant.error = message(error);
    throw error;
  } finally {
    assistant.restarting = false;
  }
}

// Turning focus off delivers everything held as one digest.
export async function setAssistantFocus(enabled: boolean): Promise<void> {
  assistant.error = '';
  try {
    await setBotFocus(ASSISTANT_BOT_ID, enabled);
  } catch (error) {
    assistant.error = message(error);
  }
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
