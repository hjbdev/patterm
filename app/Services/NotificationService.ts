import { createHash, randomUUID } from 'node:crypto';
import MarkdownIt from 'markdown-it';
import type { DatabaseService } from './DatabaseService';
import type { SettingsService } from './SettingsService';
import type { TimelineService } from './TimelineService';
import { ASSISTANT_PROJECT_ID } from './AssistantProject';
import type { DeliveryLevel, NotificationCategory, NotificationUrgency } from './NotificationSettings';
import { awaitingUser } from './Activity';

export type NotificationSource = 'mcp' | 'terminal' | 'integrated' | 'runtime' | 'system';
export type NotificationKind = 'attention' | 'permission' | 'turn_finished' | 'bell' | 'message' | 'failure';

export interface NotificationRecord {
  id: string;
  project_id: string | null;
  process_id: string | null;
  session_id: string | null;
  source: NotificationSource;
  kind: NotificationKind;
  urgency: NotificationUrgency;
  delivery: 'in_app' | 'all';
  // Raised while its project was snoozed: kept in the app, never toasted or
  // pushed. Cleared when the project wakes and sends its summary.
  held: boolean;
  // Child agents' records are for their parent: they mark the tab but never toast.
  audience: 'user' | 'parent';
  routed_to_process_id: string | null;
  title: string;
  body: string;
  occurrences: number;
  created_at: string;
  updated_at: string;
  read_at: string | null;
  resolved_at: string | null;
  url: string;
  // Where it came from, for history lists. Null once the process is deleted.
  project_name: string | null;
  process_name: string | null;
}

export interface RaiseNotificationInput {
  processId?: string | null | undefined;
  projectId?: string | null | undefined;
  source: NotificationSource;
  kind: NotificationKind;
  urgency?: NotificationUrgency | undefined;
  title?: string | undefined;
  body?: string | undefined;
  dedupeKey?: string | null | undefined;
  // Routine: record it in the app at low urgency, with no toast or push.
  quiet?: boolean | undefined;
}

export type RaiseNotificationResult =
  | { status: 'raised' | 'updated' | 'rate_limited'; notification: NotificationRecord }
  | { status: 'routed_to_parent'; parent_process_id: string }
  | { status: 'suppressed' };

export type NotificationChange =
  | { type: 'raised'; notification: NotificationRecord }
  | { type: 'updated'; notification: NotificationRecord }
  | { type: 'read' | 'resolved'; ids: string[] };

export interface NotificationUnread {
  process_id: string | null;
  project_id: string | null;
  count: number;
  urgency: NotificationUrgency;
}

interface ProcessContext {
  id: string;
  project_id: string;
  parent_process_id: string | null;
  parent_running: number;
  kind: string;
  name: string;
  session_id: string | null;
}

interface NotificationRow extends Omit<NotificationRecord, 'url' | 'held'> {
  held: number;
  dedupe_key: string | null;
}

export const TITLE_LIMIT = 120;
export const BODY_LIMIT = 1_000;
const RATE_WINDOW_MS = 60_000;
const RECORD_SELECT = `select notifications.*, projects.name as project_name,
    coalesce(sessions.title, processes.name) as process_name
  from notifications
  left join projects on projects.id = notifications.project_id
  left join processes on processes.id = notifications.process_id
  left join sessions on sessions.id = notifications.session_id`;
const RATE_LIMIT = 5;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const URGENCY_RANK: Record<NotificationUrgency, number> = { low: 0, normal: 1, high: 2 };
const DEFAULT_URGENCY: Record<NotificationKind, NotificationUrgency> = {
  attention: 'normal',
  permission: 'high',
  turn_finished: 'normal',
  bell: 'low',
  message: 'normal',
  failure: 'high'
};

// Owns notification records and routing. Delivery (toasts, desktop, push) is
// a listener on the changes this service emits.
export class NotificationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly settings: Pick<SettingsService, 'notificationSettings'>,
    private readonly timeline: Pick<TimelineService, 'append'>,
    // Delivers a notice from one process to another (its parent).
    private readonly messageProcess: (processId: string, text: string, fromProcessId: string) => Promise<unknown>,
    private readonly onChange: (change: NotificationChange) => void,
    private readonly now: () => number = Date.now
  ) {}

  async raise(raw: RaiseNotificationInput): Promise<RaiseNotificationResult> {
    const process = raw.processId ? this.processContext(raw.processId) : null;
    if (raw.processId && !process) return { status: 'suppressed' };
    // Terminal notifications from plain processes are messages, not requests.
    const input = raw.source === 'terminal' && raw.kind === 'attention' && process?.kind !== 'agent' ? { ...raw, kind: 'message' as const } : raw;
    const child = Boolean(process?.parent_process_id && process.parent_running);
    const title = clean(input.title, TITLE_LIMIT) || (process ? displayName(process.name) : 'Patterm');
    // A child whose parent has gone asks the user directly, and says so.
    const orphaned = Boolean(process?.parent_process_id && !process.parent_running && input.source === 'mcp');
    const source = orphaned ? [`From ${displayName(process!.name)}, a child agent whose parent is no longer running.`, input.body].filter(Boolean).join('\n') : input.body;
    const body = clean(source, BODY_LIMIT);

    // Child agents escalate through their parent, which decides whether to
    // involve the user.
    if (child && process && input.source === 'mcp') {
      this.timeline.append({ event_type: 'notification.routed_to_parent', project_id: process.project_id, process_id: process.id, actor_type: 'agent', metadata: { parent_process_id: process.parent_process_id, title, body } });
      await this.messageProcess(process.parent_process_id!, parentMessage(process, 'Attention requested by', title, body), process.id);
      return { status: 'routed_to_parent', parent_process_id: process.parent_process_id! };
    }

    // Toasts, the tray, and push show plain text; parents above keep the Markdown.
    const text = clean(markdownText(source ?? ''), BODY_LIMIT);
    const level = input.source === 'system' ? 'all' : this.level(categoryFor(input, process));
    if (level === 'off') return { status: 'suppressed' };
    const urgency = input.quiet ? 'low' : input.urgency ?? DEFAULT_URGENCY[input.kind];
    const minimum = this.settings.notificationSettings().minimumUrgency;
    const projectId = process?.project_id ?? input.projectId ?? null;
    // A snoozed project's notifications wait for its summary. System notices,
    // such as that summary, are never held.
    const held = input.source !== 'system' && this.projectSnoozed(projectId);
    const delivery: 'in_app' | 'all' = level === 'all' && !child && !input.quiet && !held && URGENCY_RANK[urgency] >= URGENCY_RANK[minimum] ? 'all' : 'in_app';
    const dedupeKey = input.dedupeKey === undefined ? defaultDedupeKey(input.kind, title, text) : input.dedupeKey;
    const at = new Date(this.now()).toISOString();
    const db = this.database.connection;

    if (process && dedupeKey) {
      const existing = db.prepare(`select * from notifications where process_id = ? and dedupe_key = ? and resolved_at is null order by created_at desc limit 1`)
        .get(process.id, dedupeKey) as NotificationRow | undefined;
      if (existing) {
        const notification = this.touch(existing.id, title, text, at, 'updated', held);
        // A repeat is silent, but a blocked child whose request or failure
        // changed tells its parent what it says now.
        const changed = existing.title !== title || existing.body !== text;
        if (child && isBlocking(input.kind) && changed) await this.messageProcess(process.parent_process_id!, parentMessage(process, input.kind === 'failure' ? 'Failure reported by' : 'Attention needed by', title, body), process.id).catch(() => undefined);
        return { status: 'updated', notification };
      }
    }
    if (process && input.source === 'mcp') {
      const since = new Date(this.now() - RATE_WINDOW_MS).toISOString();
      const recent = db.prepare(`select id from notifications where process_id = ? and source = 'mcp' and created_at >= ? order by created_at desc`)
        .all(process.id, since) as Array<{ id: string }>;
      if (recent.length >= RATE_LIMIT) return { status: 'rate_limited', notification: this.touch(recent[0]!.id, title, text, at, 'updated', held) };
    }

    const id = `notification_${randomUUID()}`;
    const routedTo = child && isBlocking(input.kind) ? process!.parent_process_id : null;
    db.prepare(`insert into notifications
      (id, project_id, process_id, session_id, source, kind, urgency, delivery, held, audience, routed_to_process_id, title, body, dedupe_key, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, projectId, process?.id ?? null, process?.session_id ?? null, input.source, input.kind, urgency, delivery, held ? 1 : 0, child ? 'parent' : 'user', routedTo, title, text, dedupeKey, at, at);
    this.timeline.append({ event_type: 'notification.raised', project_id: projectId, process_id: process?.id ?? null, session_id: process?.session_id ?? null, actor_type: input.source === 'mcp' ? 'agent' : 'system', metadata: { notification_id: id, source: input.source, kind: input.kind, urgency, title } });
    const notification = this.get(id)!;
    this.onChange({ type: 'raised', notification });
    // A blocked child tells its parent once per episode; repeats update the
    // same record above and send nothing.
    if (routedTo) await this.messageProcess(routedTo, parentMessage(process!, input.kind === 'failure' ? 'Failure reported by' : 'Attention needed by', title, body), process!.id).catch(() => undefined);
    return { status: 'raised', notification };
  }

  // Ends a project's hold: its held notifications become ordinary unread
  // ones. The summary counts those meant for the user; a child agent's
  // records are for its parent.
  releaseHeld(projectId: string): number {
    const db = this.database.connection;
    const { count } = db.prepare(`select count(*) as count from notifications where project_id = ? and held = 1 and audience = 'user'`).get(projectId) as { count: number };
    db.prepare(`update notifications set held = 0 where project_id = ? and held = 1`).run(projectId);
    return count;
  }

  private projectSnoozed(projectId: string | null): boolean {
    if (!projectId) return false;
    const row = this.database.connection.prepare(`select snoozed_until from projects where id = ?`).get(projectId) as { snoozed_until: string | null } | undefined;
    return Boolean(row?.snoozed_until && Date.parse(row.snoozed_until) > this.now());
  }

  get(id: string): NotificationRecord | null {
    const row = this.database.connection.prepare(`${RECORD_SELECT} where notifications.id = ?`).get(id) as NotificationRow | undefined;
    return row ? toRecord(row) : null;
  }

  // Newest activity first. Pass the previous page's `next_cursor` to page
  // back; unlike offsets, cursors stay stable while new records arrive.
  list(input: { project_id?: string | undefined; process_id?: string | undefined; include_resolved?: boolean | undefined; limit?: number | undefined; offset?: number | undefined; cursor?: string | undefined } = {}): { items: NotificationRecord[]; total: number; next_cursor: string | null } {
    const where: string[] = [];
    const params: string[] = [];
    if (input.project_id) { where.push('notifications.project_id = ?'); params.push(input.project_id); }
    if (input.process_id) { where.push('notifications.process_id = ?'); params.push(input.process_id); }
    if (!input.include_resolved) where.push('notifications.resolved_at is null');
    const filter = where.length ? `where ${where.join(' and ')}` : '';
    const cursor = decodeCursor(input.cursor);
    const page = cursor ? [...where, '(notifications.updated_at < ? or (notifications.updated_at = ? and notifications.id < ?))'] : where;
    const pageParams = cursor ? [...params, cursor.updatedAt, cursor.updatedAt, cursor.id] : params;
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const offset = cursor ? 0 : Math.max(input.offset ?? 0, 0);
    const db = this.database.connection;
    const rows = db.prepare(`${RECORD_SELECT} ${page.length ? `where ${page.join(' and ')}` : ''}
      order by notifications.updated_at desc, notifications.id desc limit ? offset ?`).all(...pageParams, limit + 1, offset) as unknown as NotificationRow[];
    const total = (db.prepare(`select count(*) as count from notifications ${filter}`).get(...params) as { count: number }).count;
    const items = rows.slice(0, limit).map(toRecord);
    const last = items.at(-1);
    return { items, total, next_cursor: rows.length > limit && last ? `${last.updated_at}|${last.id}` : null };
  }

  // Unread, unresolved counts per process for tab and project indicators.
  unread(): NotificationUnread[] {
    const rows = this.database.connection.prepare(`select process_id, project_id, count(*) as count,
        max(case urgency when 'high' then 2 when 'normal' then 1 else 0 end) as rank
      from notifications where resolved_at is null and read_at is null
      group by process_id, project_id`).all() as Array<{ process_id: string | null; project_id: string | null; count: number; rank: number }>;
    return rows.map((row) => ({ process_id: row.process_id, project_id: row.project_id, count: row.count, urgency: row.rank === 2 ? 'high' : row.rank === 1 ? 'normal' : 'low' }));
  }

  markRead(input: { ids?: string[] | undefined; process_id?: string | undefined; session_id?: string | undefined; all?: boolean | undefined }): number {
    const at = new Date(this.now()).toISOString();
    return this.update('read', 'read_at', at, input);
  }

  resolve(input: { ids?: string[] | undefined; process_id?: string | undefined; kinds?: NotificationKind[] | undefined; dedupe_key?: string | undefined }): number {
    const at = new Date(this.now()).toISOString();
    return this.update('resolved', 'resolved_at', at, input);
  }

  // The user or parent answered the process, so its open requests are
  // handled. Failures stay until read or the process is closed. Accepts a
  // Patterm or PTY process id.
  resolveHandled(processId: string): number {
    const process = this.processContext(processId);
    if (!process) return 0;
    return this.resolve({ process_id: process.id, kinds: ['attention', 'permission', 'turn_finished', 'bell', 'message'] });
  }

  // An Integrated agent waits on an approval or an answer. Both are
  // permission notices; one whose reason changed replaces the earlier one.
  waiting(processId: string, previous: string | null | undefined, activity: 'permission' | 'question'): Promise<RaiseNotificationResult> {
    if (awaitingUser(previous) && previous !== activity) this.resolve({ process_id: processId, kinds: ['permission'] });
    return this.raise(activity === 'permission'
      ? { processId, source: 'integrated', kind: 'permission', body: 'Waiting for your permission', dedupeKey: 'integrated:permission' }
      : { processId, source: 'integrated', kind: 'permission', body: 'Has a question for you', dedupeKey: 'integrated:question' });
  }

  // A report says how the turn ended, so it replaces the bare turn-ended
  // notice. Permissions and failures stay open.
  reported(processId: string): number {
    return this.resolve({ process_id: processId, kinds: ['turn_finished'] });
  }

  // Tracks an Integrated agent's turns, so a turn that ended with a report
  // is not announced again as merely finished. A turn begins when the agent's
  // own events report work after idle or an error, and its start is stored
  // so it survives restarts. Reconnect snapshots never end a turn and only
  // start one when none is stored. Work resumed after a reconnect reported
  // idle counts as a new turn, so at worst a finished turn is announced again;
  // a turn is never wrongly silenced. Returns, when a turn ends, whether it
  // reported.
  turnActivity(processId: string, previous: string | null | undefined, activity: string, snapshot = false): boolean {
    const db = this.database.connection;
    const row = db.prepare(`select turn_started_at from processes where id = ?`).get(processId) as { turn_started_at: string | null } | undefined;
    if (!row) return false;
    if (activity === 'working' || activity === 'thinking') {
      if (!row.turn_started_at || (!snapshot && (previous === 'idle' || previous === 'error'))) {
        db.prepare(`update processes set turn_started_at = ? where id = ?`).run(new Date(this.now()).toISOString(), processId);
      }
      return false;
    }
    if ((activity !== 'idle' && activity !== 'error') || snapshot || !row.turn_started_at) return false;
    db.prepare(`update processes set turn_started_at = null where id = ?`).run(processId);
    return Boolean(db.prepare(`select 1 from timeline_events
      where event_type = 'agent.reported' and process_id = ? and created_at >= ? limit 1`).get(processId, row.turn_started_at));
  }

  // Turns already running when this build first starts have no stored start;
  // they count from the process's last change.
  resumeTurns(): void {
    this.database.connection.prepare(`update processes set turn_started_at = updated_at
      where status = 'running' and activity in ('working', 'thinking') and turn_started_at is null`).run();
  }

  prune(): number {
    const cutoff = new Date(this.now() - RETENTION_MS).toISOString();
    return Number(this.database.connection.prepare(`delete from notifications where coalesce(resolved_at, read_at) < ?`).run(cutoff).changes);
  }

  private update(type: 'read' | 'resolved', column: 'read_at' | 'resolved_at', at: string, input: { ids?: string[] | undefined; process_id?: string | undefined; session_id?: string | undefined; kinds?: NotificationKind[] | undefined; dedupe_key?: string | undefined; all?: boolean | undefined }): number {
    const where = [`${column} is null`];
    const params: string[] = [];
    if (input.ids?.length) { where.push(`id in (${input.ids.map(() => '?').join(', ')})`); params.push(...input.ids); }
    else if (input.process_id) { where.push('process_id = ?'); params.push(input.process_id); }
    else if (input.session_id) { where.push('session_id = ?'); params.push(input.session_id); }
    else if (!input.all) return 0;
    if (input.dedupe_key) { where.push('dedupe_key = ?'); params.push(input.dedupe_key); }
    if (input.kinds?.length) { where.push(`kind in (${input.kinds.map(() => '?').join(', ')})`); params.push(...input.kinds); }
    const db = this.database.connection;
    const ids = (db.prepare(`select id from notifications where ${where.join(' and ')}`).all(...params) as Array<{ id: string }>).map((row) => row.id);
    if (!ids.length) return 0;
    const set = column === 'read_at' ? 'read_at = ?' : 'resolved_at = ?, read_at = coalesce(read_at, ?)';
    const values = column === 'read_at' ? [at] : [at, at];
    db.prepare(`update notifications set ${set} where id in (${ids.map(() => '?').join(', ')})`).run(...values, ...ids);
    this.onChange({ type, ids });
    return ids.length;
  }

  // A repeat while its project is snoozed is held like a new notice, so the
  // project's summary counts it.
  private touch(id: string, title: string, body: string, at: string, type: 'updated', held = false): NotificationRecord {
    this.database.connection.prepare(`update notifications set title = ?, body = ?, updated_at = ?, read_at = null, occurrences = occurrences + 1 where id = ?`).run(title, body, at, id);
    if (held) this.database.connection.prepare(`update notifications set held = 1, delivery = 'in_app' where id = ?`).run(id);
    const notification = this.get(id)!;
    this.onChange({ type, notification });
    return notification;
  }

  private level(category: NotificationCategory): DeliveryLevel {
    return this.settings.notificationSettings().sources[category];
  }

  private processContext(processId: string): ProcessContext | null {
    return (this.database.connection.prepare(`select processes.id, processes.project_id, processes.parent_process_id, processes.kind,
        coalesce(sessions.title, processes.name) as name, sessions.id as session_id,
        exists(select 1 from processes parent where parent.id = processes.parent_process_id and parent.status = 'running') as parent_running
      from processes
      left join sessions on sessions.process_id = processes.id
      where processes.id = ? or processes.pty_process_id = ?
      order by processes.status = 'running' desc, sessions.started_at desc limit 1`).get(processId, processId) as ProcessContext | undefined) ?? null;
  }
}

function categoryFor(input: RaiseNotificationInput, process: ProcessContext | null): NotificationCategory {
  const agent = process?.kind === 'agent';
  if (input.source === 'mcp') return 'agent_requests';
  if (input.kind === 'failure') return agent ? 'agent_failures' : 'process_failures';
  if (input.source === 'integrated') return input.kind === 'turn_finished' ? 'integrated_turn_finished' : 'integrated_permission';
  if (input.kind === 'bell') return agent ? 'agent_bells' : 'process_bells';
  return agent ? 'agent_terminal' : 'process_terminal';
}

function isBlocking(kind: NotificationKind): boolean {
  return kind === 'attention' || kind === 'permission' || kind === 'failure';
}

function defaultDedupeKey(kind: NotificationKind, title: string, body: string): string {
  if (kind === 'bell' || kind === 'failure') return kind;
  return `${kind}:${createHash('sha256').update(`${title}\n${body}`).digest('hex').slice(0, 16)}`;
}

function parentMessage(process: ProcessContext, heading: string, title: string, body: string): string {
  return [`[${heading} ${process.id} (${displayName(process.name)})]`, title, body].filter(Boolean).join('\n');
}

// Strips spinner and status glyphs that agent CLIs put in terminal titles.
export function displayName(name: string): string {
  return name.replace(/^[^\p{L}\p{N}]+/u, '').trim() || name.trim() || 'Process';
}

// Notification text comes from agents and terminal output: keep it short,
// single-spaced, and free of control characters.
export function clean(value: string | undefined, limit: number): string {
  if (!value) return '';
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

const markdown = new MarkdownIt({ html: false });

// Reads Markdown the way it renders: link and code text without their
// syntax, list items as bullets, and blocks on their own lines.
export function markdownText(source: string): string {
  const lines: string[] = [];
  const lists: Array<number | null> = [];
  let prefix = '';
  for (const token of markdown.parse(source, {})) {
    if (token.type === 'bullet_list_open') lists.push(null);
    else if (token.type === 'ordered_list_open') lists.push(Number(token.attrGet('start') ?? 1));
    else if (token.type === 'bullet_list_close' || token.type === 'ordered_list_close') lists.pop();
    else if (token.type === 'list_item_open') {
      const index = lists.length - 1;
      const number = lists[index];
      prefix = `${'  '.repeat(index)}${number == null ? '•' : `${number}.`} `;
      if (number != null) lists[index] = number + 1;
    } else if (token.type === 'inline') {
      const inline = (token.children ?? []).map((child) => child.type === 'softbreak' || child.type === 'hardbreak' ? '\n' : child.content).join('');
      lines.push(prefix + inline);
      prefix = '';
    } else if (token.type === 'fence' || token.type === 'code_block') lines.push(token.content.replace(/\n$/, ''));
  }
  return lines.join('\n');
}

const ROUTINE_REPORT_KEY = 'routine-report:';
// An update notice opens Settings › About, where the update is installed.
export const UPDATE_NOTICE_KEY = 'update:';

function toRecord(row: NotificationRow): NotificationRecord {
  const { dedupe_key: _dedupe, ...record } = row;
  return { ...record, held: Boolean(row.held), project_name: row.project_name ?? null, process_name: row.process_name ? displayName(row.process_name) : null, url: notificationUrl(row) };
}

function decodeCursor(cursor: string | undefined): { updatedAt: string; id: string } | null {
  const split = cursor?.indexOf('|') ?? -1;
  if (!cursor || split < 1) return null;
  return { updatedAt: cursor.slice(0, split), id: cursor.slice(split + 1) };
}

export function notificationUrl(row: Pick<NotificationRecord, 'project_id' | 'process_id' | 'session_id'> & { dedupe_key: string | null }): string {
  // A routine's report opens on the Routines page, which keeps it after the run's agent stops.
  const reportRun = row.dedupe_key?.startsWith(ROUTINE_REPORT_KEY) ? row.dedupe_key.slice(ROUTINE_REPORT_KEY.length) : '';
  if (reportRun) return `/routines?report=${encodeURIComponent(reportRun)}`;
  if (row.dedupe_key?.startsWith(UPDATE_NOTICE_KEY)) return '/settings?tab=about';
  if (!row.project_id) return '/projects';
  // Workspace routine runs have no project tab; the Routines page opens them.
  if (row.project_id === ASSISTANT_PROJECT_ID) return row.process_id ? `/routines?run=${encodeURIComponent(row.process_id)}` : '/routines';
  const project = `/projects/${encodeURIComponent(row.project_id)}`;
  if (row.session_id) return `${project}/agents/${encodeURIComponent(row.session_id)}`;
  if (row.process_id) return `${project}/processes/${encodeURIComponent(row.process_id)}`;
  return project;
}
