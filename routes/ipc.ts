import { clipboard, dialog, shell, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import type { PattermApplication } from '../app/App';
import { ClientConversationSubscriptions, updateConversationSubscription } from '../app/Http/ClientConversationSubscriptions';
import { MAX_UPLOAD_BYTES, UploadService } from '../app/Http/UploadService';
import { browserToolsOnly, registerApplicationRoutes } from './application';
import { readIntegrated, relayingRegistrar } from './remote';

const clipboardWritePayload = z.object({ text: z.string() });
const shellShowItemPayload = z.object({ path: z.string().min(1) });
const uploadPayload = z.object({
  name: z.string().min(1).max(255),
  process_id: z.string().min(1).max(200).optional(),
  bytes: z.custom<ArrayBuffer | Uint8Array>(
    (value) => value instanceof ArrayBuffer || value instanceof Uint8Array,
    { message: 'Expected file bytes' }
  ).refine((value) => value.byteLength <= MAX_UPLOAD_BYTES, { message: 'Files must be at most 10 MiB' })
});

export function registerIpcRoutes(ipcMain: IpcMain, application: PattermApplication, uploadsDirectory: string): void {
  const uploads = new UploadService(uploadsDirectory);
  const conversations = new Map<number, ClientConversationSubscriptions>();
  const conversationState = (event: IpcMainInvokeEvent) => {
    let state = conversations.get(event.sender.id);
    if (!state) {
      state = new ClientConversationSubscriptions(
        (processId, listener) => application.subscribeConversation(processId, listener),
        (payload) => {
          if (!event.sender.isDestroyed()) event.sender.send('patterm:conversation:event', payload);
        }
      );
      conversations.set(event.sender.id, state);
      event.sender.once('destroyed', () => {
        state!.dispose();
        conversations.delete(event.sender.id);
      });
    }
    return state;
  };
  // The check runs before a call is relayed to a paired host, which applies
  // its own list too.
  registerApplicationRoutes(relayingRegistrar(browserToolsOnly(ipcMain), application, { takesControl: true }), application);

  // One presence record per renderer, dropped when the renderer goes away.
  const presence = new Set<number>();
  ipcMain.handle('patterm:presence:update', (event, raw) => {
    const id = event.sender.id;
    application.notifications.updatePresence(`desktop_${id}`, raw);
    if (!presence.has(id)) {
      presence.add(id);
      event.sender.once('destroyed', () => {
        presence.delete(id);
        application.notifications.removePresence(`desktop_${id}`);
      });
    }
    return { ok: true };
  });

  ipcMain.handle('patterm:conversation:subscribe', (event, raw) => {
    return updateConversationSubscription(conversationState(event), raw, (processId) => readIntegrated(application, processId));
  });
  ipcMain.handle('patterm:dialog:pick-directory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle('patterm:dialog:pick-file-or-directory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile', 'openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle('patterm:shell:show-item', (_event, raw) => {
    const payload = shellShowItemPayload.parse(raw);
    shell.showItemInFolder(payload.path);
    return { ok: true };
  });

  ipcMain.handle('patterm:clipboard:write-text', (_event, raw) => {
    const payload = clipboardWritePayload.parse(raw);
    clipboard.writeText(payload.text);
    return { ok: true };
  });

  ipcMain.handle('patterm:clipboard:read-text', () => clipboard.readText());
  ipcMain.handle('patterm:clipboard:read-paste', () => {
    const image = clipboard.readImage();
    return {
      text: clipboard.readText(),
      hasImage: !image.isEmpty(),
      formats: clipboard.availableFormats()
    };
  });

  // Attachments are always persisted through managed upload storage; the
  // renderer cannot name an arbitrary destination.
  ipcMain.handle('patterm:upload:file', async (_event, raw) => {
    const payload = uploadPayload.parse(raw);
    const bytes = payload.bytes instanceof ArrayBuffer ? new Uint8Array(payload.bytes) : payload.bytes;
    // An attachment for a paired host's agent is stored on that host.
    const host = payload.process_id ? application.remote.target({ process_id: payload.process_id }) : null;
    return host ? application.remote.upload(host, payload.name, Buffer.from(bytes)) : uploads.save(payload.name, Buffer.from(bytes));
  });
}
