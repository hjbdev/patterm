import { z } from 'zod';
import { DISCORD_SNOWFLAKE } from '../Bots/BotSettings';
import { DISCORD_REPLY_LIMIT, DISCORD_REPLY_TARGET, type DiscordService } from '../Services/Discord/DiscordService';
import type { McpCallContext, McpToolRegistry } from './ToolRegistry';

export const DISCORD_TOOLS = ['bot_discord_status', 'bot_discord_token_set'] as const;

const replyInput = z.object({
  text: z.string().max(4000),
  message_id: z.string().trim().regex(DISCORD_SNOWFLAKE, 'use the message ID from the [Discord message …] line').optional()
}).strict();
const statusInput = z.object({ bot_id: z.string().min(1).optional() }).strict();
const tokenInput = z.object({
  bot_id: z.string().min(1),
  // Null removes the saved token.
  token: z.string().max(200).nullable()
}).strict();

export interface DiscordCaller {
  // The calling session's bot, or null for any other agent.
  botId(context: McpCallContext): string | null;
  // Whether the bot has Discord turned on in its settings.
  enabled(botId: string): boolean;
  // Whether the caller's catalogue lists discord_reply. Catalogues are read
  // while a session launches, before it is registered, so this can't use
  // the strict caller check.
  listed(context: McpCallContext): boolean;
}

export function registerDiscordTools(registry: McpToolRegistry, discord: Pick<DiscordService, 'reply' | 'status' | 'list' | 'setToken'>, callers: DiscordCaller) {
  const discordBot = (context: McpCallContext) => {
    if (context.remote) return null;
    const botId = callers.botId(context);
    return botId && callers.enabled(botId) ? botId : null;
  };
  registry.register({
    name: 'discord_reply',
    namespace: 'bots',
    description: `Bots with Discord: send the user a short Discord message, ${DISCORD_REPLY_TARGET} characters at most. With message_id it replies to that [Discord message …]; without it, it posts where they last messaged you.`,
    changes: [],
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', description: `Plain text, ${DISCORD_REPLY_TARGET} characters at most. Longer than ${DISCORD_REPLY_LIMIT} is rejected.` },
        message_id: { type: 'string', description: 'The ID from the [Discord message <id> …] line being answered. Omit for a later update.' }
      }
    },
    usageNotes: [
      'The user reads Discord like a pager: say what happened or what you need, not how. Keep the detail in Patterm.',
      'No threads or multi-message replies: one message per answer or update.'
    ],
    unavailable: (context) => !context.remote && callers.listed(context) ? null : 'Only bots with Discord turned on can call discord_reply'
  }, async (args, context) => {
    const botId = discordBot(context);
    if (!botId) throw new Error('discord_reply: only bots with Discord turned on can call this');
    const input = replyInput.parse(args ?? {});
    return discord.reply(botId, input);
  });

  registry.register(
    { name: 'bot_discord_status', namespace: 'bots', description: 'Read whether each bot is connected to Discord and has a token saved.', hidden: true, changes: [], inputSchema: { type: 'object' } },
    (args) => {
      const input = statusInput.parse(args ?? {});
      return input.bot_id ? discord.status(input.bot_id) : { bots: discord.list() };
    }
  );
  registry.register(
    { name: 'bot_discord_token_set', namespace: 'bots', description: 'Save or remove a bot\'s Discord bot token. It can\'t be read back.', hidden: true, changes: ['settings'], inputSchema: { type: 'object', required: ['bot_id', 'token'] } },
    (args) => {
      const input = tokenInput.parse(args);
      return discord.setToken(input.bot_id, input.token);
    }
  );
}
