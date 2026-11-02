import type { RouteRegistrar } from './application';
import { z } from 'zod';
import {
  listCommandPaletteCommands,
  runCommandPaletteCommand,
  type CommandPaletteContext
} from '../app/Commands/CommandPalette';
import type { PattermApplication } from '../app/App';
import { DEFAULT_CHANGE_TOPICS } from '../app/Services/ChangeTopics';

const commandContextPayload = z.object({
  active_project_id: z.string().nullable(),
  active_terminal_id: z.string().nullable(),
  active_tab: z.string().nullable(),
  active_session_id: z.string().nullable().optional(),
  active_process_id: z.string().nullable().optional()
});

const commandRunPayload = z.object({
  id: z.string().min(1),
  context: commandContextPayload,
  input: z.record(z.string(), z.unknown()).optional()
});

// A command's kind without the record IDs and names its ID carries, such as
// navigate:agent for navigate:agent:<project>:<session>. Harness names stay.
export function commandKind(id: string): string {
  const [scope = '', action = '', harness = ''] = id.split(':');
  const word = (part: string) => /^[a-z][a-z-]*$/.test(part);
  if (scope === 'spawn' && action === 'agent' && word(harness)) return `spawn:agent:${harness}`;
  return word(action) ? `${scope}:${action}` : scope;
}

export function registerCommandRoutes(ipcMain: RouteRegistrar, application: PattermApplication): void {
  ipcMain.handle('patterm:commands:list', (_event, raw) => {
    const context = commandContextPayload.parse(raw) satisfies CommandPaletteContext;
    return listCommandPaletteCommands(application, context);
  });

  ipcMain.handle('patterm:commands:run', async (_event, raw) => {
    const payload = commandRunPayload.parse(raw);
    application.telemetry?.count('command_run', { command: commandKind(payload.id) });
    const result = await runCommandPaletteCommand(application, payload);
    if (result.refresh) {
      application.notifyChanged(DEFAULT_CHANGE_TOPICS);
    }
    return result;
  });
}
