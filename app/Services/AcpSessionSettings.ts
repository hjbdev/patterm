import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

// agy session/load restores the transcript, not these controls. Keep only
// preferences here: never MCP credentials, prompts or native authentication.
const settings = z.object({
  model: z.string().nullable().optional(),
  reasoning: z.string().nullable().optional(),
  mode: z.string().optional(),
  mcpPolicy: z.enum(['allow', 'ask']).optional()
});
export type AcpSessionSettings = z.infer<typeof settings>;

export function readAcpSettings(directory: string, sessionId: string): AcpSessionSettings {
  try { return settings.parse(JSON.parse(fs.readFileSync(settingsPath(directory, sessionId), 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error('Could not read the saved Antigravity controls', { cause: error });
  }
}

export function writeAcpSettings(directory: string, sessionId: string, value: AcpSessionSettings): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const destination = settingsPath(directory, sessionId);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(settings.parse(value)), { mode: 0o600 });
    fs.renameSync(temporary, destination);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function settingsPath(directory: string, sessionId: string): string {
  return path.join(directory, `${createHash('sha256').update(sessionId).digest('hex')}.json`);
}
