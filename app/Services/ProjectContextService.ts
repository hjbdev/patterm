import { randomUUID } from 'node:crypto';
import type { DatabaseService } from './DatabaseService';
import type { TimelineService } from './TimelineService';
import { isUserProjectKind } from './PersonalProject';

export interface ContextActor { projectId: string; actorId: string; sessionId: string | null }
export interface Page { limit: number; offset: number }
export interface TodoRow {
  id: string; project_id: string; title: string; notes: string;
  status: 'backlog' | 'open' | 'in_progress' | 'completed'; priority: 'low' | 'medium' | 'high';
  revision: number; created_at: string; updated_at: string; completed_at: string | null;
}
export interface ScratchpadRow {
  id: string; project_id: string; title: string; body: string; status: 'active' | 'archived';
  revision: number; created_at: string; updated_at: string;
}
export interface ReferenceRow {
  id: string; project_id: string; url: string; provider: string; resource_type: string;
  external_id: string | null; identifier: string | null; title: string | null; revision: number;
}
export type ReferenceTarget = { target_type: 'todo' | 'scratchpad' | 'session'; target_id: string };
// A session's own worktree (its working directory) comes first, then the
// worktrees it links, in link order. linked_at is null for the own worktree.
export interface SessionWorktreeItem {
  id: string; branch: string | null; worktree_path: string; repo_path: string;
  linked_at: string | null; own: boolean;
}
export const SESSION_WORKTREE_LIMIT = 10;
interface Lease { holder_actor: string; holder_session_id: string | null; expires_at: number }

const targets = {
  todo: { records: 'todos', attachments: 'todo_references', column: 'todo_id' },
  scratchpad: { records: 'scratchpads', attachments: 'scratchpad_references', column: 'scratchpad_id' },
  session: { records: 'sessions', attachments: 'session_references', column: 'session_id' }
} as const;

// Shared domain operations for the UI and MCP. Call mutations inside an action
// transaction so relationship validation, writes, and timeline events commit together.
export class ProjectContextService {
  // botAllows: whether a bot's purview reaches a project.
  constructor(private readonly database: DatabaseService, private readonly timeline: TimelineService, private readonly now = Date.now, private readonly botAllows?: (botId: string | null, projectId: string) => boolean) {}
  private get db() { return this.database.connection; }

  actor(identity: string | null | undefined, projectId?: string): ContextActor {
    if (identity) {
      const session = this.db.prepare(`select s.id,s.project_id,s.session_role,s.bot_id from sessions s join processes p on p.id=s.process_id
        where s.mcp_identity=? and s.exited_at is null and p.status='running'`).get(identity) as { id: string; project_id: string; session_role: string; bot_id: string | null } | undefined;
      if (!session) throw new Error('Unknown or inactive agent identity');
      // The global assistant, workspace routine runs and bots work in any
      // workspace project they name, bots only within their purview. They have
      // no session there, so nothing links to them.
      if (session.session_role === 'assistant' || session.session_role === 'routine' || session.session_role === 'bot') {
        const project = projectId ? this.db.prepare(`select kind from projects where id=?`).get(projectId) as { kind: string } | undefined : undefined;
        const who = session.session_role === 'routine' ? 'A workspace routine' : session.session_role === 'bot' ? 'A bot' : 'The assistant';
        if (!isUserProjectKind(project?.kind)) throw new Error(`${who} must pass a workspace project_id`);
        if (session.session_role === 'bot' && !this.botAllows?.(session.bot_id, projectId!)) throw new Error('Project is outside this bot\'s projects');
        return { projectId: projectId!, actorId: session.id, sessionId: null };
      }
      if (projectId && projectId !== session.project_id) throw new Error('Project is outside the caller scope');
      return { projectId: session.project_id, actorId: session.id, sessionId: session.id };
    }
    if (!projectId || !this.db.prepare('select id from projects where id=?').get(projectId)) throw new Error('A valid project_id is required');
    return { projectId, actorId: 'user', sessionId: null };
  }

  scoped<T>(table: 'todos' | 'scratchpads' | 'sessions' | 'external_references' | 'worktrees', id: string, actor: ContextActor): T {
    const row = this.db.prepare(`select * from ${table} where id=? and project_id=?`).get(id, actor.projectId);
    if (!row) throw new Error(`${table} record not found in this project`);
    return row as T;
  }

  private event(actor: ContextActor, event: string, metadata: Record<string, unknown>) {
    this.timeline.append({ event_type: event, project_id: actor.projectId, session_id: actor.sessionId,
      actor_type: actor.actorId === 'user' ? 'user' : 'agent', actor_id: actor.actorId, metadata });
  }

  private revision(actual: number, expected: number) {
    if (actual !== expected) throw new Error(`Revision conflict: latest revision is ${actual}; reload and preserve your draft before retrying`);
  }

  todo(id: string, actor: ContextActor) {
    return this.decorateTodos([this.scoped<TodoRow>('todos', id, actor)])[0]!;
  }

  private decorateTodos(rows: TodoRow[]) {
    type Blocker = Pick<TodoRow, 'id' | 'title' | 'status'>;
    const related = new Map(rows.map(row => [row.id, { assignments: [] as string[], blockers: [] as Blocker[], lease: null as Lease | null }]));
    if (rows.length) {
      const ids = rows.map(row => row.id); const placeholders = ids.map(() => '?').join(',');
      const assignments = this.db.prepare(`select todo_id,assignee_id from todo_assignments where todo_id in (${placeholders}) order by assignee_id`).all(...ids) as { todo_id: string; assignee_id: string }[];
      for (const assignment of assignments) related.get(assignment.todo_id)!.assignments.push(assignment.assignee_id);
      const blockers = this.db.prepare(`select d.todo_id,t.id,t.title,t.status from todo_dependencies d join todos t on t.id=d.blocker_id where d.todo_id in (${placeholders}) order by t.title`).all(...ids) as (Blocker & { todo_id: string })[];
      for (const { todo_id, ...blocker } of blockers) related.get(todo_id)!.blockers.push(blocker);
      const leases = this.db.prepare(`select todo_id,holder_actor,holder_session_id,expires_at from todo_leases where todo_id in (${placeholders}) and expires_at>?
        and (holder_session_id is null or exists(select 1 from sessions s join processes p on p.id=s.process_id where s.id=holder_session_id and s.exited_at is null and p.status='running'))`).all(...ids, this.now()) as (Lease & { todo_id: string })[];
      for (const { todo_id, ...lease } of leases) related.get(todo_id)!.lease = lease;
    }
    return rows.map(row => {
      const data = related.get(row.id)!;
      return { ...row, ...data, blocked: data.blockers.some(blocker => blocker.status !== 'completed') };
    });
  }

  listTodos(actor: ContextActor, input: Page & { status?: string | undefined; priority?: string | undefined; assignee_id?: string | undefined; blocked?: boolean | undefined; query?: string | undefined }) {
    const clauses = ['t.project_id=?']; const params: unknown[] = [actor.projectId];
    if (input.status) { clauses.push('t.status=?'); params.push(input.status); }
    if (input.priority) { clauses.push('t.priority=?'); params.push(input.priority); }
    if (input.assignee_id) { clauses.push('exists(select 1 from todo_assignments a where a.todo_id=t.id and a.assignee_id=?)'); params.push(input.assignee_id); }
    if (input.query) { clauses.push('(instr(lower(t.title),lower(?))>0 or instr(lower(t.notes),lower(?))>0)'); params.push(input.query, input.query); }
    if (input.blocked !== undefined) clauses.push(`${input.blocked ? '' : 'not '}exists(select 1 from todo_dependencies d join todos b on b.id=d.blocker_id where d.todo_id=t.id and b.status!='completed')`);
    const where = clauses.join(' and ');
    const total = (this.db.prepare(`select count(*) as n from todos t where ${where}`).get(...params) as { n: number }).n;
    const rows = this.db.prepare(`select t.id,t.project_id,t.title,t.status,t.priority,t.revision,t.created_at,t.updated_at,t.completed_at from todos t where ${where}
      order by case t.priority when 'high' then 0 when 'medium' then 1 else 2 end,t.updated_at desc,t.id limit ? offset ?`).all(...params, input.limit, input.offset) as TodoRow[];
    return { items: this.decorateTodos(rows), total };
  }

  createTodo(actor: ContextActor, input: { title: string; notes: string; status: TodoRow['status']; priority: TodoRow['priority']; assignee_id?: string | undefined }) {
    const id = `todo_${randomUUID()}`; const now = new Date(this.now()).toISOString();
    this.db.prepare(`insert into todos(id,project_id,title,notes,status,priority,created_at,updated_at,completed_at,created_by_actor) values(?,?,?,?,?,?,?,?,?,?)`)
      .run(id, actor.projectId, input.title, input.notes, input.status, input.priority, now, now, input.status === 'completed' ? now : null, actor.actorId);
    this.event(actor, 'todo.created', { todo_id: id });
    if (input.assignee_id) this.assign(actor, id, input.assignee_id, false);
    return this.todo(id, actor);
  }

  updateTodo(actor: ContextActor, input: { todo_id: string; revision: number; title?: string | undefined; notes?: string | undefined; status?: TodoRow['status'] | undefined; priority?: TodoRow['priority'] | undefined }) {
    const row = this.scoped<TodoRow>('todos', input.todo_id, actor); this.revision(row.revision, input.revision);
    const now = new Date(this.now()).toISOString(); const status = input.status ?? row.status;
    this.db.prepare(`update todos set title=?,notes=?,status=?,priority=?,completed_at=?,revision=revision+1,updated_at=? where id=?`)
      .run(input.title ?? row.title, input.notes ?? row.notes, status, input.priority ?? row.priority,
        status === 'completed' ? row.completed_at ?? now : null, now, row.id);
    if (status === 'completed') this.db.prepare('delete from todo_leases where todo_id=?').run(row.id);
    this.event(actor, 'todo.updated', { todo_id: row.id, status });
    return this.todo(row.id, actor);
  }

  deleteTodo(actor: ContextActor, id: string, revision: number) {
    this.revision(this.scoped<TodoRow>('todos', id, actor).revision, revision);
    if (this.db.prepare('select 1 from todo_dependencies where blocker_id=? limit 1').get(id)) throw new Error('Remove dependencies on this todo before deleting it');
    this.db.prepare('delete from todos where id=?').run(id);
    this.event(actor, 'todo.deleted', { todo_id: id }); return { deleted: true };
  }

  assign(actor: ContextActor, id: string, assignee: string, remove: boolean) {
    this.scoped<TodoRow>('todos', id, actor);
    if (assignee !== 'user') this.scoped('sessions', assignee, actor);
    const result = remove ? this.db.prepare('delete from todo_assignments where todo_id=? and assignee_id=?').run(id, assignee)
      : this.db.prepare('insert or ignore into todo_assignments(todo_id,assignee_id,session_id) values(?,?,?)').run(id, assignee, assignee === 'user' ? null : assignee);
    if (result.changes) {
      this.touchTodo(id);
      this.event(actor, remove ? 'todo.unassigned' : 'todo.assigned', { todo_id: id, assignee_id: assignee });
    }
    return this.todo(id, actor);
  }

  dependency(actor: ContextActor, id: string, blocker: string, remove: boolean) {
    this.scoped('todos', id, actor); this.scoped('todos', blocker, actor);
    if (id === blocker) throw new Error('A todo cannot block itself');
    if (!remove && this.db.prepare(`with recursive ancestors(id) as (select ? union select d.blocker_id from todo_dependencies d join ancestors a on d.todo_id=a.id)
      select 1 from ancestors where id=?`).get(blocker, id)) throw new Error('Dependency would create a cycle');
    const result = remove ? this.db.prepare('delete from todo_dependencies where todo_id=? and blocker_id=?').run(id, blocker)
      : this.db.prepare('insert or ignore into todo_dependencies(todo_id,blocker_id) values(?,?)').run(id, blocker);
    if (result.changes) { this.touchTodo(id); this.event(actor, 'todo.dependency_changed', { todo_id: id, blocker_id: blocker, removed: remove }); }
    return this.todo(id, actor);
  }

  private touchTodo(id: string) {
    this.db.prepare('update todos set revision=revision+1,updated_at=? where id=?').run(new Date(this.now()).toISOString(), id);
  }

  lease(actor: ContextActor, id: string, operation: 'acquire' | 'renew' | 'release' | 'revoke', ttl: number, token?: string) {
    const todo = this.scoped<TodoRow>('todos', id, actor);
    if (operation === 'revoke' && actor.actorId !== 'user') throw new Error('Only the owner can revoke another holder’s lease');
    const now = this.now(); const expires = now + ttl * 1000;
    if (operation === 'acquire') {
      if (todo.status === 'completed') throw new Error('Reopen a completed todo before acquiring its lease');
      // Clear dead holders as well as expired leases, including between exit and UI refresh.
      this.db.prepare(`delete from todo_leases where todo_id=? and (expires_at<=? or (holder_session_id is not null and not exists(
        select 1 from sessions s join processes p on p.id=s.process_id where s.id=holder_session_id and s.exited_at is null and p.status='running')))`).run(id, now);
      const next = randomUUID();
      const result = this.db.prepare('insert or ignore into todo_leases(todo_id,holder_actor,holder_session_id,token,expires_at) values(?,?,?,?,?)').run(id, actor.actorId, actor.sessionId, next, expires);
      if (!result.changes) {
        const holder = this.db.prepare('select holder_actor,expires_at from todo_leases where todo_id=?').get(id) as Lease;
        throw new Error(`Lease conflict: held by ${holder.holder_actor} until ${new Date(holder.expires_at).toISOString()}`);
      }
      this.event(actor, 'todo.lease_acquired', { todo_id: id, expires_at: expires });
      return { token: next, holder_actor: actor.actorId, holder_session_id: actor.sessionId, expires_at: expires };
    }
    const result = operation === 'revoke' ? this.db.prepare('delete from todo_leases where todo_id=?').run(id)
      : operation === 'renew' ? this.db.prepare('update todo_leases set expires_at=? where todo_id=? and holder_actor=? and token=? and expires_at>?').run(expires, id, actor.actorId, token, now)
      : this.db.prepare('delete from todo_leases where todo_id=? and holder_actor=? and token=? and expires_at>?').run(id, actor.actorId, token, now);
    if (!result.changes && operation !== 'revoke') throw new Error('Lease is expired, replaced, or owned by another actor');
    const event = { renew: 'renewed', release: 'released', revoke: 'revoked' }[operation];
    if (result.changes) this.event(actor, `todo.lease_${event}`, { todo_id: id });
    return operation === 'renew' ? { token, expires_at: expires, holder_actor: actor.actorId, holder_session_id: actor.sessionId } : { released: true };
  }

  listScratchpads(actor: ContextActor, input: Page & { status?: string | undefined; query?: string | undefined; session_id?: string | undefined }) {
    const clauses = ['s.project_id=?']; const params: unknown[] = [actor.projectId];
    if (input.status) { clauses.push('s.status=?'); params.push(input.status); }
    if (input.query) { clauses.push('(instr(lower(s.title),lower(?))>0 or instr(lower(s.body),lower(?))>0)'); params.push(input.query, input.query); }
    if (input.session_id) { this.scoped('sessions', input.session_id, actor); clauses.push('exists(select 1 from session_scratchpads a where a.scratchpad_id=s.id and a.session_id=?)'); params.push(input.session_id); }
    const where = clauses.join(' and ');
    const total = (this.db.prepare(`select count(*) n from scratchpads s where ${where}`).get(...params) as { n: number }).n;
    const items = this.db.prepare(`select s.id,s.project_id,s.title,s.status,s.revision,s.created_at,s.updated_at from scratchpads s where ${where} order by s.updated_at desc,s.id limit ? offset ?`).all(...params, input.limit, input.offset);
    return { items, total };
  }

  scratchpad(actor: ContextActor, id: string, input: Page & { mode: 'full' | 'content' | 'headings' }) {
    const row = this.scoped<ScratchpadRow>('scratchpads', id, actor); const lines = row.body.split('\n');
    const source = input.mode === 'headings' ? lines.filter(line => /^#{1,6}\s/.test(line)) : lines;
    return { ...row, body: source.slice(input.offset, input.offset + input.limit).join('\n'), total_lines: source.length,
      offset: input.offset, truncated: input.offset + input.limit < source.length };
  }

  createScratchpad(actor: ContextActor, input: { title: string; body: string; session_id?: string | undefined }) {
    const id = `scratchpad_${randomUUID()}`; const now = new Date(this.now()).toISOString();
    this.db.prepare('insert into scratchpads(id,project_id,title,body,created_at,updated_at,created_by_actor) values(?,?,?,?,?,?,?)').run(id, actor.projectId, input.title, input.body, now, now, actor.actorId);
    this.event(actor, 'scratchpad.created', { scratchpad_id: id });
    if (input.session_id) this.attachScratchpad(actor, id, input.session_id, false);
    return this.scoped<ScratchpadRow>('scratchpads', id, actor);
  }

  updateScratchpad(actor: ContextActor, input: { scratchpad_id: string; revision?: number | undefined; title?: string | undefined; body?: string | undefined; status?: 'active' | 'archived' | undefined }, append = false) {
    const row = this.scoped<ScratchpadRow>('scratchpads', input.scratchpad_id, actor);
    if (input.revision !== undefined) this.revision(row.revision, input.revision);
    const body = append ? row.body + (input.body ?? '') : input.body ?? row.body;
    if (body.length > 262144) throw new Error('Scratchpad body exceeds 262144 characters');
    this.db.prepare('update scratchpads set title=?,body=?,status=?,revision=revision+1,updated_at=? where id=?')
      .run(input.title ?? row.title, body, input.status ?? row.status, new Date(this.now()).toISOString(), row.id);
    this.event(actor, append ? 'scratchpad.appended' : 'scratchpad.updated', { scratchpad_id: row.id });
    return this.scoped<ScratchpadRow>('scratchpads', row.id, actor);
  }

  deleteScratchpad(actor: ContextActor, id: string, revision: number) {
    this.revision(this.scoped<ScratchpadRow>('scratchpads', id, actor).revision, revision);
    this.db.prepare('delete from scratchpads where id=?').run(id);
    this.event(actor, 'scratchpad.deleted', { scratchpad_id: id }); return { deleted: true };
  }

  attachScratchpad(actor: ContextActor, id: string, session: string, remove: boolean) {
    this.scoped('scratchpads', id, actor); this.scoped('sessions', session, actor);
    const result = remove ? this.db.prepare('delete from session_scratchpads where session_id=? and scratchpad_id=?').run(session, id)
      : this.db.prepare('insert or ignore into session_scratchpads(session_id,scratchpad_id) values(?,?)').run(session, id);
    if (result.changes) this.event(actor, 'scratchpad.attachment_changed', { scratchpad_id: id, session_id: session, removed: remove });
    return { attached: !remove };
  }

  references(actor: ContextActor, target: ReferenceTarget, page: Page) {
    const config = targets[target.target_type]; this.scoped(config.records, target.target_id, actor);
    const total = (this.db.prepare(`select count(*) n from ${config.attachments} where ${config.column}=?`).get(target.target_id) as { n: number }).n;
    const items = this.db.prepare(`select r.* from external_references r join ${config.attachments} a on a.reference_id=r.id where a.${config.column}=? order by r.created_at,r.id limit ? offset ?`).all(target.target_id, page.limit, page.offset) as ReferenceRow[];
    return { items, total };
  }

  attachReference(actor: ContextActor, input: ReferenceTarget & { url: string; provider: string; resource_type: string; external_id?: string | undefined; identifier?: string | undefined; title?: string | undefined }) {
    const config = targets[input.target_type]; this.scoped(config.records, input.target_id, actor);
    const canonical = referenceUrl(input.url); const now = new Date(this.now()).toISOString();
    this.db.prepare(`insert or ignore into external_references(id,project_id,url,provider,resource_type,external_id,identifier,title,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?)`)
      .run(`reference_${randomUUID()}`, actor.projectId, canonical, input.provider, input.resource_type, input.external_id ?? null, input.identifier ?? null, input.title ?? null, now, now);
    const reference = this.db.prepare('select * from external_references where project_id=? and url=?').get(actor.projectId, canonical) as ReferenceRow;
    const changed = this.db.prepare(`insert or ignore into ${config.attachments}(${config.column},reference_id) values(?,?)`).run(input.target_id, reference.id);
    if (changed.changes) this.event(actor, 'reference.attached', { target_type: input.target_type, target_id: input.target_id, reference_id: reference.id });
    return reference;
  }

  // A reference is shared by everything it is attached to, so edits apply everywhere.
  updateReference(actor: ContextActor, input: { reference_id: string; revision: number; url?: string | undefined; resource_type?: string | undefined; title?: string | undefined; identifier?: string | undefined; external_id?: string | undefined }) {
    const row = this.scoped<ReferenceRow>('external_references', input.reference_id, actor); this.revision(row.revision, input.revision);
    const url = input.url === undefined ? row.url : referenceUrl(input.url);
    if (url !== row.url && this.db.prepare('select 1 from external_references where project_id=? and url=? and id<>?').get(actor.projectId, url, row.id)) throw new Error('Another reference in this project already uses that URL');
    this.db.prepare('update external_references set url=?,resource_type=?,title=?,identifier=?,external_id=?,revision=revision+1,updated_at=? where id=?')
      .run(url, input.resource_type ?? row.resource_type, input.title ?? row.title, input.identifier ?? row.identifier, input.external_id ?? row.external_id, new Date(this.now()).toISOString(), row.id);
    this.event(actor, 'reference.updated', { reference_id: row.id }); return this.scoped<ReferenceRow>('external_references', row.id, actor);
  }

  detachReference(actor: ContextActor, input: ReferenceTarget & { reference_id: string }) {
    const config = targets[input.target_type]; this.scoped(config.records, input.target_id, actor); this.scoped('external_references', input.reference_id, actor);
    const changed = this.db.prepare(`delete from ${config.attachments} where ${config.column}=? and reference_id=?`).run(input.target_id, input.reference_id);
    if (changed.changes) this.event(actor, 'reference.detached', { ...input }); return { detached: true };
  }

  // The own worktree is always part of the session, so attaching it is a no-op
  // and detaching it is refused. The limit counts explicit links only.
  attachWorktree(actor: ContextActor, id: string, session: string, remove: boolean) {
    this.scoped('worktrees', id, actor);
    const own = this.scoped<{ worktree_id: string | null }>('sessions', session, actor).worktree_id === id;
    if (remove) {
      if (own) throw new Error('This worktree is the session\'s own working directory and cannot be detached');
      const result = this.db.prepare('delete from session_worktrees where session_id=? and worktree_id=?').run(session, id);
      if (result.changes) this.event(actor, 'worktree.attachment_changed', { worktree_id: id, session_id: session, removed: true });
      return { attached: false };
    }
    if (own || this.db.prepare('select 1 from session_worktrees where session_id=? and worktree_id=?').get(session, id)) return { attached: true };
    const linked = (this.db.prepare('select count(*) n from session_worktrees where session_id=?').get(session) as { n: number }).n;
    if (linked >= SESSION_WORKTREE_LIMIT) throw new Error(`A session can link at most ${SESSION_WORKTREE_LIMIT} worktrees; detach one first.`);
    this.db.prepare('insert into session_worktrees(session_id,worktree_id,created_at) values(?,?,?)').run(session, id, new Date(this.now()).toISOString());
    this.event(actor, 'worktree.attachment_changed', { worktree_id: id, session_id: session, removed: false });
    return { attached: true };
  }

  sessionWorktrees(session: string): { items: SessionWorktreeItem[]; total: number } {
    type Row = Omit<SessionWorktreeItem, 'own'>;
    const own = this.db.prepare(`select w.id,w.branch,w.worktree_path,w.repo_path,null linked_at from sessions s
      join worktrees w on w.id=s.worktree_id and w.project_id=s.project_id where s.id=?`).get(session) as Row | undefined;
    const linked = this.db.prepare(`select w.id,w.branch,w.worktree_path,w.repo_path,a.created_at linked_at from session_worktrees a
      join worktrees w on w.id=a.worktree_id join sessions s on s.id=a.session_id and s.project_id=w.project_id
      where a.session_id=? order by a.created_at,a.rowid`).all(session) as Row[];
    const items = [...(own ? [{ ...own, own: true }] : []), ...linked.filter(row => row.id !== own?.id).map(row => ({ ...row, own: false }))];
    return { items, total: items.length };
  }

  // Diff tools default to the caller's own worktree, else its first link.
  defaultWorktreeId(session: string): string {
    const worktree = this.sessionWorktrees(session).items[0];
    if (!worktree) throw new Error('This session has no worktree. Pass worktree_id, or link one with worktree_attach.');
    return worktree.id;
  }

  sessionContext(actor: ContextActor, session: string, page: Page) {
    this.scoped('sessions', session, actor);
    return { session_id: session, todos: this.listTodos(actor, { ...page, assignee_id: session }),
      scratchpads: this.listScratchpads(actor, { ...page, session_id: session }),
      references: this.references(actor, { target_type: 'session', target_id: session }, page),
      worktrees: this.sessionWorktrees(session) };
  }
}

// URL canonicalises host casing and default ports; preserve path, query, and fragment.
function referenceUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('References require an HTTP(S) URL without credentials');
  return url.href;
}
