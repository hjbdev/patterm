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

export function registerCommandRoutes(ipcMain: RouteRegistrar, application: PattermApplication): void {
  ipcMain.handle('patterm:commands:list', (_event, raw) => {
    const context = commandContextPayload.parse(raw) satisfies CommandPaletteContext;
    return listCommandPaletteCommands(application, context);
  });

  ipcMain.handle('patterm:commands:run', async (_event, raw) => {
    const payload = commandRunPayload.parse(raw);
    const result = await runCommandPaletteCommand(application, payload);
    if (result.refresh) {
      application.notifyChanged(DEFAULT_CHANGE_TOPICS);
    }
    return result;
  });
}
