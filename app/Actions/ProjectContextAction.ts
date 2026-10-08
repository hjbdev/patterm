import { z } from 'zod';
import type { DatabaseService } from '../Services/DatabaseService';
import { ProjectContextService, type ContextActor } from '../Services/ProjectContextService';

const id = z.string().min(1).max(200);
const title = z.string().trim().min(1).max(500);
const body = z.string().max(262144);
const revision = z.number().int().positive();
const page = { limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().nonnegative().default(0) };
const status = z.enum(['backlog', 'open', 'in_progress', 'completed']);
const priority = z.enum(['low', 'medium', 'high']);
// Agents may omit target_id for session targets; it resolves to their own session.
const target = { target_type: z.enum(['todo', 'scratchpad', 'session']), target_id: id.optional() };
const ttl = z.number().int().min(1).max(86400).default(300);
const token = z.string().uuid();
const query = z.string().max(500).optional();
const input = <T extends z.ZodRawShape>(shape: T) => z.object({ project_id: id.optional(), ...shape }).strict();

export const contextSchemas = {
  'patterm.todo.create': input({ title, notes: body.default(''), status: status.default('open'), priority: priority.default('medium'), assignee_id: id.optional() }),
  'patterm.todo.list': input({ ...page, status: status.optional(), priority: priority.optional(), assignee_id: id.optional(), blocked: z.boolean().optional(), query }),
  'patterm.todo.get': input({ todo_id: id }),
  'patterm.todo.update': input({ todo_id: id, revision, title: title.optional(), notes: body.optional(), status: status.optional(), priority: priority.optional() }),
  'patterm.todo.delete': input({ todo_id: id, revision }),
  'patterm.todo.assign': input({ todo_id: id, assignee_id: id.optional() }),
  'patterm.todo.unassign': input({ todo_id: id, assignee_id: id.optional() }),
  'patterm.todo.dependency_add': input({ todo_id: id, blocker_id: id }),
  'patterm.todo.dependency_remove': input({ todo_id: id, blocker_id: id }),
  'patterm.todo.lease_acquire': input({ todo_id: id, ttl_seconds: ttl }),
  'patterm.todo.lease_renew': input({ todo_id: id, token, ttl_seconds: ttl }),
  'patterm.todo.lease_release': input({ todo_id: id, token }),
  'patterm.todo.lease_revoke': input({ todo_id: id }),
  'patterm.scratchpad.create': input({ title, body: body.default(''), session_id: id.optional() }),
  'patterm.scratchpad.list': input({ ...page, status: z.enum(['active', 'archived']).optional(), query }),
  'patterm.scratchpad.get': input({ scratchpad_id: id, mode: z.enum(['full', 'content', 'headings']).default('full'), offset: page.offset, limit: z.number().int().min(1).max(1000).default(200) }),
  'patterm.scratchpad.update': input({ scratchpad_id: id, revision, title: title.optional(), body: body.optional(), status: z.enum(['active', 'archived']).optional() }),
  'patterm.scratchpad.append': input({ scratchpad_id: id, revision: revision.optional(), body }),
  'patterm.scratchpad.delete': input({ scratchpad_id: id, revision }),
  'patterm.scratchpad.attach': input({ scratchpad_id: id, session_id: id.optional() }),
  'patterm.scratchpad.detach': input({ scratchpad_id: id, session_id: id.optional() }),
  'patterm.worktree.attach': input({ worktree_id: id, session_id: id.optional() }),
  'patterm.worktree.detach': input({ worktree_id: id, session_id: id.optional() }),
  'patterm.reference.attach': input({ ...target, url: z.string().url().max(4096), provider: z.enum(['generic', 'linear', 'github']).default('generic'), resource_type: z.enum(['generic', 'issue', 'pull_request']).default('generic'), external_id: z.string().max(500).optional(), identifier: z.string().max(500).optional(), title: title.optional() }),
  'patterm.reference.list': input({ ...target, ...page }),
  'patterm.reference.update': input({ reference_id: id, revision, url: z.string().url().max(4096).optional(), resource_type: z.enum(['generic', 'issue', 'pull_request']).optional(), title: z.string().max(500).optional(), identifier: z.string().max(500).optional(), external_id: z.string().max(500).optional() }),
  'patterm.reference.detach': input({ ...target, reference_id: id }),
  'patterm.session.context': input({ session_id: id.optional(), ...page })
};
export type ContextOperation = keyof typeof contextSchemas;
export const contextReadOperations = new Set<ContextOperation>(['patterm.todo.list', 'patterm.todo.get', 'patterm.scratchpad.list', 'patterm.scratchpad.get', 'patterm.reference.list', 'patterm.session.context']);

export class ProjectContextAction {
  constructor(private readonly database: DatabaseService, private readonly service: ProjectContextService) {}

  execute(operation: ContextOperation, raw: unknown, identity?: string | null): unknown {
    const parsed = contextSchemas[operation].parse(raw);
    const actor = this.service.actor(identity, parsed.project_id);
    const run = () => this.dispatch(operation, raw, actor);
    return contextReadOperations.has(operation) ? run() : this.database.connection.transaction(run)();
  }

  // Links a worktree that an agent just created or linked to that agent's
  // session. The worktree already exists, so a failed link (for example, a
  // full session) is reported as a warning rather than an error.
  linkAgentWorktree(session: { sessionId: string; projectId: string }, worktreeId: string): { attached: true } | { attached: false; warning: string } {
    const actor: ContextActor = { projectId: session.projectId, actorId: session.sessionId, sessionId: session.sessionId };
    try {
      this.database.connection.transaction(() => this.service.attachWorktree(actor, worktreeId, session.sessionId, false))();
      return { attached: true };
    } catch (error) {
      return { attached: false, warning: `The worktree was not linked to your session: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private dispatch(operation: ContextOperation, raw: unknown, actor: ContextActor): unknown {
    const service = this.service;
    // Each branch uses its own parsed shape: unknown request fields cannot select
    // actor identity, SQL columns, or another project's records.
    switch (operation) {
      case 'patterm.todo.create': return service.createTodo(actor, contextSchemas[operation].parse(raw));
      case 'patterm.todo.list': return service.listTodos(actor, contextSchemas[operation].parse(raw));
      case 'patterm.todo.get': return service.todo(contextSchemas[operation].parse(raw).todo_id, actor);
      case 'patterm.todo.update': return service.updateTodo(actor, contextSchemas[operation].parse(raw));
      case 'patterm.todo.delete': { const p = contextSchemas[operation].parse(raw); return service.deleteTodo(actor, p.todo_id, p.revision); }
      case 'patterm.todo.assign': case 'patterm.todo.unassign': {
        const p = contextSchemas[operation].parse(raw); return service.assign(actor, p.todo_id, p.assignee_id ?? actor.actorId, operation.endsWith('.unassign'));
      }
      case 'patterm.todo.dependency_add': case 'patterm.todo.dependency_remove': {
        const p = contextSchemas[operation].parse(raw); return service.dependency(actor, p.todo_id, p.blocker_id, operation.endsWith('_remove'));
      }
      case 'patterm.todo.lease_acquire': { const p = contextSchemas[operation].parse(raw); return service.lease(actor, p.todo_id, 'acquire', p.ttl_seconds); }
      case 'patterm.todo.lease_renew': { const p = contextSchemas[operation].parse(raw); return service.lease(actor, p.todo_id, 'renew', p.ttl_seconds, p.token); }
      case 'patterm.todo.lease_release': { const p = contextSchemas[operation].parse(raw); return service.lease(actor, p.todo_id, 'release', 300, p.token); }
      case 'patterm.todo.lease_revoke': { const p = contextSchemas[operation].parse(raw); return service.lease(actor, p.todo_id, 'revoke', 300); }
      case 'patterm.scratchpad.create': return service.createScratchpad(actor, contextSchemas[operation].parse(raw));
      case 'patterm.scratchpad.list': return service.listScratchpads(actor, contextSchemas[operation].parse(raw));
      case 'patterm.scratchpad.get': { const p = contextSchemas[operation].parse(raw); return service.scratchpad(actor, p.scratchpad_id, p); }
      case 'patterm.scratchpad.update': return service.updateScratchpad(actor, contextSchemas[operation].parse(raw));
      case 'patterm.scratchpad.append': return service.updateScratchpad(actor, contextSchemas[operation].parse(raw), true);
      case 'patterm.scratchpad.delete': { const p = contextSchemas[operation].parse(raw); return service.deleteScratchpad(actor, p.scratchpad_id, p.revision); }
      case 'patterm.scratchpad.attach': case 'patterm.scratchpad.detach': {
        const p = contextSchemas[operation].parse(raw); const session = p.session_id ?? actor.sessionId;
        if (!session) throw new Error('session_id is required for owner requests');
        return service.attachScratchpad(actor, p.scratchpad_id, session, operation.endsWith('.detach'));
      }
      case 'patterm.worktree.attach': case 'patterm.worktree.detach': {
        const p = contextSchemas[operation].parse(raw); const session = p.session_id ?? actor.sessionId;
        if (!session) throw new Error('session_id is required for owner requests');
        return service.attachWorktree(actor, p.worktree_id, session, operation.endsWith('.detach'));
      }
      case 'patterm.reference.attach': return service.attachReference(actor, withTarget(contextSchemas[operation].parse(raw), actor));
      case 'patterm.reference.list': { const p = withTarget(contextSchemas[operation].parse(raw), actor); return service.references(actor, p, p); }
      case 'patterm.reference.update': return service.updateReference(actor, contextSchemas[operation].parse(raw));
      case 'patterm.reference.detach': return service.detachReference(actor, withTarget(contextSchemas[operation].parse(raw), actor));
      case 'patterm.session.context': {
        const p = contextSchemas[operation].parse(raw); const session = p.session_id ?? actor.sessionId;
        if (!session) throw new Error('session_id is required for owner requests');
        return service.sessionContext(actor, session, p);
      }
    }
  }
}

function withTarget<T extends { target_type: 'todo' | 'scratchpad' | 'session'; target_id?: string | undefined }>(input: T, actor: ContextActor): T & { target_id: string } {
  const targetId = input.target_id ?? (input.target_type === 'session' ? actor.sessionId : null);
  if (!targetId) throw new Error(input.target_type === 'session' ? 'target_id is required for owner requests' : `target_id is required for ${input.target_type} targets`);
  return { ...input, target_id: targetId };
}
