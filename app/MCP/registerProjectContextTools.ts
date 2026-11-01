import { z } from 'zod';
import { contextReadOperations, contextSchemas, type ContextOperation, type ProjectContextAction } from '../Actions/ProjectContextAction';
import type { McpToolRegistry } from './ToolRegistry';

// The workbench keeps ended sessions that a todo is assigned to, so changing
// assignments can change it too.
const assignmentOperations = new Set<ContextOperation>(['todo_create', 'todo_assign', 'todo_unassign', 'todo_delete']);

export function registerProjectContextTools(registry: McpToolRegistry, action: ProjectContextAction) {
  for (const operation of Object.keys(contextSchemas) as ContextOperation[]) {
    registry.register({
      name: operation, namespace: operation.split('_')[0]!,
      hidden: operation === 'todo_lease_revoke',
      description: descriptions[operation] ?? `${operation.replaceAll('_', ' ')} within the caller's project.`,
      inputSchema: objectSchema(contextSchemas[operation]),
      changes: contextReadOperations.has(operation) ? [] : assignmentOperations.has(operation) ? ['workbench', 'context'] : ['context'],
      usageNotes: [
        'Agents infer project_id from authenticated identity; owner/UI calls require project_id. All linked records must belong to that project.',
        'List reads return {items,total}, omit note bodies, and accept limit (1–100, default 50) and offset (default 0).',
        'Edits and deletions require the current revision. On conflict, preserve your draft and fetch the latest record before retrying.',
        'Assignments persist independently of leases. Omit assignee_id to assign yourself (the owner is user). Dependencies indicate blockers without controlling processes.',
        'Lease acquisition returns a secret token; retain it to renew/release. TTL is 1–86400 seconds, default 300. Expired/replaced tokens fail. Only the owner can revoke another holder.',
        'Scratchpad reads return body, total_lines, offset, and truncated; paginate using the same revision to obtain a consistent full body. Default 200 lines, maximum 1000. Atomic append may omit revision; it appends exactly the supplied text.',
        'Titles allow 500 characters and note bodies 262144. Only requested content is loaded; terminal output is never collected automatically.',
        'Resolve PR and issue identifiers with your provider MCP or CLI first, then attach the verified URL. Patterm stores references and does not fetch or synchronise external resources.',
        'Session scratchpad and worktree attachments, session references, and session context infer the caller\'s session for agents; owner requests require it.',
        'After opening or finding a PR or issue for your work, attach it to your session, for example reference_attach {target_type:"session", url, provider:"github", resource_type:"pull_request", identifier:"#42"}. Providers are github, linear, and generic; resource types are pull_request, issue, preview, and generic.',
        'When you start or find a dev server, preview deploy, or other page the user will want to open, attach it with resource_type preview, for example reference_attach {target_type:"session", url:"http://localhost:5173", resource_type:"preview", title:"Vite dev server"}. Local URLs need no provider check.',
        'status records where a link stands, as you last saw it: open, approved (review is green), merged, released, deployed, verified, or closed for PRs and issues; running, kept (left up on purpose after the task), or stopped for previews. deployed means a deploy was reported; verified means you checked the live change works. Attach the same URL again with a new status to update it, or pass none to clear it.'
      ]
    }, (args, context) => action.execute(operation, args, context.identity));
  }
}

const descriptions: Partial<Record<ContextOperation, string>> = {
  'todo_create': 'Create a todo. Pass assignee_id to assign it in the same call; the todo is not created if the assignment fails.',
  'scratchpad_create': 'Create a scratchpad. Pass session_id to attach it to that session in the same call; the scratchpad is not created if the attachment fails.',
  'session_context': 'Read an agent session\'s worktrees (its own working directory first, then up to 10 linked worktrees, unpaginated), plus paginated assigned todos, attached scratchpads, and external references.',
  'worktree_attach': 'Link a project worktree to a session so it is listed with that session and its diff can be reviewed. Agents may omit session_id for their own session. Repeated attachment is idempotent; a session links at most 10 worktrees. worktree_create and worktree_link already link the worktree to the calling agent.',
  'worktree_detach': 'Unlink a worktree from a session without changing its files, branch, or project registration. Agents may omit session_id for their own session. A session\'s own working directory cannot be detached.',
  'todo_update': 'Edit a todo with a revision guard; set status to completed to complete, or open to reopen. Completion releases its lease.',
  'todo_lease_acquire': 'Acquire exclusive, expiring work ownership of a todo. Returns the token required for renewal and release.',
  'reference_attach': 'Attach an HTTP(S) link, such as a PR, issue, or dev server preview, to a todo, scratchpad, or session. Agents may omit target_id for their own session. Repeated attachment is idempotent.',
  'scratchpad_update': 'Replace scratchpad content or metadata with a revision guard; set status to archived or active to archive or restore.'
};

// The context schemas contain only flat primitive fields. Keeping this small
// conversion beside registration ensures tool help and runtime limits agree.
function objectSchema(schema: z.AnyZodObject): Record<string, unknown> {
  const required: string[] = [];
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema.shape) as [string, z.ZodTypeAny][]) {
    let field = value; let defaultValue: unknown;
    if (!field.isOptional()) required.push(key);
    while (field instanceof z.ZodOptional || field instanceof z.ZodDefault) {
      if (field instanceof z.ZodDefault) defaultValue = field._def.defaultValue();
      field = field._def.innerType;
    }
    const property: Record<string, unknown> = {};
    if (field instanceof z.ZodString) {
      property.type = 'string';
      if (field.minLength !== null) property.minLength = field.minLength;
      if (field.maxLength !== null) property.maxLength = field.maxLength;
    } else if (field instanceof z.ZodNumber) {
      property.type = field.isInt ? 'integer' : 'number';
      if (field.minValue !== null) property.minimum = field.minValue;
      if (field.maxValue !== null) property.maximum = field.maxValue;
    } else if (field instanceof z.ZodEnum) { property.type = 'string'; property.enum = field.options; }
    else if (field instanceof z.ZodBoolean) property.type = 'boolean';
    if (defaultValue !== undefined) property.default = defaultValue;
    properties[key] = property;
  }
  return { type: 'object', properties, required, additionalProperties: false };
}
