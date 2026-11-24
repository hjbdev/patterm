import type { AgentAdapterRegistry } from '../Agents/AgentAdapterRegistry';
import { IDLE_COMPACTION_AFTER_MS } from '../Services/IdleCompactionService';
import type { SettingsService } from '../Services/SettingsService';
import type { McpToolRegistry } from './ToolRegistry';

// Owner-only controls for compacting idle agents before their cache expires.
export function registerIdleCompactionTools(
  registry: McpToolRegistry,
  settings: Pick<SettingsService, 'idleCompactionSettings' | 'updateIdleCompactionSettings'>,
  adapters?: AgentAdapterRegistry
) {
  const afterMinutes = (): Record<string, number> => {
    if (adapters) {
      const entries = adapters.byCapability((cap) => cap.compaction.defaultCacheTtlMs !== null);
      if (entries.length) {
        return Object.fromEntries(entries.map(({ id }) => [id, Math.round((adapters.capabilities(id).compaction.defaultCacheTtlMs ?? 0) / 60_000)]));
      }
    }
    return Object.fromEntries(Object.entries(IDLE_COMPACTION_AFTER_MS).map(([harness, ms]) => [harness, Math.round((ms ?? 0) / 60_000)]));
  };
  registry.register(
    { name: 'settings_idle_compaction_get', namespace: 'settings', description: 'Read idle compaction settings and each harness\'s idle time in minutes.', hidden: true, changes: [], inputSchema: { type: 'object' } },
    () => ({
      settings: settings.idleCompactionSettings(),
      afterMinutes: afterMinutes()
    })
  );
  registry.register(
    { name: 'settings_idle_compaction_update', namespace: 'settings', description: 'Save idle compaction settings.', hidden: true, changes: ['settings'], inputSchema: { type: 'object', required: ['claude', 'codex', 'opencode'] } },
    (args) => settings.updateIdleCompactionSettings(args)
  );
}
