import WebSocket from 'ws';

// One Discord bot connection: the gateway WebSocket that delivers messages,
// and the few REST calls the bot makes. A personal bot runs one shard, so
// this keeps to the documented gateway lifecycle (hello, identify or resume,
// heartbeats, reconnects) without a client library.

export const DISCORD_API = 'https://discord.com/api/v10';
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
// GUILD_MESSAGES | DIRECT_MESSAGES. Message content is a privileged intent,
// but Discord includes it for messages that mention the bot and for DMs,
// which are the only messages the bot answers. The gateway never asks for
// it: the message such a mention replies to is fetched on its own, which
// needs only Message Content turned on for the application.
const INTENTS = (1 << 9) | (1 << 12);
// A reply, the only message type whose referenced_message is the message replied to.
export const DISCORD_REPLY_TYPE = 19;
const USER_AGENT = 'DiscordBot (patterm, 1)';
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000];
const REST_TIMEOUT_MS = 15_000;
const MAX_RATE_LIMIT_WAIT_MS = 10_000;

// Close codes after which reconnecting can't help: the token or intents are
// wrong, so the owner has to change something first.
const FATAL_CLOSE_CODES: Record<number, string> = {
  4004: 'Discord rejected the bot token',
  4010: 'Discord rejected the shard',
  4011: 'The bot is in too many servers to run without sharding',
  4012: 'Discord rejected the gateway version',
  4013: 'Discord rejected the gateway intents',
  4014: 'The Discord application isn\'t allowed the intents it needs'
};
// Close codes after which the session can't be resumed.
const FRESH_SESSION_CODES = new Set([4007, 4009]);

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  bot?: boolean;
}

export interface DiscordApplication {
  id: string;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: DiscordUser;
  content: string;
  mentions?: DiscordUser[];
  attachments?: Array<{ id: string; filename: string; url: string; size?: number }>;
  type?: number;
  message_reference?: { message_id?: string; channel_id?: string };
  // For a reply: the message replied to, null once deleted, or absent when
  // Discord didn't look it up.
  referenced_message?: DiscordMessage | null;
}

export type DiscordGatewayStatus =
  | { state: 'connecting' }
  | { state: 'connected'; user: DiscordUser; application: DiscordApplication | null }
  | { state: 'error'; message: string; retrying: boolean }
  | { state: 'stopped' };

export interface DiscordGatewayEvents {
  status(status: DiscordGatewayStatus): void;
  message(message: DiscordMessage, self: DiscordUser): void;
}

interface GatewayPayload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

type Socket = Pick<WebSocket, 'send' | 'close' | 'on' | 'readyState'>;

export interface DiscordGatewayOptions {
  connect?: (url: string) => Socket;
  fetch?: typeof fetch;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export class DiscordGateway {
  private socket: Socket | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private sequence: number | null = null;
  private session: { id: string; resumeUrl: string } | null = null;
  private acked = true;
  private attempts = 0;
  private stopped = false;
  private self: DiscordUser | null = null;
  private application: DiscordApplication | null = null;

  constructor(
    private readonly token: string,
    private readonly events: DiscordGatewayEvents,
    private readonly options: DiscordGatewayOptions = {}
  ) {}

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try { socket.close(1000); } catch { /* already closed */ }
    }
    this.events.status({ state: 'stopped' });
  }

  user(): DiscordUser | null {
    return this.self;
  }

  // Posts a message. A reply names the message it answers.
  async send(channelId: string, body: Record<string, unknown>): Promise<{ id: string }> {
    const result = await this.rest('POST', `/channels/${channelId}/messages`, body);
    return { id: String((result as { id?: unknown } | null)?.id ?? '') };
  }

  async message(channelId: string, messageId: string): Promise<DiscordMessage> {
    return await this.rest('GET', `/channels/${channelId}/messages/${messageId}`) as DiscordMessage;
  }

  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.rest('PUT', `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
  }

  private open(): void {
    if (this.stopped) return;
    this.events.status({ state: 'connecting' });
    const url = this.session?.resumeUrl ? `${this.session.resumeUrl}/?v=10&encoding=json` : GATEWAY_URL;
    let socket: Socket;
    try {
      socket = this.options.connect ? this.options.connect(url) : new WebSocket(url, { handshakeTimeout: 15_000 });
    } catch (error) {
      this.scheduleReconnect(errorMessage(error));
      return;
    }
    this.socket = socket;
    socket.on('message', (data: WebSocket.RawData) => {
      if (this.socket !== socket) return;
      let payload: GatewayPayload;
      try { payload = JSON.parse(data.toString()) as GatewayPayload; } catch { return; }
      this.handle(socket, payload);
    });
    socket.on('close', (code: number) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearTimers();
      this.closed(code);
    });
    socket.on('error', (error: Error) => {
      this.log('socket.error', { message: error.message });
    });
  }

  private handle(socket: Socket, payload: GatewayPayload): void {
    if (typeof payload.s === 'number') this.sequence = payload.s;
    switch (payload.op) {
      case 10: {
        const interval = Number((payload.d as { heartbeat_interval?: unknown } | undefined)?.heartbeat_interval);
        this.startHeartbeat(socket, Number.isFinite(interval) && interval > 0 ? interval : 41_250);
        if (this.session) this.write(socket, { op: 6, d: { token: this.token, session_id: this.session.id, seq: this.sequence } });
        else this.write(socket, { op: 2, d: { token: this.token, intents: INTENTS, properties: { os: process.platform, browser: 'patterm', device: 'patterm' } } });
        return;
      }
      case 11:
        this.acked = true;
        return;
      case 1:
        this.write(socket, { op: 1, d: this.sequence });
        return;
      case 7:
        // Discord asks for a reconnect; the session resumes.
        this.drop(socket, 4000);
        return;
      case 9: {
        // An invalid session: resume if Discord says so, otherwise start over
        // after the short wait Discord asks for.
        if (payload.d !== true) { this.session = null; this.sequence = null; }
        this.drop(socket, 4000);
        return;
      }
      case 0:
        this.dispatch(payload.t ?? '', payload.d);
        return;
      default:
    }
  }

  private dispatch(type: string, data: unknown): void {
    if (type === 'READY') {
      // READY names the application, for the link that adds the bot to a server.
      const ready = data as { session_id?: unknown; resume_gateway_url?: unknown; user?: DiscordUser; application?: { id?: unknown } };
      if (typeof ready.session_id === 'string' && typeof ready.resume_gateway_url === 'string') {
        this.session = { id: ready.session_id, resumeUrl: ready.resume_gateway_url.replace(/\/+$/, '') };
      }
      if (ready.user?.id) this.self = { id: String(ready.user.id), username: String(ready.user.username ?? ''), bot: true };
      if (ready.application?.id) {
        this.application = { id: String(ready.application.id) };
      }
      this.connected();
      return;
    }
    if (type === 'RESUMED') {
      this.connected();
      return;
    }
    if (type === 'MESSAGE_CREATE' && this.self) {
      const message = data as DiscordMessage;
      if (message?.id && message.channel_id && message.author?.id) this.events.message(message, this.self);
    }
  }

  private connected(): void {
    this.attempts = 0;
    if (this.self) this.events.status({ state: 'connected', user: this.self, application: this.application });
  }

  private startHeartbeat(socket: Socket, interval: number): void {
    this.clearHeartbeat();
    this.acked = true;
    const beat = () => {
      if (this.socket !== socket) return;
      // No acknowledgement since the last beat: the connection is dead.
      if (!this.acked) { this.drop(socket, 4000); return; }
      this.acked = false;
      this.write(socket, { op: 1, d: this.sequence });
      this.heartbeat = setTimeout(beat, interval);
    };
    // Discord asks for the first beat at a random point in the interval.
    this.heartbeat = setTimeout(beat, Math.floor(interval * Math.random()));
  }

  private closed(code: number): void {
    if (this.stopped) return;
    const fatal = FATAL_CLOSE_CODES[code];
    if (fatal) {
      this.session = null;
      this.log('closed.fatal', { code });
      this.events.status({ state: 'error', message: fatal, retrying: false });
      return;
    }
    if (FRESH_SESSION_CODES.has(code)) { this.session = null; this.sequence = null; }
    this.scheduleReconnect(`Disconnected from Discord (${code})`);
  }

  private scheduleReconnect(message: string): void {
    if (this.stopped) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.attempts, RECONNECT_DELAYS_MS.length - 1)]!;
    this.attempts++;
    // A quick reconnect, as Discord asks for routinely, isn't worth showing.
    if (this.attempts > 1) this.events.status({ state: 'error', message, retrying: true });
    this.log('reconnect', { message, delay_ms: delay, attempt: this.attempts });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private drop(socket: Socket, code: number): void {
    // A non-1000 close keeps the session resumable on Discord's side.
    try { socket.close(code); } catch { /* already closed */ }
  }

  private write(socket: Socket, payload: GatewayPayload): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(payload));
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) clearTimeout(this.heartbeat);
    this.heartbeat = null;
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private async rest(method: string, route: string, body?: unknown, retried = false): Promise<unknown> {
    const request = this.options.fetch ?? fetch;
    const response = await request(`${DISCORD_API}${route}`, {
      method,
      headers: {
        Authorization: `Bot ${this.token}`,
        'User-Agent': USER_AGENT,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REST_TIMEOUT_MS)
    });
    if (response.status === 429 && !retried) {
      const limited = await response.json().catch(() => ({})) as { retry_after?: unknown };
      const wait = Math.ceil(Number(limited.retry_after ?? 1) * 1000);
      if (Number.isFinite(wait) && wait <= MAX_RATE_LIMIT_WAIT_MS) {
        await new Promise((resolve) => setTimeout(resolve, wait));
        return this.rest(method, route, body, true);
      }
    }
    if (!response.ok) {
      const detail = await response.json().catch(() => null) as { message?: unknown } | null;
      throw new Error(`Discord ${response.status}${typeof detail?.message === 'string' ? `: ${detail.message}` : ''}`);
    }
    return response.status === 204 ? null : response.json().catch(() => null);
  }

  private log(event: string, data: Record<string, unknown>): void {
    this.options.log?.(event, data);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
