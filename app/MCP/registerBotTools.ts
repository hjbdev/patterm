import { z } from 'zod';
import type { BotService } from '../Services/BotService';
import type { SettingsService } from '../Services/SettingsService';
import type { McpToolRegistry } from './ToolRegistry';

const botRestartInput = z.object({
  bot_id: z.string().min(1),
  // Start a new conversation instead of resuming the current one.
  fresh: z.boolean().default(false)
});

// Owner-only bot controls for Settings › Bots and the sidebar.
export function registerBotTools(registry: McpToolRegistry, bots: Pick<BotService, 'list' | 'reconcile' | 'restart'>, settings: Pick<SettingsService, 'bots' | 'updateBots'>, log: (event: string, data: Record<string, unknown>) => void) {
  registry.register(
    { name: 'settings_bots_get', namespace: 'settings', description: 'Read the bots and which of them are running.', hidden: true, changes: [], inputSchema: { type: 'object' } },
    () => ({ ...settings.bots(), states: bots.list() })
  );
  registry.register(
    { name: 'settings_bots_update', namespace: 'settings', description: 'Save the bots. New bots start and removed ones stop.', hidden: true, changes: ['settings'], inputSchema: { type: 'object', required: ['bots'] } },
    (args) => {
      const saved = settings.updateBots(args);
      // Starting a bot can take a while; the workbench shows it when it's up.
      void bots.reconcile().catch((error: unknown) => log('reconcile.failed', { message: error instanceof Error ? error.message : String(error) }));
      return saved;
    }
  );
  registry.register(
    { name: 'bot_restart', namespace: 'bots', description: 'Restart a bot on its conversation, or with fresh true on a new one.', hidden: true, changes: ['workbench'], inputSchema: { type: 'object', required: ['bot_id'] } },
    (args) => {
      const input = botRestartInput.parse(args);
      return bots.restart(input.bot_id, input.fresh);
    }
  );
}
