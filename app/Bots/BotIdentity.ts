// Shared with the renderer, so no zod here.

// The built-in bot. Its sessions keep the 'assistant' role, which reaches
// every project and manages projects, and its saved notes keep a null
// bot_id from before it was a bot.
export const ASSISTANT_BOT_ID = 'assistant';

// GPT-Live (realtime v3) voices, as listed by thread/realtime/listVoices.
export const BOT_VOICES = ['cove', 'juniper', 'maple', 'spruce', 'ember', 'vale', 'breeze', 'arbor', 'sol'] as const;
export type BotVoiceName = (typeof BOT_VOICES)[number];
