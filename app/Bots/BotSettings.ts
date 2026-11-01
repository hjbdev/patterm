import { z } from 'zod';
import { profileLookInput } from '../Harness/HarnessPresets';
import { BOT_AVATAR_KINDS, BOT_PICTURE_DATA_URL, MAX_BOT_PICTURE_BYTES, isSingleEmoji } from './BotAvatar';
import { ASSISTANT_BOT_ID, BOT_VOICES } from './BotIdentity';
import { BOT_VOICE_ACKNOWLEDGEMENTS, BOT_VOICE_PROFILES } from '../Services/AssistantVoiceProfile';

export { ASSISTANT_BOT_ID, BOT_VOICES } from './BotIdentity';

// Bots: persistent, single-instance agents with a face. Each one runs one of
// the user's harness profiles, keeps one conversation that is resumed after
// a restart, and works in the projects its purview names. The assistant is
// the built-in bot: it is always there, reaches every project, and manages
// projects as well.

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

// GPT-Live voice calls on the bot's thread. Only Codex profiles have voice;
// on another profile the setting is kept but the call button stays hidden.
export const botVoiceInput = z.object({
  enabled: z.boolean().default(false),
  // Null keeps Codex's default voice.
  voice: z.enum(BOT_VOICES).nullable().default(null),
  // How a call starts; see AssistantVoiceProfile.
  profile: z.enum(BOT_VOICE_PROFILES).default('codex'),
  acknowledgements: z.enum(BOT_VOICE_ACKNOWLEDGEMENTS).default('default')
});

export type BotVoice = z.infer<typeof botVoiceInput>;

export const botInput = z.object({
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(40),
  // The harness profile (preset) the bot runs, by ID. Null runs Codex with
  // its own configuration, as the assistant did before it had a profile.
  presetId: z.string().trim().min(1).max(160).nullable(),
  avatar: botAvatarInput,
  purview: botPurviewInput.default({ kind: 'none' }),
  // Added to the bot's system context, such as what it looks after.
  instructions: z.string().trim().max(2000).default(''),
  // Off stops the bot and hides it until it is turned back on.
  enabled: z.boolean().default(true),
  // Saved notes the bot keeps across conversations.
  memory: z.boolean().default(true),
  memoryBudgetTokens: z.union([z.literal(2000), z.literal(4000), z.literal(8000)]).default(4000),
  voice: botVoiceInput.default({}),
  // Notifications raised for the user are summarised to the bot.
  digests: z.boolean().default(false),
  // The bot may turn on Focus mode, which holds notifications, agent
  // messages, reports and timer callbacks until it ends.
  focus: z.boolean().default(false)
});

export type Bot = z.infer<typeof botInput>;

export const botSettingsInput = z.object({
  bots: z.array(botInput).max(21).default([]),
  // What voices call the user; blank leaves the name out.
  userName: z.string().trim().max(60).transform((name) => name || null).nullable().default(null)
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

// What the assistant was configured with before it became a bot, so the
// first read carries those choices over.
export interface LegacyAssistantSettings {
  enabled: boolean;
  voice: string | null;
  presetId: string | null;
  forwardNotifications: boolean;
  voiceProfile: string;
  voiceAcknowledgements: string;
  userName: string | null;
  memoryEnabled: boolean;
  memoryBudgetTokens: number;
}

export const DEFAULT_ASSISTANT_LOOK = { color: 'graphite', shape: 'circle', finish: 'soft', marking: 'none', eyes: 'sparkle', mouth: 'smile', cheeks: false, hat: 'none', accent: 'violet', idle: 'blink' } as const;

export function defaultAssistantBot(legacy: LegacyAssistantSettings | null = null): Bot {
  return botInput.parse({
    id: ASSISTANT_BOT_ID,
    name: 'Assistant',
    presetId: legacy?.presetId ?? null,
    avatar: { kind: 'mark', look: DEFAULT_ASSISTANT_LOOK },
    purview: { kind: 'all' },
    enabled: legacy?.enabled ?? true,
    memory: legacy?.memoryEnabled ?? false,
    memoryBudgetTokens: legacy?.memoryBudgetTokens ?? 4000,
    voice: {
      enabled: true,
      voice: legacy?.voice ?? null,
      profile: legacy?.voiceProfile ?? 'codex',
      acknowledgements: legacy?.voiceAcknowledgements ?? 'default'
    },
    digests: legacy?.forwardNotifications ?? true,
    focus: true
  });
}

// The assistant always reaches every project and leads the list. Settings
// that leave it out keep the saved one, so it can't be deleted.
function withAssistant(settings: BotSettings, current: Bot): BotSettings {
  const saved = settings.bots.find((bot) => bot.id === ASSISTANT_BOT_ID) ?? current;
  const assistant: Bot = { ...saved, purview: { kind: 'all' } };
  return { ...settings, bots: [assistant, ...settings.bots.filter((bot) => bot.id !== ASSISTANT_BOT_ID)] };
}

// Validates bots the owner saves. `current` is the assistant as saved now.
export function parseBotSettings(input: unknown, current: Bot): BotSettings {
  return withAssistant(botSettingsInput.parse(input), current);
}

// Reads saved bots one at a time, so a bot this version can't read is left
// out instead of hiding every bot. Saved bots from before profiles could be
// empty fall back to the assistant's legacy settings for its entry.
export function readBotSettings(saved: unknown, legacy: LegacyAssistantSettings | null = null): BotSettings {
  const record = typeof saved === 'object' && saved !== null ? saved as { bots?: unknown; userName?: unknown } : {};
  const bots = Array.isArray(record.bots) ? record.bots : [];
  const readable = bots.flatMap((bot) => {
    const parsed = botInput.safeParse(bot);
    return parsed.success ? [parsed.data] : [];
  });
  const userName = record.userName === undefined ? legacy?.userName ?? null : record.userName;
  const settings = botSettingsInput.safeParse({ bots: readable, userName });
  const fallback = defaultAssistantBot(legacy);
  return withAssistant(settings.success ? settings.data : { bots: [], userName: null }, fallback);
}

export function isAssistantBot(botId: string | null | undefined): boolean {
  return botId === ASSISTANT_BOT_ID;
}
