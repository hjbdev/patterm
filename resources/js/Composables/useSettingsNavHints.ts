import { computed, ref, type Ref } from 'vue';
import { useMcpServers } from '../lib/mcpServers';
import { useUpdates } from '../lib/updates';

export interface SettingsNavHint { text: string; tone?: 'warning' }

// Short states beside settings pages in the sidebar. Each one is worth
// noticing from outside its page; ordinary defaults show nothing.
export function useSettingsNavHints(options: { serverAccess: boolean; host?: Ref<string | null> }) {
  const { servers } = useMcpServers();
  const updates = useUpdates();
  const accessMode = ref<'local' | 'tailscale' | 'network' | null>(null);

  if (options.serverAccess) {
    void window.patterm.serverRemoteAccess?.()
      .then((view) => { accessMode.value = view.saved?.mode ?? view.running.mode; })
      .catch(() => { accessMode.value = null; });
  }

  return computed((): Record<string, SettingsNavHint> => {
    if (options.host?.value) return {};
    const hints: Record<string, SettingsNavHint> = {};
    const on = servers.value.filter((server) => server.enabled).length;
    if (servers.value.length) hints.mcp = { text: `${on} on` };
    if (accessMode.value === 'tailscale') hints.access = { text: 'Tailscale' };
    if (accessMode.value === 'network') hints.access = { text: 'Network' };
    if (updates.value?.status === 'available') hints.about = { text: 'Update', tone: 'warning' };
    return hints;
  });
}
