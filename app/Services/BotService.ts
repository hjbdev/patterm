import fs from 'node:fs';
import path from 'node:path';
import { ASSISTANT_BOT_ID, purviewAllows, type Bot, type BotPurview } from '../Bots/BotSettings';
import { ASSISTANT_PROJECT_ID } from './AssistantProject';
import type { AssistantMemoryService } from './AssistantMemoryService';
import { memoryPushSupported } from './MemoryPushService';
import { storedPath } from '../Platform/PathIdentity';
import { AgentContextService, BOT_CONTEXT_BYTES } from './AgentContextService';
import type { DatabaseService } from './DatabaseService';
import type { HarnessLauncher } from './HarnessLauncher';
import type { SettingsService } from './SettingsService';
import type { WorkbenchRepository } from '../Repositories/WorkbenchRepository';

// Each bot's conversation lives in its own hidden project, so agent scoping
// keeps bots apart: one bot never sees another's sessions or history. Bots
// work in user projects through their purview instead.
// The assistant keeps the project and folder it had before it was a bot.
export function botProjectId(botId: string): string {
  if (botId === ASSISTANT_BOT_ID) return ASSISTANT_PROJECT_ID;
  return `project_bot_${botId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

// The assistant's sessions keep their own role, which reaches every project
// and manages projects.
function botRole(botId: string): 'assistant' | 'bot' {
  return botId === ASSISTANT_BOT_ID ? 'assistant' : 'bot';
}

export interface BotState {
  bot_id: string;
  process_id: string | null;
  session_id: string | null;
}

interface BotRow { process_id: string; session_id: string; resume_id: string | null }

// Runs each bot, the assistant included, as one persistent Integrated
// session: ensure() reuses the live session, otherwise resumes the bot's latest
// conversation, otherwise starts a new one. Bots come back on their own after
// a restart, unlike other agents. Each bot's starts, restarts and stops run
// one at a time, so a bot never ends up with two sessions.
export class BotService {
  private readonly queue = new Map<string, Promise<unknown>>();

  constructor(
    private readonly database: DatabaseService,
    private readonly appDataPath: string,
    private readonly launcher: Pick<HarnessLauncher, 'launch' | 'resume'>,
    private readonly settings: Pick<SettingsService, 'bots'>,
    private readonly workbench: Pick<WorkbenchRepository, 'listProjects'>,
    // holdTimers pauses a process's pending timers and returns them, so none
    // fires into the gap while a bot's session is replaced.
    private readonly processes: {
      stop(processId: string): Promise<unknown>;
      transferTimers(fromProcessIds: readonly string[], toProcessId: string): void;
      holdTimers(processId: string): string[];
      releaseTimers(timerIds: readonly string[]): void;
    },
    // conversationSaved: whether a CLI kept a conversation to resume. Claude
    // keeps one only after its first turn.
    // launched and stopping let the bot relay deliver held items to a new
    // session and end a voice call before its session stops.
    private readonly options: {
      log?: (event: string, data: Record<string, unknown>) => void;
      conversationSaved?: (harness: string, cwd: string, resumeId: string) => boolean;
      memory?: Pick<AssistantMemoryService, 'snapshot'>;
      launched?: (botId: string, processId: string) => void;
      stopping?: (botId: string, processId: string) => Promise<void>;
    } = {}
  ) {}

  // The live session's process, if the bot is running.
  currentProcess(botId: string): string | null {
    return this.current(botId)?.process_id ?? null;
  }

  // The CLI the bot runs.
  harness(botId: string): string | null {
    return this.bot(botId)?.harness ?? null;
  }

  // The bot whose session, live or stopped, ran in this process.
  botFor(processId: string): string | null {
    return (this.database.connection.prepare(`select bot_id from sessions where process_id = ? and session_role in ('assistant', 'bot') and bot_id is not null
      order by started_at desc limit 1`).get(processId) as { bot_id: string } | undefined)?.bot_id ?? null;
  }

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
    // Where Patterm keeps memory current, launch instructions carry none.
    const memoryPush = memoryPushSupported(bot.harness);
    if (bot.id === ASSISTANT_BOT_ID) {
      // OpenCode caps launch instructions; the assistant reads its memory with a tool anyway.
      const limit = bot.harness === 'opencode' ? { limitBytes: BOT_CONTEXT_BYTES } : {};
      return new AgentContextService().buildAssistant(memoryPush ? '' : this.options.memory?.snapshot() ?? '', bot, { ...limit, memoryPush });
    }
    const purview = bot.purview;
    const projects = purview.kind === 'projects'
      ? this.workbench.listProjects().filter((project) => purview.projectIds.includes(project.id)).map((project) => ({ id: project.id, name: project.name }))
      : purview.kind;
    return new AgentContextService().buildBot(bot, projects, { memoryPush });
  }

  // Starts a bot that isn't running: on its latest conversation, or a new
  // one when `fresh`. A running bot is left as it is.
  ensure(botId: string, fresh = false): Promise<BotState> {
    return this.serial(botId, async () => {
      if (this.current(botId)) return this.state(botId);
      this.assertEnabled(this.requireBot(botId));
      const held = this.holdTimers(botId);
      try {
        return await this.launch(this.requireBot(botId), fresh);
      } finally {
        this.processes.releaseTimers(held);
      }
    });
  }

  // Brings every bot back after a restart. One that fails to start doesn't
  // keep the others from starting. Their timers are held before the first
  // await, so when this runs before timers activate, one that came due
  // while Patterm was closed waits for the session that adopts it.
  async ensureAll(): Promise<void> {
    // The assistant first starts when the user opens it, so a fresh install
    // runs no assistant it never asked for. After that it comes back like any bot.
    const bots = this.settings.bots().bots.filter((bot) => bot.enabled && (bot.id !== ASSISTANT_BOT_ID || this.hasSession(bot.id)));
    const held = new Map(bots.map((bot) => [bot.id, this.holdTimers(bot.id)]));
    for (const bot of bots) {
      try {
        await this.ensure(bot.id);
      } catch (error) {
        this.log('ensure.failed', { bot_id: bot.id, message: errorMessage(error) });
      } finally {
        this.processes.releaseTimers(held.get(bot.id) ?? []);
      }
    }
  }

  // Stops the bot's session and starts it again: on the same conversation,
  // or a new one when `fresh`. `processId`, when given, must still be the
  // bot's session, so a stale request never replaces a newer one.
  restart(botId: string, fresh = false, processId?: string): Promise<BotState> {
    return this.serial(botId, async () => {
      this.assertEnabled(this.requireBot(botId));
      const current = this.current(botId);
      if (processId && current?.process_id !== processId) throw new Error('This bot has already restarted');
      // If the launch fails, they resume on the stopped session, as after any stop.
      const held = this.holdTimers(botId);
      try {
        if (current) await this.stop(botId, current.process_id);
        const state = await this.launch(this.requireBot(botId), fresh);
        this.log(fresh ? 'new_conversation' : 'restarted', { bot_id: botId, from: current?.process_id ?? null, to: state.process_id });
        return state;
      } finally {
        this.processes.releaseTimers(held);
      }
    });
  }

  // Restarts the bot whose session runs in this process.
  restartProcess(processId: string, fresh = false): Promise<BotState> {
    const botId = this.botFor(processId);
    if (!botId) return Promise.reject(new Error('That process is not a bot'));
    return this.restart(botId, fresh, processId);
  }

  // After the bots' settings change: start new and turned-on bots, and stop
  // removed and turned-off ones, including a launch still under way.
  async reconcile(): Promise<void> {
    const ids = new Set(this.settings.bots().bots.filter((bot) => bot.enabled).map((bot) => bot.id));
    const live = (this.database.connection.prepare(`select distinct sessions.bot_id from sessions join processes on processes.id = sessions.process_id
      where sessions.session_role in ('assistant', 'bot') and sessions.bot_id is not null and sessions.exited_at is null and processes.status = 'running'`).all() as Array<{ bot_id: string }>).map((row) => row.bot_id);
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

  // Pauses the timers of the bot's sessions until a new session adopts them.
  private holdTimers(botId: string): string[] {
    const rows = this.database.connection.prepare(`select distinct process_id from sessions where session_role = ? and bot_id = ? and process_id is not null`).all(botRole(botId), botId) as Array<{ process_id: string }>;
    return rows.flatMap((row) => this.processes.holdTimers(row.process_id));
  }

  private async stopAll(botId: string): Promise<void> {
    const rows = this.database.connection.prepare(`select sessions.process_id from sessions join processes on processes.id = sessions.process_id
      where sessions.session_role = ? and sessions.bot_id = ? and sessions.exited_at is null and processes.status = 'running'`).all(botRole(botId), botId) as Array<{ process_id: string }>;
    for (const row of rows) await this.stop(botId, row.process_id);
  }

  private async stop(botId: string, processId: string): Promise<void> {
    await this.options.stopping?.(botId, processId).catch((error: unknown) => this.log('stopping.failed', { bot_id: botId, message: errorMessage(error) }));
    await this.processes.stop(processId);
  }

  private hasSession(botId: string): boolean {
    return Boolean(this.database.connection.prepare(`select 1 from sessions where session_role = ? and bot_id = ? limit 1`).get(botRole(botId), botId));
  }

  private assertEnabled(bot: Bot): void {
    if (!bot.enabled) throw new Error(`${bot.name} is turned off. Turn it on in Settings › Bots.`);
  }

  private async launch(bot: Bot, fresh: boolean): Promise<BotState> {
    const cwd = this.ensureProject(bot);
    // A conversation resumes only in the CLI it was started with.
    const harness = bot.harness;
    const previous = fresh ? null : this.previous(bot.id, harness);
    const input = {
      harness,
      model: bot.model,
      reasoning: bot.reasoning,
      service_tier: bot.serviceTier,
      project_id: botProjectId(bot.id),
      cwd,
      session_role: botRole(bot.id),
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
    if (state.process_id) {
      this.adoptPrevious(botId, state.process_id);
      this.options.launched?.(botId, state.process_id);
    }
    return state;
  }

  // Helpers and timers that the bot's earlier sessions started belong to the
  // new one, so their reports still reach it.
  private adoptPrevious(botId: string, processId: string): void {
    const role = botRole(botId);
    const previous = (this.database.connection.prepare(`select process_id from sessions where session_role = ? and bot_id = ? and process_id <> ?`)
      .all(role, botId, processId) as Array<{ process_id: string }>).map((row) => row.process_id);
    if (!previous.length) return;
    this.database.connection.prepare(`update processes set parent_process_id = ? where parent_process_id in
      (select process_id from sessions where session_role = ? and bot_id = ? and process_id <> ?)`).run(processId, role, botId, processId);
    this.processes.transferTimers(previous, processId);
  }

  private ensureProject(bot: Bot): string {
    const assistant = bot.id === ASSISTANT_BOT_ID;
    const cwd = storedPath(assistant ? path.join(this.appDataPath, 'assistant') : path.join(this.appDataPath, 'bots', bot.id.replace(/[^A-Za-z0-9_-]/g, '_')));
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const now = new Date().toISOString();
    const kind = assistant ? 'assistant' : 'bots';
    this.database.connection.prepare(`insert into projects (id, name, path, kind, created_at, updated_at) values (?, ?, ?, ?, ?, ?)
      on conflict(id) do update set name = excluded.name, path = excluded.path, kind = excluded.kind, updated_at = excluded.updated_at`).run(botProjectId(bot.id), bot.name, cwd, kind, now, now);
    return cwd;
  }

  private current(botId: string): BotRow | null {
    return (this.database.connection.prepare(`select sessions.process_id, sessions.id as session_id, sessions.resume_id
      from sessions join processes on processes.id = sessions.process_id
      where sessions.session_role = ? and sessions.bot_id = ? and sessions.exited_at is null and processes.status = 'running'
      order by sessions.started_at desc limit 1`).get(botRole(botId), botId) as BotRow | undefined) ?? null;
  }

  private previous(botId: string, harness: string): BotRow | null {
    return (this.database.connection.prepare(`select process_id, id as session_id, resume_id from sessions
      where session_role = ? and bot_id = ? and harness = ? and resume_id is not null
      order by started_at desc limit 1`).get(botRole(botId), botId, harness) as BotRow | undefined) ?? null;
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
