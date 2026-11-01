import type { ProfileLook } from '../Harness/ProfileLook';

// What stands for a bot: its face, or an emoji, a small picture, or
// Patterm's sparkle mark instead. The face is kept while another kind is
// chosen, so switching back restores it. No zod here: the renderer imports
// these, and the schema lives with the bot settings.
export const BOT_AVATAR_KINDS = ['face', 'emoji', 'picture', 'mark'] as const;
export type BotAvatarKind = (typeof BOT_AVATAR_KINDS)[number];

export interface BotAvatar {
  kind: BotAvatarKind;
  look: ProfileLook;
  // One emoji, such as 🦊.
  emoji: string | null;
  // A small square PNG, JPEG or WebP data URL, like a project logo.
  picture: string | null;
}

// Pictures ride along with every bot in settings and the workbench, so they
// stay as small as project logos.
export const MAX_BOT_PICTURE_BYTES = 64 * 1024;
export const BOT_PICTURE_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

// One user-perceived character that is an emoji, so a name or a sentence
// can't stand in for an avatar.
export function isSingleEmoji(value: string): boolean {
  const text = value.trim();
  if (!text || text.length > 32) return false;
  const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)];
  return segments.length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(text);
}
