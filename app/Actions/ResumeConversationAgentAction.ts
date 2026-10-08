import fs from 'node:fs';
import { z } from 'zod';
import type { DatabaseService } from '../Services/DatabaseService';
import type { AgentHistoryReadService } from '../Services/AgentHistory/AgentHistoryReadService';
import type { HarnessLauncher, LaunchHarnessResult } from '../Services/HarnessLauncher';
import type { IntegratedAgentService } from '../Services/IntegratedAgentService';
import type { CloseProcessAction } from './CloseProcessAction';

// Agents resume as children of their orchestrator. Users resume top-level
// sessions, optionally replacing an empty Integrated tab.
export const resumeConversationAgentInput = z.object({
  conversation_id: z.string().min(1),
  project_id: z.string().min(1),
  actor_id: z.string().min(1).nullable().default(null),
  parent_process_id: z.string().min(1).nullable().default(null),
  name: z.string().optional(),
  initial_prompt: z.string().optional(),
  interface_mode: z.enum(['tui', 'integrated']).optional(),
  replace_process_id: z.string().min(1).optional()
});

export type ResumeConversationAgentInput = z.input<typeof resumeConversationAgentInput>;
export type ResumeConversationAgentResult = LaunchHarnessResult & { replaced_process_id: string | null };

export interface ResumeReplacement {
  integrated: Pick<IntegratedAgentService, 'isEmpty'>;
  closeProcess: Pick<CloseProcessAction, 'execute'>;
}

export class ResumeConversationAgentAction {
  private readonly pending = new Map<string, Promise<LaunchHarnessResult>>();

  constructor(
    private readonly database: DatabaseService,
    private readonly history: AgentHistoryReadService,
    private readonly launcher: HarnessLauncher,
    private readonly replacement?: ResumeReplacement
  ) {}

  async execute(raw: ResumeConversationAgentInput): Promise<ResumeConversationAgentResult> {
    const input = resumeConversationAgentInput.parse(raw);
    const conversation = this.history.findConversation(input.conversation_id);
    if (!conversation) throw new Error(`unknown conversation: ${input.conversation_id}`);
    if (conversation.projectId !== input.project_id) {
      throw new Error('conversation is outside the current caller project');
    }
    if (!isResumableProvider(conversation.provider)) {
      throw new Error(`conversation provider cannot be resumed: ${conversation.provider}`);
    }
    const resumeId = conversation.providerConversationId?.trim();
    if (!resumeId) throw new Error('conversation has no provider resume ID');

    const key = `${conversation.provider}:${resumeId}`;
    const running = this.runningProcess(conversation.provider, resumeId);
    if (running) throw duplicateResumeError(running);
    const pending = this.pending.get(key);
    if (pending) {
      const launched = await pending;
      throw duplicateResumeError(launched.process_id);
    }

    // Decide before launching: the new session must not count as the old tab's content.
    const replace = input.replace_process_id && await this.replaceable(input.replace_process_id, input.project_id) ? input.replace_process_id : null;
    const worktree = this.liveWorktree(conversation.worktreeId, input.project_id);
    const cwd = this.resolveCwd(conversation.cwd, worktree?.worktree_path ?? null, input.project_id);
    const launch = this.launcher.resume(
      {
        harness: conversation.provider,
        project_id: input.project_id,
        worktree_id: worktree?.id ?? null,
        cwd,
        actor_id: input.actor_id,
        parent_process_id: input.parent_process_id,
        session_role: input.parent_process_id ? 'child' : 'orchestrator',
        name: input.name?.trim() || conversation.title?.trim() || undefined,
        initial_prompt: input.initial_prompt,
        interface_mode: input.interface_mode ?? this.savedInterface(conversation.sessionId)
      },
      { resume_id: resumeId, conversation_id: conversation.id }
    );
    this.pending.set(key, launch);
    let launched: LaunchHarnessResult;
    try {
      launched = await launch;
    } finally {
      this.pending.delete(key);
    }
    if (!replace) return { ...launched, replaced_process_id: null };
    await this.replacement!.closeProcess.execute(replace);
    return { ...launched, replaced_process_id: replace };
  }

  // Only a running, empty Integrated session in the same project is replaced.
  // Anything else stays open beside the resumed conversation.
  private async replaceable(processId: string, projectId: string): Promise<boolean> {
    if (!this.replacement) return false;
    const row = this.database.connection.prepare(`
      select 1 from sessions
      join processes on processes.id = sessions.process_id
      where sessions.process_id = ? and sessions.project_id = ? and sessions.interface_mode = 'integrated' and processes.status = 'running'
    `).get(processId, projectId);
    if (!row) return false;
    try {
      return await this.replacement.integrated.isEmpty(processId);
    } catch {
      return false;
    }
  }

  private savedInterface(sessionId: string | null): 'tui' | 'integrated' | undefined {
    if (!sessionId) return undefined;
    const row = this.database.connection.prepare('select interface_mode from sessions where id = ?').get(sessionId) as { interface_mode: string } | undefined;
    return row?.interface_mode === 'tui' || row?.interface_mode === 'integrated' ? row.interface_mode : undefined;
  }

  private runningProcess(provider: string, resumeId: string): string | null {
    const row = this.database.connection.prepare(`
      select processes.id
      from sessions
      join processes on processes.id = sessions.process_id
      where sessions.harness = ? and sessions.resume_id = ? and processes.status = 'running'
      order by sessions.started_at desc
      limit 1
    `).get(provider, resumeId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  private liveWorktree(worktreeId: string | null, projectId: string): { id: string; worktree_path: string } | null {
    if (!worktreeId) return null;
    const row = this.database.connection.prepare(`select id, worktree_path from worktrees where id = ? and project_id = ?`).get(worktreeId, projectId) as
      | { id: string; worktree_path: string }
      | undefined;
    return row && isDirectory(row.worktree_path) ? row : null;
  }

  private resolveCwd(recordedCwd: string | null, worktreePath: string | null, projectId: string): string {
    if (recordedCwd?.trim()) {
      if (!isDirectory(recordedCwd)) throw new Error(`conversation working directory is unavailable: ${recordedCwd}`);
      return recordedCwd;
    }
    if (worktreePath && isDirectory(worktreePath)) return worktreePath;
    const project = this.database.connection.prepare(`select path from projects where id = ?`).get(projectId) as { path: string } | undefined;
    if (!project || !isDirectory(project.path)) throw new Error(`project working directory is unavailable: ${project?.path ?? projectId}`);
    return project.path;
  }
}

function isResumableProvider(provider: string): provider is 'claude' | 'codex' | 'opencode' | 'amp' {
  return provider === 'claude' || provider === 'codex' || provider === 'opencode' || provider === 'amp';
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function duplicateResumeError(processId: string): Error {
  return new Error(`conversation already has a running Patterm agent: ${processId}`);
}
