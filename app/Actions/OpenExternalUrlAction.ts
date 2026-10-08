import { z } from 'zod';
import type { DatabaseService } from '../Services/DatabaseService';
import type { TerminalClientRequestService } from '../Services/TerminalClientRequestService';

export const openExternalUrlInput = z.object({
  identity: z.string().min(1),
  url: z.string().trim().min(1).max(8192)
}).strict();

const OPENABLE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

// Handles `xdg-open <url>` from an agent PTY. The URL opens on the client that
// controls the agent's terminal, which may be a browser on another machine.
export class OpenExternalUrlAction {
  constructor(
    private readonly database: DatabaseService,
    private readonly requests: TerminalClientRequestService
  ) {}

  execute(raw: unknown): { opened: true } {
    const input = openExternalUrlInput.parse(raw);
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new Error(`Patterm can only open URLs, not ${JSON.stringify(input.url)}`);
    }
    if (!OPENABLE_PROTOCOLS.has(url.protocol)) throw new Error(`Patterm does not open ${url.protocol} links`);

    const row = this.database.connection.prepare(`
      select processes.pty_process_id from sessions
      join processes on processes.id = sessions.process_id
      where sessions.mcp_identity = ? and sessions.exited_at is null and processes.pty_process_id is not null
    `).get(input.identity) as { pty_process_id: string } | undefined;
    if (!row) throw new Error('Caller is not a running Patterm terminal');

    this.requests.emit({ kind: 'open-url', processId: row.pty_process_id, url: url.href });
    return { opened: true };
  }
}
