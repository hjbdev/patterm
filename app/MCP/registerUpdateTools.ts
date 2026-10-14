import { z } from 'zod';
import type { UpdateService } from '../Services/UpdateService';
import type { McpToolRegistry } from './ToolRegistry';

export const UPDATE_TOOLS = ['settings_updates_get', 'settings_updates_update', 'settings_updates_check', 'settings_updates_apply'] as const;

const applyInput = z.object({ confirmed: z.literal(true) }).strict();

// Owner-only update controls for Settings › About. Paired hosts cannot call
// settings tools, so a peer never updates this machine.
export function registerUpdateTools(registry: McpToolRegistry, updates: Pick<UpdateService, 'state' | 'updateSettings' | 'check' | 'apply'>) {
  registry.register(
    { name: 'settings_updates_get', namespace: 'settings', description: 'Read the update status and update settings.', hidden: true, changes: [], inputSchema: { type: 'object' } },
    () => updates.state()
  );
  registry.register(
    { name: 'settings_updates_update', namespace: 'settings', description: 'Save update settings.', hidden: true, changes: ['updates'], inputSchema: { type: 'object' } },
    (args) => updates.updateSettings(args)
  );
  registry.register(
    { name: 'settings_updates_check', namespace: 'settings', description: 'Check for a Patterm update now.', hidden: true, changes: ['updates'], inputSchema: { type: 'object' } },
    () => updates.check()
  );
  registry.register(
    { name: 'settings_updates_apply', namespace: 'settings', description: 'Install the available update. On the desktop the caller then quits Patterm; the server restarts itself.', hidden: true, changes: ['updates'], inputSchema: { type: 'object', required: ['confirmed'] } },
    async (args) => {
      applyInput.parse(args);
      return updates.apply();
    }
  );
}
