import type { AssistantMemoryService, MemoryCaller } from './AssistantMemoryService';
import type { DatabaseService } from './DatabaseService';

// What a provider adds to an agent's context before a prompt. `changes` is
// what changed since the last update the agent accepted, the whole memory
// when `full`, or null when nothing did. `snapshot` renders the whole current
// memory, for an agent whose context lost earlier updates in compaction.
export interface MemoryUpdate {
  changes: string | null;
  full: boolean;
  snapshot: () => string;
}

// Keeps the assistant's and bots' saved memory current in their own
// conversations, so they never spend a tool call per message checking it.
// Before each prompt the provider gets what changed since the conversation's
// last update, through the harness's native hidden context. After a failed
// update it gets the whole current state. What each
// process received is kept in memory only: after a restart it gets the whole
// memory once more, which is always safe.
export class MemoryPushService {
  private readonly delivered = new Map<string, { enabled: boolean; revision: number }>();
  // One update at a time per process, in prompt order.
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly database: DatabaseService,
    private readonly memory: Pick<AssistantMemoryService, 'pushed'>,
    private readonly log: (event: string, data: Record<string, unknown>) => void = () => {}
  ) {}

  // Brings the process's memory up to date with `send`. Only the assistant and
  // bots get updates. A failed update is logged, and the next prompt sends
  // the whole current state; it never holds the prompt back.
  deliver(processId: string, send: (update: MemoryUpdate) => Promise<void>): Promise<void> {
    const previous = this.chains.get(processId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.update(processId, send));
    this.chains.set(processId, next);
    void next.finally(() => { if (this.chains.get(processId) === next) this.chains.delete(processId); }).catch(() => undefined);
    return next;
  }

  private async update(processId: string, send: (update: MemoryUpdate) => Promise<void>): Promise<void> {
    try {
      const caller = this.caller(processId);
      if (!caller) return;
      const last = this.delivered.get(processId);
      // A switch change, either way, sends the whole new state.
      const current = this.memory.pushed(caller, last?.enabled ? last.revision : null);
      const changes = last && !last.enabled && !current.enabled ? null : current.text || null;
      await send({
        changes,
        full: Boolean(changes) && current.full,
        snapshot: () => this.memory.pushed(caller, null).text
      });
      this.delivered.set(processId, { enabled: current.enabled, revision: current.revision });
    } catch (error) {
      // A failed update may have changed the agent's context partly, so what
      // it holds is unknown: the next prompt sends the whole current state.
      this.delivered.delete(processId);
      this.log('memory.push_failed', { process_id: processId, message: error instanceof Error ? error.message : String(error) });
    }
  }

  private caller(processId: string): MemoryCaller | undefined {
    const row = this.database.connection.prepare(`select id, session_role, bot_id, harness from sessions
      where process_id = ? and session_role in ('assistant', 'bot') and exited_at is null order by started_at desc limit 1`)
      .get(processId) as { id: string; session_role: 'assistant' | 'bot'; bot_id: string | null; harness: string | null } | undefined;
    if (!row || (row.session_role === 'bot' && !row.bot_id)) return undefined;
    return row.session_role === 'assistant'
      ? { role: 'assistant', bot: null, sessionId: row.id, harness: row.harness, name: null }
      : { role: 'bot', bot: row.bot_id, sessionId: row.id, harness: row.harness, name: row.bot_id };
  }
}

// Whether Patterm can keep memory current in this harness's Integrated
// conversations. Claude's hook runs in a POSIX shell.
export function memoryPushSupported(harness: string | null | undefined, platform: NodeJS.Platform = process.platform): boolean {
  return harness === 'opencode' || harness === 'codex' || (harness === 'claude' && platform !== 'win32');
}
