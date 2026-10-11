import fs from 'node:fs';
import { z } from 'zod';
import type { DatabaseService } from '../Services/DatabaseService';
import type { HarnessLauncher, LaunchHarnessResult } from '../Services/HarnessLauncher';

// `/restart` stops a top-level Integrated agent and resumes its conversation
// in a new process, as `/resume` would, so it picks up changed MCP servers,
// settings, and logins. The new session inherits the old one's worktrees,
// todos, scratchpads, and links; its subagents and timers move across. A
// turn in progress needs `force`, because stopping the process ends it.
export const restartAgentSessionInput = z.object({
  process_id: z.string().min(1),
  project_id: z.string().min(1),
  force: z.boolean().default(false)
});

export type RestartAgentSessionInput = z.input<typeof restartAgentSessionInput>;
export type RestartAgentSessionResult = LaunchHarnessResult & { replaced_process_id: string };

export interface RestartAllResult {
  restarted: Array<{ from: string; to: string; name: string }>;
  // Working agents keep their turn; failures name the reason.
  skipped: Array<{ process_id: string; name: string; reason: string }>;
}

export interface RestartProcesses {
  stop(processId: string): Promise<unknown>;
  // Pauses the process's pending timers and returns their IDs.
  holdTimers(processId: string): string[];
  releaseTimers(timerIds: readonly string[]): void;
  close(processId: string): Promise<unknown>;
  transferTimers(fromProcessIds: readonly string[], toProcessId: string): void;
}

interface SourceSession {
  process_id: string;
  session_id: string;
  project_id: string;
  harness: string;
  model: string | null;
  reasoning: string | null;
  service_tier: string | null;
  cwd: string | null;
  worktree_id: string | null;
  resume_id: string | null;
  session_role: string;
  title_set_by_user: number;
  name: string;
  activity: string | null;
}

const SOURCE_COLUMNS = `sessions.id as session_id, sessions.project_id, sessions.harness, sessions.model, sessions.reasoning, sessions.service_tier,
  sessions.cwd, sessions.worktree_id, sessions.resume_id, sessions.session_role, sessions.title_set_by_user, processes.name, processes.activity, processes.id as process_id`;
const WORKING = 'This agent is working, and restarting would stop its turn. Wait for it to finish or stop the response first.';
const LIVE_INTEGRATED = `sessions.interface_mode = 'integrated' and sessions.exited_at is null and processes.status = 'running'`;

export class RestartAgentSessionAction {
  private readonly restarting = new Set<string>();

  constructor(
    private readonly database: DatabaseService,
    private readonly launcher: Pick<HarnessLauncher, 'resume'>,
    private readonly processes: RestartProcesses
  ) {}

  async execute(raw: RestartAgentSessionInput): Promise<RestartAgentSessionResult> {
    const input = restartAgentSessionInput.parse(raw);
    return this.restart(input.process_id, input.project_id, input.force);
  }

  // Restarts every idle top-level Integrated agent, one at a time. Working
  // agents keep running, so no turn is cut short.
  async executeAll(): Promise<RestartAllResult> {
    const rows = this.database.connection.prepare(`select processes.id as process_id, sessions.project_id, processes.name
      from sessions join processes on processes.id = sessions.process_id
      where ${LIVE_INTEGRATED} and sessions.session_role = 'orchestrator'
      order by sessions.started_at`).all() as unknown as Array<{ process_id: string; project_id: string; name: string }>;
    const result: RestartAllResult = { restarted: [], skipped: [] };
    for (const row of rows) {
      try {
        const launched = await this.restart(row.process_id, row.project_id, false);
        result.restarted.push({ from: row.process_id, to: launched.process_id, name: row.name });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        result.skipped.push({ process_id: row.process_id, name: row.name, reason: reason === WORKING ? 'working' : reason });
      }
    }
    return result;
  }

  private async restart(processId: string, projectId: string, force: boolean): Promise<RestartAgentSessionResult> {
    // Read and locked in one step, so a restart that already replaced the
    // agent, or a turn that has since started, is seen.
    if (this.restarting.has(processId)) throw new Error('This agent is already restarting');
    const source = this.liveSource(processId, projectId);
    if (!source) throw new Error(`This agent is not a running Integrated agent: ${processId}`);
    const refusal = restartRefusal(source) ?? (!force && isWorking(source) ? WORKING : null);
    if (refusal) throw new Error(refusal);
    this.restarting.add(processId);
    // Its timers wait until the new process owns them, so none fires into
    // the gap. If the resume fails they resume on the stopped agent, as
    // after any stop.
    const held = this.processes.holdTimers(processId);
    try {
      let launched: LaunchHarnessResult;
      try {
        // The native conversation can only be open in one process, so the
        // old one stops before the new one resumes it.
        await this.processes.stop(processId);
        launched = await this.launcher.resume({
          harness: source.harness as 'claude' | 'codex' | 'opencode' | 'amp',
          model: source.model,
          reasoning: source.reasoning,
          service_tier: source.service_tier,
          project_id: source.project_id,
          worktree_id: this.liveWorktree(source.worktree_id, source.project_id),
          ...(source.cwd && isDirectory(source.cwd) ? { cwd: source.cwd } : {}),
          actor_id: 'user',
          name: source.name,
          interface_mode: 'integrated'
        }, { resume_id: source.resume_id!, conversation_id: '', source_session_id: source.session_id });
      } catch (error) {
        this.processes.releaseTimers(held);
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`The agent did not restart: ${reason}. Its conversation is saved; resume it from history.`);
      }
      const db = this.database.connection;
      db.transaction(() => {
        db.prepare('update processes set parent_process_id = ? where parent_process_id = ?').run(launched.process_id, processId);
        if (source.title_set_by_user) db.prepare('update sessions set title_set_by_user = 1 where id = ?').run(launched.session_id);
      })();
      this.processes.transferTimers([processId], launched.process_id);
      this.processes.releaseTimers(held);
      // Its subagents now belong to the new process, so closing stops nothing else.
      await this.processes.close(processId);
      return { ...launched, replaced_process_id: processId };
    } finally {
      this.restarting.delete(processId);
    }
  }

  private liveSource(processId: string, projectId: string): SourceSession | undefined {
    return this.database.connection.prepare(`select ${SOURCE_COLUMNS}
      from sessions join processes on processes.id = sessions.process_id
      where sessions.process_id = ? and sessions.project_id = ? and ${LIVE_INTEGRATED}
      order by sessions.started_at desc limit 1`).get(processId, projectId) as SourceSession | undefined;
  }

  private liveWorktree(worktreeId: string | null, projectId: string): string | null {
    if (!worktreeId) return null;
    const row = this.database.connection.prepare('select worktree_path from worktrees where id = ? and project_id = ?').get(worktreeId, projectId) as
      | { worktree_path: string }
      | undefined;
    return row && isDirectory(row.worktree_path) ? worktreeId : null;
  }
}

// Subagents are watched by their parent's timers, and the assistant and
// routine runs restart through their own owners.
function restartRefusal(source: SourceSession): string | null {
  if (source.session_role !== 'orchestrator') return 'Only top-level agents restart this way';
  if (!isIntegratedHarness(source.harness)) return `${source.harness} cannot resume Integrated conversations`;
  if (!source.resume_id?.trim()) return 'This agent has no conversation to resume yet';
  return null;
}

// A failed turn has finished; anything else may still be running.
function isWorking(source: SourceSession): boolean {
  return source.activity !== 'idle' && source.activity !== 'error';
}

function isIntegratedHarness(harness: string): boolean {
  return harness === 'claude' || harness === 'codex' || harness === 'opencode' || harness === 'amp';
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
