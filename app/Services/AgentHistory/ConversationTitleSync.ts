import type { AgentHistoryDb } from './AgentHistoryDb';
import { harnessProviders } from '../../Harness/providers';

interface SessionTitleRow {
  harness: string;
  resume_id: string;
  interface_mode: string;
  display_name: string | null;
  auto_title: string | null;
  last_title: string | null;
}

// Copies each Patterm session's title onto the native conversation it resumes,
// so pickers and search show the name the session had instead of its first
// prompt. Only an exact resume ID match counts: conversations linked by working
// directory, such as a harness's own review threads, keep their native title.
export class ConversationTitleSync {
  constructor(private readonly history: AgentHistoryDb, private readonly app: AgentHistoryDb) {}

  // Returns the conversations whose title changed, for reindexing.
  sync(): string[] {
    const titles = new Map<string, { provider: string; resumeId: string; candidates: string[] }>();
    // A resumed native conversation takes the title of its newest session.
    const rows = this.app.connection.prepare(`
      select harness, resume_id, interface_mode, display_name, auto_title, last_title
      from sessions where resume_id is not null and harness is not null
      order by started_at asc
    `).all() as unknown as SessionTitleRow[];
    for (const row of rows) {
      const candidates = sessionTitles(row);
      if (candidates.length) titles.set(`${row.harness}\0${row.resume_id}`, { provider: row.harness, resumeId: row.resume_id, candidates });
    }
    if (!titles.size) return [];
    // Resuming from the picker named the new session after the conversation's
    // title, which used to be its first prompt. A candidate that only repeats
    // the native title says nothing new, so the next one is used.
    const title = `coalesce(nullif(@first, title), nullif(@second, title), nullif(@third, title))`;
    const update = this.history.connection.prepare(`
      update conversations set session_title = ${title}
      where provider = @provider and provider_conversation_id = @resume_id and ${title} is not null and session_title is not ${title}
      returning id
    `);
    return this.history.connection.transaction(() => [...titles.values()].flatMap(({ provider, resumeId, candidates }) => {
      const [first = null, second = null, third = null] = candidates;
      return (update.all({ first, second, third, provider, resume_id: resumeId }) as Array<{ id: string }>).map((row) => row.id);
    }))();
  }
}

// A chosen name, then a generated title, then the harness's own title. Codex
// and OpenCode terminals title themselves after the directory or the app, and
// every harness starts with its product name, so those say nothing about the
// conversation.
export function sessionTitles(row: Omit<SessionTitleRow, 'resume_id'>): string[] {
  const native = row.last_title?.replace(/^[\u2800-\u28ff\u2733]\s*/u, '').trim();
  const nativeUseful = native && native !== harnessProviders.find((provider) => provider.id === row.harness)?.displayName
    && !(row.interface_mode === 'tui' && row.harness !== 'claude');
  return [row.display_name?.trim(), row.auto_title?.trim(), nativeUseful ? native : null].filter((title): title is string => Boolean(title));
}
