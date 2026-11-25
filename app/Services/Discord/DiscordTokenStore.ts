import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

// Each bot's Discord bot token, kept in a file only the owner can read
// rather than in settings, so it never travels back to a client. Settings
// say only whether one is saved.
const stored = z.record(z.string(), z.string().min(1));

export const DISCORD_TOKEN = /^[A-Za-z0-9_.-]{50,100}$/;

export class DiscordTokenStore {
  private readonly file: string;

  constructor(appDataPath: string) {
    this.file = path.join(appDataPath, 'discord-tokens.json');
  }

  get(botId: string): string | null {
    return this.read()[botId] ?? null;
  }

  has(botId: string): boolean {
    return Boolean(this.get(botId));
  }

  set(botId: string, token: string | null): void {
    const tokens = this.read();
    if (token) tokens[botId] = token;
    else delete tokens[botId];
    this.write(tokens);
  }

  // Drops tokens of bots that no longer exist.
  retain(botIds: ReadonlySet<string>): void {
    const tokens = this.read();
    const kept = Object.fromEntries(Object.entries(tokens).filter(([botId]) => botIds.has(botId)));
    if (Object.keys(kept).length !== Object.keys(tokens).length) this.write(kept);
  }

  private read(): Record<string, string> {
    try {
      return stored.parse(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      return {};
    }
  }

  private write(tokens: Record<string, string>): void {
    if (!Object.keys(tokens).length) {
      fs.rmSync(this.file, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(tokens), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
}
