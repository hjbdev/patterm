import type { BotAvatar } from '../../../app/Bots/BotAvatar';
import { ASSISTANT_BOT_ID } from '../../../app/Bots/BotIdentity';
import { isBackgroundMessage } from './assistantFocus';
import { buildAgentTabFamilies } from './agentTabs';
import { activityLookup, type RowActivity } from './rowActivity';
import { topicChanged, topicRead } from './serverQuery';
import type { ProjectWorkbench, SessionRecord } from '../types';

// Bots: persistent, single-instance agents with a face, set up in Settings ›
// Bots. These shapes mirror app/Bots/BotSettings, which the renderer can't
// import without its zod and Node dependencies. The assistant is the
// built-in bot, ASSISTANT_BOT_ID; it lists first and can't be deleted.

export type { BotAvatar };
export { ASSISTANT_BOT_ID };
export type BotPurview = { kind: 'none' } | { kind: 'all' } | { kind: 'projects'; projectIds: string[] };
export type BotVoiceProfile = 'codex' | 'patterm';
export type BotVoiceAcknowledgements = 'default' | 'on' | 'off';

export interface BotVoice {
  enabled: boolean;
  voice: string | null;
  profile: BotVoiceProfile;
  acknowledgements: BotVoiceAcknowledgements;
}

export interface Bot {
  id: string;
  name: string;
  // The CLI it runs and its model settings, its own copy of a profile's.
  // Null keeps the CLI's own configuration.
  harness: 'claude' | 'codex' | 'opencode';
  model: string | null;
  reasoning: string | null;
  serviceTier: string | null;
  avatar: BotAvatar;
  purview: BotPurview;
  instructions: string;
  enabled: boolean;
  memory: boolean;
  memoryBudgetTokens: 2000 | 4000 | 8000;
  voice: BotVoice;
  digests: boolean;
  focus: boolean;
}

export interface BotSettings { bots: Bot[]; userName: string | null }
export interface BotState { bot_id: string; process_id: string | null; session_id: string | null }

export function readBots(): Promise<BotSettings & { states: BotState[]; voices?: string[] }> {
  return topicRead('settings', ['bots'], async () => await window.patterm.call('settings_bots_get', {}) as BotSettings & { states: BotState[]; voices?: string[] });
}

export function isAssistantBot(bot: Pick<Bot, 'id'> | null | undefined): boolean {
  return bot?.id === ASSISTANT_BOT_ID;
}

export async function saveBots(settings: BotSettings): Promise<BotSettings> {
  const saved = await window.patterm.call('settings_bots_update', settings) as BotSettings;
  topicChanged('settings');
  return saved;
}

// Starts a bot that isn't running, on a new conversation when `fresh`.
export async function startBot(botId: string, fresh = false): Promise<void> {
  await window.patterm.call('bot_start', { bot_id: botId, fresh });
}

// The bot's running process, if it is running.
export async function botProcess(botId: string): Promise<string | null> {
  const state = await window.patterm.call('bot_state', { bot_id: botId }) as { process_id?: string | null };
  return state.process_id ?? null;
}

// What a running bot needs a restart for after its settings change: a new
// harness starts over in that CLI, while new model settings or instructions
// apply to its conversation once it resumes.
export function restartNeed(before: Bot, after: Bot): 'harness' | 'settings' | null {
  if (before.harness !== after.harness) return 'harness';
  const changed = before.model !== after.model || before.reasoning !== after.reasoning || before.serviceTier !== after.serviceTier || before.instructions !== after.instructions;
  return changed ? 'settings' : null;
}

// Restarts a running bot. Like sending it a message, this needs control of
// its conversation, so a browser sends it over its socket.
export async function restartBot(processId: string, fresh = false): Promise<void> {
  const args = { process_id: processId, fresh };
  await (window.patterm.integratedCall ? window.patterm.integratedCall('bot_restart', args) : window.patterm.call('bot_restart', args));
}

// What a bot's conversation leaves out: its helpers' reports and messages and
// Patterm's own notes to it. The bot relays what matters.
const CLOSE_REQUEST = /^\[Close requested by /;
export function hiddenFromBot(text: string): boolean {
  return isBackgroundMessage(text) || CLOSE_REQUEST.test(text.trimStart());
}

// Bot sessions and every helper below them, across projects: the agent lists
// leave all of them out. Helpers run in the bot's projects, so they are
// found through their parent's process, which sits in the bot's own project.
export function botHidden(projects: readonly ProjectWorkbench[], botProjects: readonly ProjectWorkbench[]): { sessions: Set<string>; processes: Set<string> } {
  const sessions = new Set<string>();
  const processes = new Set<string>();
  for (const session of botProjects.flatMap((project) => project.projectSessions)) {
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

// The assistant has its own row and dock, and turned-off bots don't list.
export function botRows(settings: BotSettings, projects: readonly ProjectWorkbench[], botProjects: readonly ProjectWorkbench[]): BotRow[] {
  const own = botProjects.flatMap((project) => project.projectSessions);
  const all = [...own, ...projects.flatMap((project) => project.projectSessions)];
  return settings.bots.filter((bot) => bot.enabled && !isAssistantBot(bot)).map((bot) => {
    const sessions = own.filter((session) => session.botId === bot.id);
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

// Global bots have no projects or all of them. They list in every project's
// sidebar and on the projects page; the rest only in the projects they work in.
export function isGlobalBot(bot: Bot): boolean {
  return bot.purview.kind !== 'projects';
}

export function botShownIn(bot: Bot, projectId: string): boolean {
  return bot.purview.kind !== 'projects' || bot.purview.projectIds.includes(projectId);
}

// A bot row's second line.
export function botLine(row: BotRow): string {
  return row.line ?? (row.session ? (row.session.exitedAt ? 'Starting again…' : 'Ready') : 'Starting…');
}

// The project a bot's page opens beside when a link names none: the first
// one it shows in.
export function botHomeProjectId(bot: Bot | undefined, projectIds: readonly string[]): string | null {
  return projectIds.find((projectId) => !bot || botShownIn(bot, projectId)) ?? projectIds[0] ?? null;
}

export type BotLinkTarget = { botId: string; projectId: string } | 'projects' | 'wait';

// Where a link into a bot's hidden project, such as its notification, goes:
// the bot, beside a project it lists in, or the projects page once it's clear
// there is none. `bots` is null until the bots' settings load, so a cold link
// waits for them rather than settling beside the wrong project.
export function botLinkTarget(own: ProjectWorkbench, sessionId: unknown, bots: readonly Bot[] | null, projectIds: readonly string[], workbenchLoaded: boolean): BotLinkTarget {
  const botId = own.projectSessions.find((session) => session.id === sessionId)?.botId ?? own.projectSessions.find((session) => session.botId)?.botId;
  if (botId && !bots) return 'wait';
  const projectId = botId ? botHomeProjectId(bots?.find((bot) => bot.id === botId), projectIds) : null;
  if (botId && projectId) return { botId, projectId };
  return workbenchLoaded ? 'projects' : 'wait';
}

export interface AssistantRow {
  session: SessionRecord | null;
  activity: RowActivity | null;
  line: string | null;
}

// The global assistant's row in the Bots section. Its agents already list
// with everyone else's, so only its own status shows here. It starts when
// first opened, so until then it has no status rather than an exited one.
export function assistantRow(project: ProjectWorkbench | null, processId: string | null): AssistantRow {
  const session = processId ? project?.projectSessions.find((candidate) => candidate.sessionRole === 'assistant' && candidate.processId === processId) : null;
  if (!session) return { session: null, activity: null, line: null };
  const activity = activityLookup(buildAgentTabFamilies([session], {}))(session);
  return { session, activity, line: session.asking ?? session.summary?.status ?? null };
}

// The assistant row's second line, from its live state in lib/assistant.
export function assistantLine(state: { voiceActive: boolean; focus: boolean; focusPending: number; processId: string | null }, row: AssistantRow): string {
  if (state.voiceActive) return 'On a voice call';
  if (row.line) return row.line;
  if (state.focus) return state.focusPending ? `Focus · ${state.focusPending} held` : 'Focus';
  return state.processId ? 'Ready' : 'Starts when you open it';
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
