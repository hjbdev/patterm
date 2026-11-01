import { z } from 'zod';
import { BOT_VOICES } from '../Bots/BotIdentity';
import type { BotService } from '../Services/BotService';
import type { BotRelay } from '../Services/BotRelay';
import type { SettingsService } from '../Services/SettingsService';
import type { McpToolRegistry } from './ToolRegistry';

const botStartInput = z.object({ bot_id: z.string().min(1), fresh: z.boolean().default(false) });
const botRestartInput = z.object({
  // The bot's current process. Browsers send this over their socket, which
  // checks they control it, like any write to an Integrated session.
  process_id: z.string().min(1),
  // Start a new conversation instead of resuming the current one.
  fresh: z.boolean().default(false)
});
const botStateInput = z.object({ bot_id: z.string().min(1).optional() }).strict();
// A browser's SDP offer for one audio track and a data channel is a few KiB.
const voiceStartInput = z.object({ bot_id: z.string().min(1), sdp: z.string().min(1).max(64 * 1024) }).strict();
// A client hangs up its own call by ID, or cancels its bot's call still
// connecting when it has no ID yet.
const voiceStopInput = z.object({ bot_id: z.string().min(1).optional(), call_id: z.string().min(1).optional() }).strict();
const focusSetInput = z.object({ bot_id: z.string().min(1), enabled: z.boolean() }).strict();

// Owner-only bot controls for Settings › Bots, the bot's page and the
// assistant's dock.
export function registerBotTools(
  registry: McpToolRegistry,
  bots: Pick<BotService, 'list' | 'reconcile' | 'ensure' | 'restartProcess'>,
  relay: Pick<BotRelay, 'list' | 'state' | 'settingsChanged' | 'startVoice' | 'hangUp' | 'setFocus'>,
  settings: Pick<SettingsService, 'bots' | 'updateBots'>,
  log: (event: string, data: Record<string, unknown>) => void
) {
  registry.register(
    { name: 'settings_bots_get', namespace: 'settings', description: 'Read the bots, which of them are running, and the available voices.', hidden: true, changes: [], inputSchema: { type: 'object' } },
    () => ({ ...settings.bots(), states: bots.list(), voices: [...BOT_VOICES] })
  );
  registry.register(
    { name: 'settings_bots_update', namespace: 'settings', description: 'Save the bots. New and turned-on bots start; removed and turned-off ones stop.', hidden: true, changes: ['settings'], inputSchema: { type: 'object', required: ['bots'] } },
    async (args) => {
      const saved = settings.updateBots(args);
      await relay.settingsChanged();
      // Starting a bot can take a while; the workbench shows it when it's up.
      void bots.reconcile().catch((error: unknown) => log('reconcile.failed', { message: error instanceof Error ? error.message : String(error) }));
      return saved;
    }
  );
  registry.register(
    { name: 'bot_state', namespace: 'bots', description: 'Read one bot\'s session, voice and Focus state, or every bot\'s.', hidden: true, changes: [], inputSchema: { type: 'object' } },
    (args) => {
      const input = botStateInput.parse(args ?? {});
      return input.bot_id ? relay.state(input.bot_id) : { bots: relay.list() };
    }
  );
  registry.register(
    { name: 'bot_start', namespace: 'bots', description: 'Start a bot that isn\'t running, resuming its conversation, or with fresh true on a new one. A running bot is left as it is.', hidden: true, changes: ['workbench'], inputSchema: { type: 'object', required: ['bot_id'] } },
    (args) => {
      const input = botStartInput.parse(args);
      return bots.ensure(input.bot_id, input.fresh);
    }
  );
  registry.register(
    { name: 'bot_restart', namespace: 'bots', description: 'Restart a running bot on its conversation, or with fresh true on a new one.', hidden: true, changes: ['workbench'], inputSchema: { type: 'object', required: ['process_id'] } },
    (args) => {
      const input = botRestartInput.parse(args);
      return bots.restartProcess(input.process_id, input.fresh);
    }
  );
  registry.register(
    { name: 'bot_voice_start', namespace: 'bots', description: 'Answer a WebRTC offer with a GPT-Live voice call on a bot\'s thread. The bot needs voice on and a Codex profile.', hidden: true, changes: [], inputSchema: { type: 'object', required: ['bot_id', 'sdp'] } },
    async (args) => {
      const input = voiceStartInput.parse(args);
      await bots.ensure(input.bot_id);
      return relay.startVoice(input.bot_id, input.sdp);
    }
  );
  registry.register(
    { name: 'bot_voice_stop', namespace: 'bots', description: 'End a voice call: the one call_id names, or a bot\'s call still connecting.', hidden: true, changes: [], inputSchema: { type: 'object' } },
    async (args) => {
      const input = voiceStopInput.parse(args ?? {});
      await relay.hangUp({ botId: input.bot_id, callId: input.call_id });
      return { bots: relay.list() };
    }
  );
  registry.register(
    { name: 'bot_set_focus_mode', namespace: 'bots', description: 'Turn a bot\'s Focus mode on or off.', hidden: true, changes: [], inputSchema: { type: 'object', required: ['bot_id', 'enabled'] } },
    (args) => {
      const input = focusSetInput.parse(args);
      return relay.setFocus(input.bot_id, input.enabled);
    }
  );
}
