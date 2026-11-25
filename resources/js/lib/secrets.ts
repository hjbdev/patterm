import { onBeforeUnmount, onMounted, shallowRef, watch } from 'vue';
import type { NotificationChange } from '../Composables/useNotifications';
import { topicChanged, topicRead, useTopicRefresh } from './serverQuery';

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
  expires_at: string | null;
  created_at: string;
}
export interface SessionSecrets { secrets: SessionSecret[]; keyring_protected: boolean }

export interface SecretDraft {
  name: string;
  kind: SecretKind;
  values: { value: string } | { username: string; password: string } | null;
  // How long new values last; ignored without them.
  lifetime_days: number;
  allowed_hosts: string[];
  uses: SecretUse[];
  injection: SecretInjection | null;
}

// Mirrors SECRET_LIFETIME_DAYS in app/Services/Secrets/SecretService.ts.
export const SECRET_LIFETIMES = [
  { days: 1, label: '1 day' }, { days: 7, label: '7 days' }, { days: 30, label: '30 days' }, { days: 90, label: '90 days' }, { days: 365, label: '1 year' }
] as const;

export const USE_LABELS: Record<SecretUse, string> = { proxy: 'Proxy', env: 'Commands', browser: 'Browser' };

// Write-only session secrets work for both local and paired-host agents;
// values stay in the agent's own host vault and never return to clients.
export function hasSecrets(processId: string | null | undefined): processId is string {
  return Boolean(processId);
}

export function useSessionSecrets(processId: () => string | null | undefined) {
  const state = shallowRef<SessionSecrets | null>(null);
  let reads = 0;
  const load = async () => {
    const id = processId();
    const read = ++reads;
    if (!hasSecrets(id)) { state.value = null; return; }
    try {
      const next = id.includes(':')
        ? await window.patterm.call('secret_session_list', { process_id: id }) as SessionSecrets
        : await topicRead('secrets', ['secret_session_list', id], async () => await window.patterm.call('secret_session_list', { process_id: id }) as SessionSecrets);
      if (read === reads) state.value = next;
    } catch {
      if (read === reads) state.value = null;
    }
  };
  useTopicRefresh(['secrets'], () => void load());
  // Paired hosts announce secret requests/settlements via streamed notifications
  // rather than the local `secrets` topic, so refresh remote agents on those.
  let unsubscribeNotifications: (() => void) | undefined;
  watch(processId, () => void load());
  onMounted(() => {
    void load();
    unsubscribeNotifications = window.patterm?.onNotificationsChanged?.((raw) => {
      const id = processId();
      if (!id || !id.includes(':')) return;
      const change = raw as NotificationChange;
      if (change.type === 'reconnected' || change.type === 'reset') {
        void load();
      } else if ((change.type === 'raised' || change.type === 'updated') && change.notification.process_id === id) {
        void load();
      } else if (change.type === 'resolved') {
        void load();
      }
    });
  });
  onBeforeUnmount(() => { unsubscribeNotifications?.(); });
  return state;
}

// Answering messages the agent, so a browser client sends it over its socket
// as the agent's controller.
export async function secretControl(tool: 'secret_save' | 'secret_remove', args: { process_id: string } & Record<string, unknown>): Promise<unknown> {
  const result = await (window.patterm.integratedCall ? window.patterm.integratedCall(tool, args) : window.patterm.call(tool, args));
  topicChanged('secrets');
  return result;
}
