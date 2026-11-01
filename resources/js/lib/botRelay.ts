import { reactive } from 'vue';

// What reaches each bot besides the user: its session, voice call and Focus
// state, kept live by the server's bot events. Mirrors app/Services/BotRelay.

export interface BotRelayState {
  bot_id: string;
  enabled: boolean;
  process_id: string | null;
  // available: voice is on and the bot runs a Codex profile.
  voice: { available: boolean; active: boolean };
  // allowed: the bot may use Focus mode at all.
  focus: { enabled: boolean; since: string | null; pending: number; allowed: boolean };
}

export interface BotRealtimeEvent {
  botId: string;
  method: string;
  params: Record<string, unknown>;
}

export const botStates = reactive<Record<string, BotRelayState>>({});

const stateListeners = new Set<(state: BotRelayState) => void>();
const realtimeListeners = new Set<(event: BotRealtimeEvent) => void>();
let listening = false;

export function isBotState(value: unknown): value is BotRelayState {
  const state = value as Partial<BotRelayState> | null;
  return Boolean(state) && typeof state === 'object' && typeof state!.bot_id === 'string' && 'process_id' in state! && typeof state!.voice === 'object' && typeof state!.focus === 'object';
}

export function applyBotState(state: BotRelayState): void {
  botStates[state.bot_id] = state;
  for (const listener of stateListeners) listener(state);
}

export function startBotEvents(): void {
  if (listening) return;
  listening = true;
  window.patterm.onAssistantEvent((raw) => {
    const event = raw as { type?: string; state?: unknown; bot_id?: unknown; method?: unknown; params?: unknown };
    if (event.type === 'state' && isBotState(event.state)) applyBotState(event.state);
    else if (event.type === 'realtime' && typeof event.method === 'string' && typeof event.bot_id === 'string') {
      const params = event.params && typeof event.params === 'object' ? event.params as Record<string, unknown> : {};
      for (const listener of realtimeListeners) listener({ botId: event.bot_id, method: event.method, params });
    }
  });
  // A backgrounded app can lose its socket while a voice call carries on
  // directly with OpenAI; catch up on whatever changed meanwhile.
  window.patterm.onConnectionChanged?.((state) => { if (state === 'connected') void refreshBotStates(); });
  void refreshBotStates();
}

export async function refreshBotStates(): Promise<void> {
  const result = await window.patterm.call('bot_state', {}) as { bots?: unknown[] } | null;
  for (const state of result?.bots ?? []) if (isBotState(state)) applyBotState(state);
}

export async function refreshBotState(botId: string): Promise<BotRelayState | null> {
  const state = await window.patterm.call('bot_state', { bot_id: botId });
  if (!isBotState(state)) return null;
  applyBotState(state);
  return state;
}

export function onBotState(listener: (state: BotRelayState) => void): () => void {
  stateListeners.add(listener);
  return () => { stateListeners.delete(listener); };
}

export function onBotRealtime(botId: string, listener: (event: BotRealtimeEvent) => void): () => void {
  const scoped = (event: BotRealtimeEvent) => { if (event.botId === botId) listener(event); };
  realtimeListeners.add(scoped);
  return () => { realtimeListeners.delete(scoped); };
}

// Turning focus off delivers everything held as one digest.
export async function setBotFocus(botId: string, enabled: boolean): Promise<void> {
  const state = await window.patterm.call('bot_set_focus_mode', { bot_id: botId, enabled });
  if (isBotState(state)) applyBotState(state);
}
