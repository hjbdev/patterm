import { z } from 'zod';
import { RegisterProcessAction } from '../Actions/RegisterProcessAction';
import type { ProjectLaunchFence } from './ProjectLaunchFence';
import type { WorkbenchRepository } from '../Repositories/WorkbenchRepository';
import type { DatabaseService } from './DatabaseService';
import type { SpawnSink } from './HarnessLauncher';
import type { TimelineService } from './TimelineService';

export const processCreateInput = z.object({
  project_id: z.string().min(1),
  worktree_id: z.string().nullable().default(null),
  parent_process_id: z.string().nullable().default(null),
  name: z.string().optional(),
  // Freeform command, shell-wrapped. Omitted/empty => an interactive shell.
  command: z.string().optional(),
  auto_restart: z.boolean().default(false),
  cwd: z.string().optional(),
  actor_id: z.string().nullable().default(null)
});

export type ProcessCreateInput = z.input<typeof processCreateInput>;

export const processUpdateInput = z.object({
  process_id: z.string().min(1),
  name: z.string().min(1),
  command: z.string().optional(),
  cwd: z.string().nullable().optional(),
  auto_restart: z.boolean().default(false)
});

export type ProcessUpdateInput = z.input<typeof processUpdateInput>;

export interface ProcessLauncherResult {
  process_id: string;
  pty_process_id: string;
}

interface ProcessRow {
  id: string;
  project_id: string;
  status: string;
  name: string;
  cwd: string | null;
  argv: string | null;
  worktree_id: string | null;
  pty_process_id: string | null;
}

export interface ProcessLauncherDeps {
  database: DatabaseService;
  timeline: TimelineService;
  terminal: SpawnSink;
  workbench: WorkbenchRepository;
  notifyChanged?: () => void;
  fence?: ProjectLaunchFence;
}

// Launches long-running "processes" (a shell or a freeform command) through the
// terminal sidecar and records them as restartable processes rows, mirroring
// patterm-cli's KindCommand (shell-wrapped `$SHELL -lc <cmd>`).
export class ProcessLauncher {
  constructor(private readonly deps: ProcessLauncherDeps) {}

  async create(raw: ProcessCreateInput): Promise<ProcessLauncherResult> {
    const input = processCreateInput.parse(raw);
    return this.fenced(input.project_id, () => this.createInProject(input));
  }

  async update(raw: ProcessUpdateInput): Promise<{ process_id: string; pty_process_id: string | null; restarted: boolean }> {
    const input = processUpdateInput.parse(raw);
    return this.fenced(this.process(input.process_id).project_id, () => this.updateInProject(input));
  }

  // Re-attach a fresh PTY to an existing (exited) process row, reusing its argv.
  async relaunch(processId: string): Promise<{ process_id: string; pty_process_id: string }> {
    return this.fenced(this.process(processId).project_id, () => this.relaunchInProject(processId));
  }

  private fenced<T>(projectId: string, launch: () => Promise<T>): Promise<T> {
    return this.deps.fence ? this.deps.fence.run(projectId, launch) : launch();
  }

  private async createInProject(input: z.output<typeof processCreateInput>): Promise<ProcessLauncherResult> {
    const project = this.deps.workbench.getProject(input.project_id);
    const worktree = input.worktree_id ? this.worktree(input.worktree_id) : null;
    const cwd = input.cwd ?? worktree?.worktree_path ?? project?.path ?? process.cwd();

    const command = input.command?.trim();
    const shell = process.env.SHELL ?? '/bin/sh';
    const argv = command ? [shell, '-lc', command] : [shell];
    const name = input.name?.trim() || (command ? truncate(command, 40) : 'terminal');

    const ptyId = await this.spawn(name, argv, cwd);

    let registered: { process_id: string };
    try {
      registered = new RegisterProcessAction(this.deps.database, this.deps.timeline).execute({
        project_id: input.project_id,
        parent_process_id: input.parent_process_id ?? null,
        pty_process_id: ptyId,
        kind: 'command',
        name,
        status: 'running',
        cwd,
        argv,
        worktree_id: input.worktree_id ?? null,
        auto_restart: input.auto_restart ?? false,
        created_by_actor: input.actor_id ?? 'user'
      });
    } catch (error) {
      await this.closeDetachedTerminal(ptyId);
      throw error;
    }
    const { process_id } = registered;
    this.deps.notifyChanged?.();

    return { process_id, pty_process_id: ptyId };
  }

  private async updateInProject(input: z.output<typeof processUpdateInput>): Promise<{ process_id: string; pty_process_id: string | null; restarted: boolean }> {
    const row = this.process(input.process_id);
    const previousArgv = parseArgv(row.argv);
    const nextArgv = input.command === undefined ? previousArgv : argvFromCommand(input.command);
    const nextCwd = input.cwd === undefined ? row.cwd ?? null : normalizeNullable(input.cwd);
    const shouldRestart = Boolean(row.pty_process_id) && row.status === 'running' && (JSON.stringify(previousArgv) !== JSON.stringify(nextArgv) || (row.cwd ?? null) !== nextCwd);
    const now = new Date().toISOString();

    let nextPtyId = row.pty_process_id;
    if (shouldRestart && row.pty_process_id) {
      await this.deps.terminal.request('terminal.process.stop', { process_id: row.pty_process_id });
      nextPtyId = await this.spawn(input.name, nextArgv, nextCwd ?? undefined);
    }

    try {
      this.deps.database.connection
        .prepare(
          `update processes
              set name = ?,
                  cwd = ?,
                  argv = ?,
                  auto_restart = ?,
                  pty_process_id = ?,
                  status = case when ? then 'running' else status end,
                  exited_at = case when ? then null else exited_at end,
                  exit_code = case when ? then null else exit_code end,
                  updated_at = ?
            where id = ?`
        )
        .run(
          input.name,
          nextCwd,
          JSON.stringify(nextArgv),
          input.auto_restart ? 1 : 0,
          nextPtyId,
          shouldRestart ? 1 : 0,
          shouldRestart ? 1 : 0,
          shouldRestart ? 1 : 0,
          now,
          row.id
        );
    } catch (error) {
      if (shouldRestart && nextPtyId) await this.closeDetachedTerminal(nextPtyId);
      throw error;
    }
    if (shouldRestart && row.pty_process_id) await this.closeDetachedTerminal(row.pty_process_id);

    this.deps.timeline.append({
      event_type: shouldRestart ? 'process.updated_restarted' : 'process.updated',
      project_id: row.project_id,
      process_id: row.id,
      actor_type: 'system',
      metadata: { name: input.name, auto_restart: input.auto_restart, restarted: shouldRestart }
    });
    this.deps.notifyChanged?.();

    return { process_id: row.id, pty_process_id: nextPtyId, restarted: shouldRestart };
  }

  private async relaunchInProject(processId: string): Promise<{ process_id: string; pty_process_id: string }> {
    const row = this.process(processId);

    const argv = parseArgv(row.argv);
    if (argv.length === 0) {
      throw new Error(`process ${processId} has no argv to relaunch`);
    }

    const ptyId = await this.spawn(row.name, argv, row.cwd ?? undefined);
    const now = new Date().toISOString();
    try {
      this.deps.database.connection
        .prepare(`update processes set pty_process_id = ?, status = 'running', exited_at = null, exit_code = null, updated_at = ? where id = ?`)
        .run(ptyId, now, processId);
    } catch (error) {
      await this.closeDetachedTerminal(ptyId);
      throw error;
    }
    if (row.pty_process_id) await this.closeDetachedTerminal(row.pty_process_id);

    this.deps.timeline.append({
      event_type: 'process.relaunched',
      project_id: row.project_id,
      process_id: processId,
      actor_type: 'system',
      metadata: { name: row.name }
    });
    this.deps.notifyChanged?.();

    return { process_id: processId, pty_process_id: ptyId };
  }

  private async closeDetachedTerminal(ptyProcessId: string): Promise<void> {
    try {
      await this.deps.terminal.request('terminal.process.close', { process_id: ptyProcessId });
    } catch (error) {
      // Preserve a failed registration's original error or a successful
      // replacement's running status if runtime cleanup also fails.
      console.warn(`Failed to release detached terminal ${ptyProcessId}`, error);
    }
  }

  private process(processId: string): ProcessRow {
    const row = this.deps.database.connection
      .prepare(`select id, project_id, status, name, cwd, argv, worktree_id, pty_process_id from processes where id = ?`)
      .get(processId) as ProcessRow | undefined;
    if (!row) {
      throw new Error(`unknown process: ${processId}`);
    }
    return row;
  }

  private async spawn(name: string, argv: string[], cwd: string | undefined): Promise<string> {
    const response = (await this.deps.terminal.request('terminal.process.spawn', {
      name,
      kind: 'command',
      command: argv[0],
      args: argv.slice(1),
      env: {},
      ...(cwd ? { cwd } : {})
    })) as { process_id?: string; unavailable?: boolean } | null;

    if (!response?.process_id) {
      throw new Error('terminal core unavailable; cannot spawn process');
    }
    return response.process_id;
  }

  private worktree(worktreeId: string): { worktree_path: string } {
    const row = this.deps.database.connection.prepare(`select worktree_path from worktrees where id = ?`).get(worktreeId) as
      | { worktree_path: string }
      | undefined;
    if (!row) {
      throw new Error(`unknown worktree: ${worktreeId}`);
    }
    return row;
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function parseArgv(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function argvFromCommand(command: string | undefined): string[] {
  const shell = process.env.SHELL ?? '/bin/sh';
  const trimmed = command?.trim();
  return trimmed ? [shell, '-lc', trimmed] : [shell];
}

function normalizeNullable(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
