import { onMounted, shallowRef, watch } from 'vue';
import { topicRead, useTopicRefresh } from './serverQuery';

// Mirrors BrowserState in app/Services/Browser/BrowserService.ts.
export interface BrowserTab { targetId: string; url: string; title: string }
export interface BrowserState {
  running: boolean;
  headed: boolean;
  version: string | null;
  install:
    | { status: 'absent' }
    | { status: 'downloading'; version: string; receivedBytes: number; totalBytes: number }
    | { status: 'extracting'; version: string }
    | { status: 'installed'; version: string }
    | { status: 'error'; error: string };
  tabs: BrowserTab[];
  activeTargetId: string | null;
  help: { reason: string; requestedAt: string } | null;
}

export interface BrowserFrame { seq: number; data: string | null; width?: number; height?: number; targetId?: string }

// Agents on a paired host keep their browsers there.
export function hasBrowser(processId: string | null | undefined): processId is string {
  return Boolean(processId && !processId.includes(':'));
}

// An agent's browser state, read again whenever any browser changes.
export function useBrowserState(processId: () => string | null | undefined) {
  const state = shallowRef<BrowserState | null>(null);
  let reads = 0;
  const load = async () => {
    const id = processId();
    const read = ++reads;
    if (!hasBrowser(id)) { state.value = null; return; }
    try {
      const next = await topicRead('browser', ['browser_state', id], async () => await window.patterm.call('browser_state', { process_id: id }) as BrowserState);
      if (read === reads) state.value = next;
    } catch {
      if (read === reads) state.value = null;
    }
  };
  useTopicRefresh(['browser'], () => void load());
  watch(processId, () => void load());
  onMounted(() => { void load(); });
  return state;
}

// Acting in a browser changes what every viewer sees, so a browser client
// sends it over its socket as the agent's controller.
export function browserControl(tool: 'browser_input' | 'browser_navigate' | 'browser_select_tab' | 'browser_help_done' | 'browser_help_decline', args: { process_id: string } & Record<string, unknown>): Promise<unknown> {
  return window.patterm.integratedCall ? window.patterm.integratedCall(tool, args) : window.patterm.call(tool, args);
}

// A frame's JPEG bytes. Decoding runs once per streamed frame on the main
// thread, so it uses the native decoder where there is one: it is about a
// hundred times faster than mapping atob's string a character at a time.
const nativeBase64 = (Uint8Array as { fromBase64?: (data: string) => Uint8Array<ArrayBuffer> }).fromBase64;
export function frameBytes(data: string): Uint8Array<ArrayBuffer> {
  if (nativeBase64) return nativeBase64(data);
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function nextFrame(processId: string, after: number): Promise<BrowserFrame> {
  return window.patterm.call('browser_frame', { process_id: processId, after }) as Promise<BrowserFrame>;
}

// CDP's modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8.
export function modifierBits(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

const VIRTUAL_KEYS: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, Escape: 27, ' ': 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46
};

// The CDP key events for one key press in the viewer. Printable keys carry
// their text; shortcuts with Ctrl or Meta and editing keys go as raw keys.
export function keyEvents(event: KeyboardEvent): Array<Record<string, unknown>> {
  const modifiers = modifierBits(event);
  // Character codes match Windows virtual keys only for ASCII letters and
  // digits. For example, '.' is character 46, but virtual key 46 is Delete.
  const code = VIRTUAL_KEYS[event.key] ?? (/^[a-z0-9]$/i.test(event.key) ? event.key.toUpperCase().charCodeAt(0) : undefined);
  const base = { key: event.key, code: event.code, modifiers, ...(code !== undefined && code < 256 ? { windowsVirtualKeyCode: code } : {}) };
  const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey;
  const text = printable ? event.key : event.key === 'Enter' ? '\r' : undefined;
  return [
    { kind: 'key', type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text } : {}) },
    { kind: 'key', type: 'keyUp', ...base }
  ];
}
