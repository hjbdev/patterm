import fs from 'node:fs';
import { z } from 'zod';
import type { DatabaseService } from '../Services/DatabaseService';
import type { HarnessLauncher, LaunchHarnessResult } from '../Services/HarnessLauncher';
import type { CloseProcessAction } from './CloseProcessAction';

// `/new` starts a fresh top-level conversation with the same harness, model,
// and working directory as an Integrated tab. The old conversation stays in
// history, so an idle tab is replaced; a working agent or one with running
// children stays open beside the new session.
export const newAgentSessionInput = z.object({
  process_id: z.string().min(1),
  project_id: z.string().min(1)
});

export type NewAgentSessionInput = z.input<typeof newAgentSessionInput>;
export type NewAgentSessionResult = LaunchHarnessResult & { replaced_process_id: string | null };

interface SourceSession {
  harness: string;
  model: string | null;
  reasoning: string | null;
  service_tier: string | null;
  cwd: string | null;
  worktree_id: string | null;
  status: string;
  activity: string | null;
}

export class NewAgentSessionAction {
  constructor(
    private readonly database: DatabaseService,
    private readonly launcher: Pick<HarnessLauncher, 'launch'>,
    private readonly closeProcess: Pick<CloseProcessAction, 'execute'>
  ) {}

  async execute(raw: NewAgentSessionInput): Promise<NewAgentSessionResult> {
    const input = newAgentSessionInput.parse(raw);
    const source = this.database.connection.prepare(`
      select sessions.harness, sessions.model, sessions.reasoning, sessions.service_tier, sessions.cwd, sessions.worktree_id, processes.status, processes.activity
      from sessions
      join processes on processes.id = sessions.process_id
      where sessions.process_id = ? and sessions.project_id = ? and sessions.interface_mode = 'integrated'
      order by sessions.started_at desc
      limit 1
    `).get(input.process_id, input.project_id) as SourceSession | undefined;
    if (!source) throw new Error(`unknown Integrated agent: ${input.process_id}`);
    if (!isIntegratedHarness(source.harness)) throw new Error(`harness cannot start Integrated conversations: ${source.harness}`);

    // Decide before launching so the new session cannot affect the check.
    const replace = this.replaceable(input.process_id, source);
    const worktree = this.liveWorktree(source.worktree_id, input.project_id);
    const cwd = source.cwd && isDirectory(source.cwd) ? source.cwd : undefined;
    const launched = await this.launcher.launch({
      harness: source.harness,
      model: source.model,
      reasoning: source.reasoning,
      service_tier: source.service_tier,
      project_id: input.project_id,
      worktree_id: worktree,
      ...(cwd ? { cwd } : {}),
      interface_mode: 'integrated'
    });
    if (!replace) return { ...launched, replaced_process_id: null };
    await this.closeProcess.execute(input.process_id);
    return { ...launched, replaced_process_id: input.process_id };
  }

  private replaceable(processId: string, source: SourceSession): boolean {
    if (source.status !== 'running') return true;
    // A failed turn has finished; anything else may still be running.
    if (source.activity !== 'idle' && source.activity !== 'error') return false;
    const child = this.database.connection.prepare(`select 1 from processes where parent_process_id = ? and status = 'running' limit 1`).get(processId);
    return !child;
  }

  private liveWorktree(worktreeId: string | null, projectId: string): string | null {
    if (!worktreeId) return null;
    const row = this.database.connection.prepare('select worktree_path from worktrees where id = ? and project_id = ?').get(worktreeId, projectId) as
      | { worktree_path: string }
      | undefined;
    return row && isDirectory(row.worktree_path) ? worktreeId : null;
  }
}

function isIntegratedHarness(harness: string): harness is 'claude' | 'codex' | 'opencode' | 'amp' {
  return harness === 'claude' || harness === 'codex' || harness === 'opencode' || harness === 'amp';
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
