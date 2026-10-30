import { onMounted, shallowRef, watch } from 'vue';
import { topicChanged, topicRead, useTopicRefresh } from './serverQuery';
import { hasBrowser } from './browser';

// Mirrors SecretRecord in app/Services/Secrets/SecretService.ts. Values never
// reach the client.
export type SecretKind = 'api_key' | 'login';
export type SecretUse = 'env' | 'proxy' | 'browser';
export interface SecretInjection { in: 'header' | 'query'; name: string; prefix: string }
export interface SessionSecret {
  id: string;
  name: string;
  kind: SecretKind;
  purpose: string;
  status: 'requested' | 'ready';
  allowed_hosts: string[];
  uses: SecretUse[];
  injection: SecretInjection | null;
  created_at: string;
}
export interface SessionSecrets { secrets: SessionSecret[]; keyring_protected: boolean }

export interface SecretDraft {
  name: string;
  kind: SecretKind;
  values: { value: string } | { username: string; password: string } | null;
  allowed_hosts: string[];
  uses: SecretUse[];
  injection: SecretInjection | null;
}

export const USE_LABELS: Record<SecretUse, string> = { proxy: 'Proxy', env: 'Commands', browser: 'Browser' };

// Secrets stay on the agent's own host, like its browser.
export const hasSecrets = hasBrowser;

export function useSessionSecrets(processId: () => string | null | undefined) {
  const state = shallowRef<SessionSecrets | null>(null);
  let reads = 0;
  const load = async () => {
    const id = processId();
    const read = ++reads;
    if (!hasSecrets(id)) { state.value = null; return; }
    try {
      const next = await topicRead('secrets', ['secret_session_list', id], async () => await window.patterm.call('secret_session_list', { process_id: id }) as SessionSecrets);
      if (read === reads) state.value = next;
    } catch {
      if (read === reads) state.value = null;
    }
  };
  useTopicRefresh(['secrets'], () => void load());
  watch(processId, () => void load());
  onMounted(() => { void load(); });
  return state;
}

// Answering messages the agent, so a browser client sends it over its socket
// as the agent's controller.
export async function secretControl(tool: 'secret_save' | 'secret_remove', args: { process_id: string } & Record<string, unknown>): Promise<unknown> {
  const result = await (window.patterm.integratedCall ? window.patterm.integratedCall(tool, args) : window.patterm.call(tool, args));
  topicChanged('secrets');
  return result;
}
