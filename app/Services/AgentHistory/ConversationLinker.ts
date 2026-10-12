import { nativePath, pathColumn, pathContains, pathParam } from '../../Platform/PathIdentity';
import type { AgentHistoryDb } from './AgentHistoryDb';
import type { ParsedConversation } from './AgentHistoryTypes';

export interface ConversationLink {
  project_id: string | null;
  session_id: string | null;
  process_id: string | null;
  worktree_id: string | null;
  link_confidence: number;
  link_reason: string;
}

export class ConversationLinker {
  constructor(private readonly database: AgentHistoryDb) {}

  link(conversation: ParsedConversation, scope: { project_id?: string | null } = {}): ConversationLink {
    const byResume = this.byResumeId(conversation.providerConversationId);
    if (byResume) return byResume;

    const byCwd = conversation.cwd ? this.byCwd(conversation, scope) : null;
    if (byCwd) return byCwd;

    if (scope.project_id) {
      return { project_id: scope.project_id, session_id: null, process_id: null, worktree_id: null, link_confidence: 0.4, link_reason: 'requested project scope' };
    }

    return { project_id: null, session_id: null, process_id: null, worktree_id: null, link_confidence: 0, link_reason: 'unlinked' };
  }

  private byResumeId(resumeId: string): ConversationLink | null {
    const row = this.database.connection
      .prepare(`select id, project_id, process_id, worktree_id from sessions where resume_id = ? or id = ? order by started_at desc limit 1`)
      .get(resumeId, resumeId) as { id: string; project_id: string; process_id: string | null; worktree_id: string | null } | undefined;
    if (!row) return null;
    return { project_id: row.project_id, session_id: row.id, process_id: row.process_id, worktree_id: row.worktree_id, link_confidence: 1, link_reason: 'matched resume/session id' };
  }

  private byCwd(conversation: ParsedConversation, scope: { project_id?: string | null }): ConversationLink | null {
    // Windows agents record `C:\x`, `C:/x`, or Git Bash's `/c/x` for one directory.
    const cwd = conversation.cwd ? nativePath(conversation.cwd) : null;
    if (!cwd) return null;
    const sessions = this.database.connection
      .prepare(`select id, project_id, process_id, worktree_id, harness, started_at, exited_at from sessions where ${pathColumn('cwd')} = ? order by started_at desc limit 20`)
      .all(pathParam(cwd)) as Array<{ id: string; project_id: string; process_id: string | null; worktree_id: string | null; harness: string | null; started_at: string; exited_at: string | null }>;
    const session = sessions.find((candidate) => candidate.harness === conversation.provider && overlaps(candidate.started_at, candidate.exited_at, conversation.startedAt, conversation.updatedAt));
    if (session) {
      return { project_id: session.project_id, session_id: session.id, process_id: session.process_id, worktree_id: session.worktree_id, link_confidence: 0.9, link_reason: 'matched session cwd' };
    }

    const worktree = this.database.connection
      .prepare(`select id, project_id from worktrees where ${pathColumn('worktree_path')} = ? or ${pathColumn('repo_path')} = ? order by created_at desc limit 1`)
      .get(pathParam(cwd), pathParam(cwd)) as { id: string; project_id: string } | undefined;
    if (worktree) {
      return { project_id: worktree.project_id, session_id: null, process_id: null, worktree_id: worktree.id, link_confidence: 0.75, link_reason: 'matched worktree path' };
    }

    const project = this.database.connection.prepare(`select id, path from projects order by length(path) desc`).all() as Array<{ id: string; path: string }>;
    const matched = project.find((row) => pathContains(row.path, cwd));
    if (matched && (!scope.project_id || scope.project_id === matched.id)) {
      return { project_id: matched.id, session_id: null, process_id: null, worktree_id: null, link_confidence: 0.6, link_reason: 'matched project path prefix' };
    }

    return null;
  }
}

function overlaps(sessionStarted: string | null, sessionExited: string | null, conversationStarted: string | null, conversationUpdated: string | null): boolean {
  if (!conversationStarted && !conversationUpdated) return true;
  const sessionStart = time(sessionStarted);
  const sessionEnd = time(sessionExited) ?? Number.POSITIVE_INFINITY;
  const conversationStart = time(conversationStarted) ?? time(conversationUpdated);
  const conversationEnd = time(conversationUpdated) ?? conversationStart;
  if (sessionStart === null || conversationStart === null || conversationEnd === null) return true;
  return conversationEnd >= sessionStart && conversationStart <= sessionEnd;
}

function time(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
