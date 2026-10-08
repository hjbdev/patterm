import { z } from 'zod';
import type { DatabaseService } from '../Services/DatabaseService';

export const renameSessionInput = z.object({ name: z.string().trim().min(1).max(500) }).strict();

export class RenameProcessAction {
  constructor(private readonly database: DatabaseService) {}

  execute(processId: string, name: string, source: 'user' | 'agent') {
    const db = this.database.connection;
    return db.transaction(() => {
      const session = db.prepare('select id, process_id, title_set_by_user from sessions where process_id = ? or id = ?')
        .get(processId, processId) as { id: string; process_id: string | null; title_set_by_user: number } | undefined;
      if (source === 'agent' && session?.title_set_by_user) {
        return { renamed: false, reason: 'user_override' as const };
      }
      if (session) {
        db.prepare('update sessions set display_name = ?, title_set_by_user = ? where id = ?')
          .run(name, source === 'user' ? 1 : 0, session.id);
      }
      db.prepare('update processes set name = ?, updated_at = ? where id = ?')
        .run(name, new Date().toISOString(), session?.process_id ?? processId);
      return { renamed: true };
    })();
  }
}
