// Shared with the renderer, which offers to restart the server when a launch
// fails this way. Errors cross IPC and WebSockets as plain messages, and
// Electron prefixes IPC rejections with the channel name.
export const OPENCODE_VERSION_MISMATCH = 'OpenCode server version mismatch';

export function isOpenCodeVersionMismatch(message: string): boolean {
  return message.includes(OPENCODE_VERSION_MISMATCH);
}
