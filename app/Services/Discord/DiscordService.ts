import { z } from 'zod';
import type { Bot } from '../../Bots/BotSettings';
import type { DatabaseService } from '../DatabaseService';
import type { SettingsService } from '../SettingsService';
import type { BotService } from '../BotService';
import type { IntegratedAgentService } from '../IntegratedAgentService';
import { DiscordGateway, type DiscordGatewayEvents, type DiscordGatewayOptions, type DiscordGatewayStatus, type DiscordMessage, type DiscordUser } from './DiscordGateway';
import { DISCORD_TOKEN, type DiscordTokenStore } from './DiscordTokenStore';

// Replies are pager-sized: bots are asked for 300 characters and the tool
// allows a little leeway before rejecting.
export const DISCORD_REPLY_TARGET = 300;
export const DISCORD_REPLY_LIMIT = 350;
const RECENT_LIMIT = 100;
const ATTACHMENT_LIMIT = 5;
const RECEIVED_EMOJI = '👀';
const FAILED_EMOJI = '⚠️';
const STATE_KEY = 'bot.discord.v1';

export interface DiscordBotStatus {
  bot_id: string;
  enabled: boolean;
  token_saved: boolean;
  // off: Discord is off for the bot, or it can't run yet (no token or no
  // allowed users); `reason` says which.
  state: 'off' | 'connecting' | 'connected' | 'error';
  reason?: string;
  user?: { id: string; username: string };
  error?: string;
}

const recentInput = z.object({
  id: z.string(),
  channel_id: z.string(),
  author_id: z.string()
});
const stateInput = z.object({ recent: z.array(recentInput).default([]) });
type Recent = z.infer<typeof recentInput>;

type Gateway = Pick<DiscordGateway, 'start' | 'stop' | 'send' | 'react' | 'user'>;

interface Connection {
  token: string;
  gateway: Gateway;
  status: DiscordGatewayStatus;
}

export interface DiscordServiceOptions {
  log?: (event: string, data: Record<string, unknown>) => void;
  gateway?: (token: string, events: DiscordGatewayEvents, options: DiscordGatewayOptions) => Gateway;
}

// Connects bots to Discord. Each bot with Discord on runs its own Discord
// application. A mention or DM from an allowed user becomes a message in the
// bot's conversation; the bot answers with discord_reply. Nothing the bot
// says in Patterm reaches Discord on its own.
export class DiscordService {
  private readonly connections = new Map<string, Connection>();
  private disposed = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly settings: Pick<SettingsService, 'bots'>,
    private readonly tokens: DiscordTokenStore,
    private readonly bots: Pick<BotService, 'currentProcess' | 'ensure'>,
    private readonly integrated: Pick<IntegratedAgentService, 'prompt'>,
    private readonly options: DiscordServiceOptions = {}
  ) {}

  // Starts and stops connections to match the bots' settings and tokens.
  reconcile(): void {
    if (this.disposed) return;
    const bots = this.settings.bots().bots;
    this.tokens.retain(new Set(bots.map((bot) => bot.id)));
    const wanted = new Map<string, string>();
    for (const bot of bots) {
      const token = this.runnable(bot) ? this.tokens.get(bot.id) : null;
      if (token) wanted.set(bot.id, token);
    }
    for (const [botId, connection] of this.connections) {
      if (wanted.get(botId) !== connection.token) this.disconnect(botId);
    }
    for (const [botId, token] of wanted) {
      if (!this.connections.has(botId)) this.connect(botId, token);
    }
  }

  setToken(botId: string, token: string | null): DiscordBotStatus {
    if (!this.settings.bots().bots.some((bot) => bot.id === botId)) throw new Error(`Unknown bot: ${botId}`);
    const value = token?.trim() || null;
    if (value && !DISCORD_TOKEN.test(value)) throw new Error('That doesn\'t look like a Discord bot token. Copy it from the Bot page of your Discord application.');
    this.tokens.set(botId, value);
    // A new token is a new application: replies can't go to the old one's messages.
    this.forget(botId);
    this.reconcile();
    return this.status(botId);
  }

  status(botId: string): DiscordBotStatus {
    const bot = this.settings.bots().bots.find((candidate) => candidate.id === botId);
    const tokenSaved = this.tokens.has(botId);
    const base = { bot_id: botId, enabled: Boolean(bot?.discord.enabled), token_saved: tokenSaved };
    const connection = this.connections.get(botId);
    if (!connection) {
      const reason = !bot?.discord.enabled ? 'Discord is off for this bot'
        : !bot.enabled ? 'The bot is turned off'
          : !tokenSaved ? 'Save the Discord bot token'
            : !bot.discord.allowedUserIds.length ? 'Add your Discord user ID'
              : 'Not connected';
      return { ...base, state: 'off', reason };
    }
    const status = connection.status;
    if (status.state === 'connected') return { ...base, state: 'connected', user: { id: status.user.id, username: status.user.username } };
    if (status.state === 'error') return { ...base, state: 'error', error: status.retrying ? `${status.message}; retrying` : status.message };
    return { ...base, state: 'connecting' };
  }

  list(): DiscordBotStatus[] {
    return this.settings.bots().bots.map((bot) => this.status(bot.id));
  }

  // Whether a bot has Discord turned on, connected or not.
  enabledFor(botId: string): boolean {
    const bot = this.settings.bots().bots.find((candidate) => candidate.id === botId);
    return Boolean(bot?.discord.enabled);
  }

  anyEnabled(): boolean {
    return this.settings.bots().bots.some((bot) => bot.discord.enabled);
  }

  // Sends a bot's reply to a message an allowed user sent it, in that
  // message's channel, so an update never lands somewhere more public than
  // the request it answers.
  async reply(botId: string, input: { text: string; message_id: string }): Promise<{ sent: true; message_id: string; length: number }> {
    const connection = this.connections.get(botId);
    if (!connection) throw new Error('discord_reply: Discord isn\'t set up for this bot');
    if (connection.status.state !== 'connected') throw new Error('discord_reply: the bot isn\'t connected to Discord right now; try again later');
    const text = input.text.trim();
    const length = [...text].length;
    if (!length) throw new Error('discord_reply: text is empty');
    if (length > DISCORD_REPLY_LIMIT) {
      throw new Error(`discord_reply: ${length} characters is too long. Discord replies are at most ${DISCORD_REPLY_LIMIT}; aim for ${DISCORD_REPLY_TARGET}. Shorten it and send again; keep the detail in Patterm.`);
    }
    const target = this.recent(botId).find((message) => message.id === input.message_id);
    const allowed = this.settings.bots().bots.find((bot) => bot.id === botId)?.discord.allowedUserIds ?? [];
    if (!target || !allowed.includes(target.author_id)) {
      throw new Error('discord_reply: that isn\'t a recent Discord message from the user; use the message_id from the [Discord message …] line you are answering');
    }
    // Replying pings the user, in the channel they asked in.
    const sent = await connection.gateway.send(target.channel_id, {
      content: text,
      message_reference: { message_id: target.id, channel_id: target.channel_id, fail_if_not_exists: false },
      allowed_mentions: { parse: [], replied_user: true }
    });
    this.log('reply.sent', { bot_id: botId, length });
    return { sent: true, message_id: sent.id, length };
  }

  dispose(): void {
    this.disposed = true;
    for (const botId of [...this.connections.keys()]) this.disconnect(botId);
  }

  private runnable(bot: Bot): boolean {
    return bot.enabled && bot.discord.enabled && bot.discord.allowedUserIds.length > 0;
  }

  private connect(botId: string, token: string): void {
    const events: DiscordGatewayEvents = {
      status: (status) => this.statusChanged(botId, connection, status),
      message: (message, self) => { void this.received(botId, connection, message, self); }
    };
    const gatewayOptions: DiscordGatewayOptions = { log: (event, data) => this.log(`gateway.${event}`, { bot_id: botId, ...data }) };
    const gateway = this.options.gateway ? this.options.gateway(token, events, gatewayOptions) : new DiscordGateway(token, events, gatewayOptions);
    const connection: Connection = { token, gateway, status: { state: 'connecting' } };
    this.connections.set(botId, connection);
    gateway.start();
  }

  private disconnect(botId: string): void {
    const connection = this.connections.get(botId);
    if (!connection) return;
    this.connections.delete(botId);
    connection.gateway.stop();
  }

  private statusChanged(botId: string, connection: Connection, status: DiscordGatewayStatus): void {
    if (this.connections.get(botId) !== connection) return;
    if (status.state === 'connected') {
      // Two bots on one Discord application would both answer every message.
      const shared = [...this.connections].find(([otherId, other]) => otherId !== botId
        && other.status.state === 'connected' && other.status.user.id === status.user.id);
      if (shared) {
        connection.gateway.stop();
        connection.status = { state: 'error', message: 'Another bot already uses this Discord application', retrying: false };
        return;
      }
    }
    if (status.state === 'stopped') return;
    connection.status = status;
    this.log('status', { bot_id: botId, state: status.state, ...(status.state === 'error' ? { message: status.message } : {}) });
  }

  private async received(botId: string, connection: Connection, message: DiscordMessage, self: DiscordUser): Promise<void> {
    if (this.connections.get(botId) !== connection) return;
    const bot = this.settings.bots().bots.find((candidate) => candidate.id === botId);
    if (!bot || !this.runnable(bot)) return;
    if (message.author.bot || message.author.id === self.id) return;
    const dm = !message.guild_id;
    // In a server the bot answers only when mentioned; DMs are always to it.
    if (!dm && !(message.mentions ?? []).some((user) => user.id === self.id)) return;
    // Everyone else is ignored without a trace, so the bot can't be probed.
    if (!bot.discord.allowedUserIds.includes(message.author.id)) {
      this.log('message.ignored', { bot_id: botId, reason: 'not_allowed' });
      return;
    }
    const text = message.content.replace(new RegExp(`<@!?${self.id}>`, 'g'), '').trim();
    const attachments = (message.attachments ?? []).slice(0, ATTACHMENT_LIMIT);
    if (!text && !attachments.length) return;
    // Discord can deliver an event twice, such as across a resume.
    if (this.recent(botId).some((entry) => entry.id === message.id)) return;
    this.remember(botId, { id: message.id, channel_id: message.channel_id, author_id: message.author.id });
    void connection.gateway.react(message.channel_id, message.id, RECEIVED_EMOJI)
      .catch((error: unknown) => this.log('react.failed', { bot_id: botId, message: errorMessage(error) }));
    try {
      let processId = this.bots.currentProcess(botId);
      if (!processId) {
        await this.bots.ensure(botId);
        processId = this.bots.currentProcess(botId);
      }
      if (!processId) throw new Error(`${bot.name} isn't running`);
      const result = await this.integrated.prompt(processId, discordPrompt(message.id, dm, text, attachments)) as { delivery?: unknown } | void;
      this.log('message.delivered', { bot_id: botId, delivery: (result as { delivery?: unknown } | undefined)?.delivery ?? 'delivered' });
    } catch (error) {
      // Only the bot speaks on Discord; the reason stays in Patterm's log.
      this.log('message.failed', { bot_id: botId, message: errorMessage(error) });
      await connection.gateway.react(message.channel_id, message.id, FAILED_EMOJI).catch(() => undefined);
    }
  }

  private recent(botId: string): Recent[] {
    const row = this.database.connection.prepare('select value from settings where key = ?').get(stateKey(botId)) as { value: string } | undefined;
    if (!row) return [];
    try { return stateInput.parse(JSON.parse(row.value)).recent; } catch { return []; }
  }

  private remember(botId: string, message: Recent): void {
    const recent = [...this.recent(botId).filter((entry) => entry.id !== message.id), message].slice(-RECENT_LIMIT);
    this.database.connection.prepare(`insert into settings (key, value, updated_at) values (?, ?, ?)
      on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`).run(stateKey(botId), JSON.stringify({ recent }), new Date().toISOString());
  }

  private forget(botId: string): void {
    this.database.connection.prepare('delete from settings where key = ?').run(stateKey(botId));
  }

  private log(event: string, data: Record<string, unknown>): void {
    this.options.log?.(event, data);
  }
}

// What a Discord message looks like in the bot's conversation.
export function discordPrompt(messageId: string, dm: boolean, text: string, attachments: NonNullable<DiscordMessage['attachments']> = []): string {
  const files = attachments.map((file) => `- ${file.filename.slice(0, 120)}: ${file.url}`);
  return [
    `[Discord message ${messageId} from the user, ${dm ? 'in a DM' : 'in a server channel'}]`,
    text,
    ...(files.length ? ['Attachments:', ...files] : []),
    `(They only see what you send with discord_reply, message_id ${messageId}: ${DISCORD_REPLY_TARGET} characters at most. Later updates on this reply to the same message_id.)`
  ].filter(Boolean).join('\n');
}

function stateKey(botId: string): string {
  return `${STATE_KEY}:${botId}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
