import { reactive } from 'vue';

export interface AssistantRealtimeEvent {
  method: string;
  params: Record<string, unknown>;
}

interface AssistantStatePayload {
  process_id: string | null;
  voice: { active: boolean };
  // Older servers send no focus state.
  focus?: { enabled: boolean; since: string | null; pending: number };
}

// The global assistant, shared by the floating panel and settings.
export const assistant = reactive({
  loaded: false,
  processId: null as string | null,
  voiceActive: false,
  // Focus mode holds notifications, agent messages, reports, and timer
  // callbacks for the assistant; pending counts what is held.
  focus: false,
  focusPending: 0,
  // True while the panel or the palette restarts the assistant.
  restarting: false,
  error: ''
});

const realtimeListeners = new Set<(event: AssistantRealtimeEvent) => void>();
let listening = false;

function apply(state: AssistantStatePayload): void {
  assistant.processId = state.process_id;
  assistant.voiceActive = state.voice.active;
  assistant.focus = state.focus?.enabled ?? false;
  assistant.focusPending = state.focus?.pending ?? 0;
  assistant.loaded = true;
}

function isState(value: unknown): value is AssistantStatePayload {
  return Boolean(value) && typeof value === 'object' && 'process_id' in (value as object) && 'voice' in (value as object);
}

export function startAssistantEvents(): void {
  if (listening) return;
  listening = true;
  window.patterm.onAssistantEvent((raw) => {
    const event = raw as { type?: string; state?: unknown; method?: unknown; params?: unknown };
    if (event.type === 'state' && isState(event.state)) apply(event.state);
    else if (event.type === 'realtime' && typeof event.method === 'string') {
      const params = event.params && typeof event.params === 'object' ? event.params as Record<string, unknown> : {};
      for (const listener of realtimeListeners) listener({ method: event.method, params });
    }
  });
  // A backgrounded app can lose its socket while the voice call carries on
  // directly with OpenAI; catch up on whatever changed meanwhile.
  window.patterm.onConnectionChanged?.((state) => { if (state === 'connected') void refreshAssistant(); });
  void refreshAssistant();
}

export function onAssistantRealtime(listener: (event: AssistantRealtimeEvent) => void): () => void {
  realtimeListeners.add(listener);
  return () => { realtimeListeners.delete(listener); };
}

export async function refreshAssistant(): Promise<void> {
  try {
    const state = await window.patterm.call('patterm.assistant.get', {});
    if (isState(state)) apply(state);
  } catch (error) {
    assistant.error = message(error);
  }
}

// Starts or resumes the assistant session and returns its process.
export async function ensureAssistant(): Promise<string | null> {
  assistant.error = '';
  try {
    const state = await window.patterm.call('patterm.assistant.ensure', {});
    if (isState(state)) apply(state);
  } catch (error) {
    assistant.error = message(error);
  }
  return assistant.processId;
}

// Stops the assistant and resumes its thread in a new process. Like sending
// it a message, this needs control of its conversation. Throws, so the caller
// can say what failed.
export async function restartAssistant(processId: string): Promise<void> {
  if (assistant.restarting) return;
  assistant.restarting = true;
  assistant.error = '';
  try {
    const args = { process_id: processId };
    const state = await (window.patterm.integratedCall ? window.patterm.integratedCall('patterm.assistant.restart', args) : window.patterm.call('patterm.assistant.restart', args));
    if (isState(state)) apply(state);
  } catch (error) {
    // The old process may already have stopped.
    await refreshAssistant();
    throw error;
  } finally {
    assistant.restarting = false;
  }
}

// Turning focus off delivers everything held as one digest.
export async function setAssistantFocus(enabled: boolean): Promise<void> {
  assistant.error = '';
  try {
    const state = await window.patterm.call('patterm.assistant.focus.set', { enabled });
    if (isState(state)) apply(state);
  } catch (error) {
    assistant.error = message(error);
  }
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type AssistantVoiceProfile = 'codex' | 'patterm';
export type AssistantVoiceAcknowledgements = 'default' | 'on' | 'off';

export interface AssistantSettings {
  voice: string | null;
  presetId: string | null;
  forwardNotifications: boolean;
  voiceProfile: AssistantVoiceProfile;
  voiceAcknowledgements: AssistantVoiceAcknowledgements;
  userName: string | null;
}

export async function loadAssistantSettings(): Promise<{ settings: AssistantSettings; voices: string[] }> {
  return await window.patterm.call('patterm.settings.assistant.get', {}) as { settings: AssistantSettings; voices: string[] };
}

export async function saveAssistantSettings(settings: AssistantSettings): Promise<AssistantSettings> {
  return await window.patterm.call('patterm.settings.assistant.update', settings) as AssistantSettings;
}
