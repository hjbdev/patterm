import type { DatabaseService } from '../Services/DatabaseService';

// Stores the native agent's own conversation title. TUI sessions report it as
// an OSC terminal title; Integrated sessions read it from the provider. The
// user's or agent's chosen display name still takes precedence when shown.
export class UpdateSessionTitleAction {
  constructor(private readonly database: DatabaseService) {}

  // Integrated callers may address the agent by process or session ID.
  forProcess(processId: string, title: string): boolean {
    return this.update('(process_id = ? or id = ?) and exited_at is null', [processId, processId], title);
  }

  forPty(ptyProcessId: string, title: string): boolean {
    return this.update('process_id in (select id from processes where pty_process_id = ?)', [ptyProcessId], title);
  }

  private update(match: string, ids: string[], raw: string): boolean {
    const title = normaliseTitle(raw);
    if (!title) return false;
    return this.database.connection
      .prepare(`update sessions set last_title = ? where ${match} and coalesce(last_title, '') != ?`)
      .run(title, ...ids, title).changes > 0;
  }
}

// Native agent CLIs animate a leading Braille spinner in the title while
// working, and Claude Code shows \u2733 while idle. Activity already has its own
// lifecycle event; persist only the label, so a turn does not rename the tab.
function normaliseTitle(title: string): string {
  return title.replace(/^[\u2800-\u28ff\u2733]\s+(?=\S)/u, '').trim().slice(0, 500);
}
