import { z } from 'zod';
import { profileLookInput } from '../Harness/HarnessPresets';
import { BOT_AVATAR_KINDS, BOT_PICTURE_DATA_URL, MAX_BOT_PICTURE_BYTES, isSingleEmoji } from './BotAvatar';

// Bots: persistent, single-instance agents with a face. Each one runs one of
// the user's harness profiles, keeps one conversation that is resumed after
// a restart, and works in the projects its purview names.

export const botAvatarInput = z.object({
  kind: z.enum(BOT_AVATAR_KINDS).default('face'),
  look: profileLookInput,
  emoji: z.string().trim().refine(isSingleEmoji, 'use one emoji').nullable().default(null),
  picture: z.string().max(Math.ceil(MAX_BOT_PICTURE_BYTES * 4 / 3) + 64).regex(BOT_PICTURE_DATA_URL, 'use a PNG, JPEG or WebP picture').nullable().default(null)
}).superRefine((value, context) => {
  if (value.kind === 'emoji' && !value.emoji) context.addIssue({ code: z.ZodIssueCode.custom, path: ['emoji'], message: 'choose an emoji' });
  if (value.kind === 'picture' && !value.picture) context.addIssue({ code: z.ZodIssueCode.custom, path: ['picture'], message: 'choose a picture' });
});

// Which projects a bot works in: none (a generic bot that only talks), the
// ones named, or every workspace project.
export const botPurviewInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('projects'), projectIds: z.array(z.string().trim().min(1).max(200)).min(1).max(50) })
]);

export type BotPurview = z.infer<typeof botPurviewInput>;

export const botInput = z.object({
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(40),
  // The harness profile (preset) the bot runs, by ID.
  presetId: z.string().trim().min(1).max(160),
  avatar: botAvatarInput,
  purview: botPurviewInput.default({ kind: 'none' }),
  // Added to the bot's system context, such as what it looks after.
  instructions: z.string().trim().max(2000).default(''),
  // Saved notes the bot keeps across conversations, like the assistant's.
  memory: z.boolean().default(true)
});

export type Bot = z.infer<typeof botInput>;

export const botSettingsInput = z.object({
  bots: z.array(botInput).max(20).default([])
}).superRefine((value, context) => {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const [index, bot] of value.bots.entries()) {
    if (ids.has(bot.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['bots', index, 'id'], message: `duplicate bot id: ${bot.id}` });
    ids.add(bot.id);
    const name = bot.name.toLowerCase();
    if (names.has(name)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['bots', index, 'name'], message: `a bot named '${bot.name}' already exists` });
    names.add(name);
  }
});

export type BotSettings = z.infer<typeof botSettingsInput>;

export function purviewAllows(purview: BotPurview, projectId: string): boolean {
  return purview.kind === 'all' || (purview.kind === 'projects' && purview.projectIds.includes(projectId));
}

// Reads saved bots one at a time, so a bot this version can't read is left
// out instead of hiding every bot.
export function readBotSettings(saved: unknown): BotSettings {
  const bots = typeof saved === 'object' && saved !== null && Array.isArray((saved as { bots?: unknown }).bots) ? (saved as { bots: unknown[] }).bots : [];
  const readable = bots.flatMap((bot) => {
    const parsed = botInput.safeParse(bot);
    return parsed.success ? [parsed.data] : [];
  });
  const settings = botSettingsInput.safeParse({ bots: readable });
  return settings.success ? settings.data : { bots: [] };
}
