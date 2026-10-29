import type { BotAvatar } from '../../../app/Bots/BotAvatar';
import { isBackgroundMessage } from './assistantFocus';
import { buildAgentTabFamilies } from './agentTabs';
import { activityLookup, type RowActivity } from './rowActivity';
import { topicChanged, topicRead } from './serverQuery';
import type { ProjectWorkbench, SessionRecord } from '../types';

// Bots: persistent, single-instance agents with a face, set up in Settings ›
// Bots. These shapes mirror app/Bots/BotSettings, which the renderer can't
// import without its zod and Node dependencies.

export type { BotAvatar };

// Mirrors BOTS_PROJECT_ID in app/Services/BotService.ts.
export const BOTS_PROJECT_ID = 'project_bots';
export type BotPurview = { kind: 'none' } | { kind: 'all' } | { kind: 'projects'; projectIds: string[] };

export interface Bot {
  id: string;
  name: string;
  presetId: string;
  avatar: BotAvatar;
  purview: BotPurview;
  instructions: string;
}

export interface BotSettings { bots: Bot[] }
export interface BotState { bot_id: string; process_id: string | null; session_id: string | null }

export function readBots(): Promise<BotSettings & { states: BotState[] }> {
  return topicRead('settings', ['bots'], async () => await window.patterm.call('settings_bots_get', {}) as BotSettings & { states: BotState[] });
}

export async function saveBots(settings: BotSettings): Promise<BotSettings> {
  const saved = await window.patterm.call('settings_bots_update', settings) as BotSettings;
  topicChanged('settings');
  return saved;
}

export async function restartBot(botId: string, fresh = false): Promise<void> {
  await window.patterm.call('bot_restart', { bot_id: botId, fresh });
}

// What a bot's conversation leaves out: its helpers' reports and messages and
// Patterm's own notes to it. The bot relays what matters.
const CLOSE_REQUEST = /^\[Close requested by /;
export function hiddenFromBot(text: string): boolean {
  return isBackgroundMessage(text) || CLOSE_REQUEST.test(text.trimStart());
}

// Bot sessions and every helper below them, across projects: the agent lists
// leave all of them out. Helpers run in the bot's projects, so they are
// found through their parent's process, which sits in the bots' project.
export function botHidden(projects: readonly ProjectWorkbench[], bots: ProjectWorkbench | null): { sessions: Set<string>; processes: Set<string> } {
  const sessions = new Set<string>();
  const processes = new Set<string>();
  for (const session of bots?.projectSessions ?? []) {
    sessions.add(session.id);
    if (session.processId) processes.add(session.processId);
  }
  if (!processes.size) return { sessions, processes };
  const all = projects.flatMap((project) => project.projectSessions);
  const others = projects.flatMap((project) => project.processes);
  for (let grew = true; grew;) {
    grew = false;
    for (const session of all) {
      if (sessions.has(session.id) || !session.parentProcessId || !processes.has(session.parentProcessId)) continue;
      sessions.add(session.id);
      if (session.processId) processes.add(session.processId);
      grew = true;
    }
    for (const process of others) {
      if (processes.has(process.id) || !process.parentProcessId || !processes.has(process.parentProcessId)) continue;
      processes.add(process.id);
      grew = true;
    }
  }
  return { sessions, processes };
}

export interface BotRow {
  bot: Bot;
  // The bot's live session, or its latest while it starts again.
  session: SessionRecord | null;
  activity: RowActivity | null;
  // A helper waiting on the user, which surfaces here because helpers
  // otherwise stay out of sight, and the project it runs in.
  waitingHelper: SessionRecord | null;
  waitingHelperProjectId: string | null;
  // The second line: what it asks, otherwise its status.
  line: string | null;
}

export function botRows(settings: BotSettings, projects: readonly ProjectWorkbench[], bots: ProjectWorkbench | null): BotRow[] {
  const all = [...(bots?.projectSessions ?? []), ...projects.flatMap((project) => project.projectSessions)];
  return settings.bots.map((bot) => {
    const sessions = (bots?.projectSessions ?? []).filter((session) => session.botId === bot.id);
    const session = sessions.find((candidate) => !candidate.exitedAt) ?? latest(sessions);
    if (!session) return { bot, session: null, activity: null, waitingHelper: null, waitingHelperProjectId: null, line: null };
    const helpers = helpersOf(session, all);
    // Helpers whose parents sit in other projects come back as roots; give
    // them the bot as their parent so one tree covers the bot's work.
    const tree = [session, ...helpers.map((helper) => helper.parentId ? helper : { ...helper, parentId: session.id })];
    const activity = activityLookup(buildAgentTabFamilies(tree.filter((candidate) => !candidate.exitedAt || candidate.id === session.id), {}))(session);
    const waitingHelper = helpers.find((helper) => !helper.exitedAt && (helper.activity === 'permission' || helper.activity === 'question')) ?? null;
    const line = session.asking ?? (waitingHelper ? `A helper is waiting: ${waitingHelper.asking ?? 'it needs you'}` : null) ?? session.summary?.status ?? null;
    const waitingHelperProjectId = waitingHelper ? projects.find((project) => project.projectSessions.some((candidate) => candidate.id === waitingHelper.id))?.project.id ?? null : null;
    return { bot, session, activity, waitingHelper, waitingHelperProjectId, line };
  });
}

function helpersOf(bot: SessionRecord, sessions: readonly SessionRecord[]): SessionRecord[] {
  const processes = new Set(bot.processId ? [bot.processId] : []);
  const helpers: SessionRecord[] = [];
  for (let grew = true; grew;) {
    grew = false;
    for (const session of sessions) {
      if (session.id === bot.id || helpers.includes(session) || !session.parentProcessId || !processes.has(session.parentProcessId)) continue;
      helpers.push(session);
      if (session.processId) processes.add(session.processId);
      grew = true;
    }
  }
  return helpers;
}

function latest(sessions: readonly SessionRecord[]): SessionRecord | null {
  return [...sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
}
