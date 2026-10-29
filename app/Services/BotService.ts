import fs from 'node:fs';
import path from 'node:path';
import { purviewAllows, type Bot, type BotPurview } from '../Bots/BotSettings';
import { storedPath } from '../Platform/PathIdentity';
import { AgentContextService } from './AgentContextService';
import type { DatabaseService } from './DatabaseService';
import type { HarnessLauncher } from './HarnessLauncher';
import type { SettingsService } from './SettingsService';
import type { WorkbenchRepository } from '../Repositories/WorkbenchRepository';

// Each bot's conversation lives in its own hidden project, so agent scoping
// keeps bots apart: one bot never sees another's sessions or history. Bots
// work in user projects through their purview instead.
export function botProjectId(botId: string): string {
  return `project_bot_${botId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

export interface BotState {
  bot_id: string;
  process_id: string | null;
  session_id: string | null;
}

interface BotRow { process_id: string; session_id: string; resume_id: string | null }

// Runs each bot as one persistent Integrated session, like the assistant:
// ensure() reuses the live session, otherwise resumes the bot's latest
// conversation, otherwise starts a new one. Bots come back on their own after
// a restart, unlike other agents. Each bot's starts, restarts and stops run
// one at a time, so a bot never ends up with two sessions.
export class BotService {
  private readonly queue = new Map<string, Promise<unknown>>();

  constructor(
    private readonly database: DatabaseService,
    private readonly appDataPath: string,
    private readonly launcher: Pick<HarnessLauncher, 'launch' | 'resume'>,
    private readonly settings: Pick<SettingsService, 'bots' | 'harnessPresets'>,
    private readonly workbench: Pick<WorkbenchRepository, 'listProjects'>,
    private readonly processes: { stop(processId: string): Promise<unknown>; transferTimers(fromProcessIds: readonly string[], toProcessId: string): void },
    // conversationSaved: whether a CLI kept a conversation to resume. Claude
    // keeps one only after its first turn.
    private readonly options: { log?: (event: string, data: Record<string, unknown>) => void; conversationSaved?: (harness: string, cwd: string, resumeId: string) => boolean } = {}
  ) {}

  list(): BotState[] {
    return this.settings.bots().bots.map((bot) => this.state(bot.id));
  }

  state(botId: string): BotState {
    const current = this.current(botId);
    return { bot_id: botId, process_id: current?.process_id ?? null, session_id: current?.session_id ?? null };
  }

  // Which projects a bot's session may work in. A bot that was deleted keeps
  // none.
  purview(botId: string | null): BotPurview {
    return (botId ? this.bot(botId)?.purview : null) ?? { kind: 'none' };
  }

  allows(botId: string | null, projectId: string): boolean {
    return purviewAllows(this.purview(botId), projectId);
  }

  // The system context a bot's session launches with.
  context(botId: string): string {
    const bot = this.bot(botId);
    if (!bot) return '';
    const purview = bot.purview;
    const projects = purview.kind === 'projects'
      ? this.workbench.listProjects().filter((project) => purview.projectIds.includes(project.id)).map((project) => ({ id: project.id, name: project.name }))
      : purview.kind;
    return new AgentContextService().buildBot(bot, projects);
  }

  ensure(botId: string): Promise<BotState> {
    return this.serial(botId, async () => {
      if (this.current(botId)) return this.state(botId);
      return this.launch(this.requireBot(botId), false);
    });
  }

  // Brings every bot back after a restart. One that fails to start doesn't
  // keep the others from starting.
  async ensureAll(): Promise<void> {
    for (const bot of this.settings.bots().bots) {
      await this.ensure(bot.id).catch((error: unknown) => this.log('ensure.failed', { bot_id: bot.id, message: errorMessage(error) }));
    }
  }

  // Stops the bot's session and starts it again: on the same conversation,
  // or a new one when `fresh`. `processId`, when given, must still be the
  // bot's session, so a stale request never replaces a newer one.
  restart(botId: string, fresh = false, processId?: string): Promise<BotState> {
    return this.serial(botId, async () => {
      const current = this.current(botId);
      if (processId && current?.process_id !== processId) throw new Error('This bot has already restarted');
      if (current) await this.processes.stop(current.process_id);
      const state = await this.launch(this.requireBot(botId), fresh);
      this.log(fresh ? 'new_conversation' : 'restarted', { bot_id: botId, from: current?.process_id ?? null, to: state.process_id });
      return state;
    });
  }

  // Restarts the bot whose session runs in this process.
  restartProcess(processId: string, fresh = false): Promise<BotState> {
    const row = this.database.connection.prepare(`select bot_id from sessions where process_id = ? and session_role = 'bot'`).get(processId) as { bot_id: string } | undefined;
    if (!row) return Promise.reject(new Error('That process is not a bot'));
    return this.restart(row.bot_id, fresh, processId);
  }

  // After the bots' settings change: start new bots, and stop removed ones,
  // including a launch still under way when the bot was removed.
  async reconcile(): Promise<void> {
    const ids = new Set(this.settings.bots().bots.map((bot) => bot.id));
    const live = (this.database.connection.prepare(`select distinct sessions.bot_id from sessions join processes on processes.id = sessions.process_id
      where sessions.session_role = 'bot' and sessions.exited_at is null and processes.status = 'running'`).all() as Array<{ bot_id: string }>).map((row) => row.bot_id);
    const removed = new Set([...live, ...this.queue.keys()].filter((botId) => !ids.has(botId)));
    await Promise.all([...removed].map((botId) => this.serial(botId, () => this.stopAll(botId)).catch((error: unknown) => this.log('stop.failed', { bot_id: botId, message: errorMessage(error) }))));
    await this.ensureAll();
  }

  // Runs one bot's starts, restarts and stops in order.
  private serial<T>(botId: string, task: () => Promise<T>): Promise<T> {
    const next = (this.queue.get(botId) ?? Promise.resolve()).catch(() => undefined).then(task);
    this.queue.set(botId, next);
    void next.finally(() => { if (this.queue.get(botId) === next) this.queue.delete(botId); }).catch(() => undefined);
    return next;
  }

  private async stopAll(botId: string): Promise<void> {
    const rows = this.database.connection.prepare(`select sessions.process_id from sessions join processes on processes.id = sessions.process_id
      where sessions.session_role = 'bot' and sessions.bot_id = ? and sessions.exited_at is null and processes.status = 'running'`).all(botId) as Array<{ process_id: string }>;
    for (const row of rows) await this.processes.stop(row.process_id);
  }

  private async launch(bot: Bot, fresh: boolean): Promise<BotState> {
    const cwd = this.ensureProject(bot);
    // A conversation resumes only in the CLI it was started with.
    const harness = this.settings.harnessPresets().presets.find((preset) => preset.id === bot.presetId)?.harness;
    if (!harness) throw new Error(`${bot.name}'s profile no longer exists. Choose another in Settings › Bots.`);
    const previous = fresh ? null : this.previous(bot.id, harness);
    const input = {
      harness,
      preset: bot.presetId,
      project_id: botProjectId(bot.id),
      cwd,
      session_role: 'bot' as const,
      bot_id: bot.id,
      interface_mode: 'integrated' as const,
      name: bot.name,
      actor_id: 'user'
    };
    // A bot nobody has messaged yet has nothing to resume.
    if (previous?.resume_id && (this.options.conversationSaved?.(harness, cwd, previous.resume_id) ?? true)) {
      try {
        await this.launcher.resume(input, { resume_id: previous.resume_id, conversation_id: '', source_session_id: previous.session_id });
        return this.launched(bot.id);
      } catch (error) {
        // A conversation the CLI can no longer resume starts over rather than
        // leaving the bot down.
        this.log('resume.failed', { bot_id: bot.id, resume_id: previous.resume_id, message: errorMessage(error) });
      }
    }
    await this.launcher.launch(input);
    return this.launched(bot.id);
  }

  private launched(botId: string): BotState {
    const state = this.state(botId);
    if (state.process_id) this.adoptPrevious(botId, state.process_id);
    return state;
  }

  // Helpers and timers that the bot's earlier sessions started belong to the
  // new one, so their reports still reach it.
  private adoptPrevious(botId: string, processId: string): void {
    const previous = (this.database.connection.prepare(`select process_id from sessions where session_role = 'bot' and bot_id = ? and process_id <> ?`)
      .all(botId, processId) as Array<{ process_id: string }>).map((row) => row.process_id);
    if (!previous.length) return;
    this.database.connection.prepare(`update processes set parent_process_id = ? where parent_process_id in
      (select process_id from sessions where session_role = 'bot' and bot_id = ? and process_id <> ?)`).run(processId, botId, processId);
    this.processes.transferTimers(previous, processId);
  }

  private ensureProject(bot: Bot): string {
    const cwd = storedPath(path.join(this.appDataPath, 'bots', bot.id.replace(/[^A-Za-z0-9_-]/g, '_')));
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const now = new Date().toISOString();
    this.database.connection.prepare(`insert into projects (id, name, path, kind, created_at, updated_at) values (?, ?, ?, 'bots', ?, ?)
      on conflict(id) do update set name = excluded.name, path = excluded.path, kind = 'bots', updated_at = excluded.updated_at`).run(botProjectId(bot.id), bot.name, cwd, now, now);
    return cwd;
  }

  private current(botId: string): BotRow | null {
    return (this.database.connection.prepare(`select sessions.process_id, sessions.id as session_id, sessions.resume_id
      from sessions join processes on processes.id = sessions.process_id
      where sessions.session_role = 'bot' and sessions.bot_id = ? and sessions.exited_at is null and processes.status = 'running'
      order by sessions.started_at desc limit 1`).get(botId) as BotRow | undefined) ?? null;
  }

  private previous(botId: string, harness: string): BotRow | null {
    return (this.database.connection.prepare(`select process_id, id as session_id, resume_id from sessions
      where session_role = 'bot' and bot_id = ? and harness = ? and resume_id is not null
      order by started_at desc limit 1`).get(botId, harness) as BotRow | undefined) ?? null;
  }

  private bot(botId: string): Bot | null {
    return this.settings.bots().bots.find((bot) => bot.id === botId) ?? null;
  }

  private requireBot(botId: string): Bot {
    const bot = this.bot(botId);
    if (!bot) throw new Error(`unknown bot: ${botId}`);
    return bot;
  }

  private log(event: string, data: Record<string, unknown>): void {
    this.options.log?.(`bot.${event}`, data);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
