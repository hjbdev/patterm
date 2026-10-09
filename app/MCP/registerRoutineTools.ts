import { z } from 'zod';
import { MAX_ONCE_AHEAD_MS, ROUTINE_HARNESSES, type RoutineActor, type RoutineRecord, type RoutineRunRecord, type RoutineService } from '../Services/RoutineService';
import type { McpCallContext, McpToolDescriptor, McpToolHandler, McpToolRegistry } from './ToolRegistry';

// Who is calling: null for the owner and the UI. Workspace callers (the
// assistant and workspace routine runs) reach every project; other agents only
// their own.
export interface RoutineCaller {
  sessionId: string;
  projectId: string;
  workspace: boolean;
}

const routineIdInput = z.object({ routine_id: z.string().min(1) }).strict();
const listInput = z.object({ project_id: z.string().min(1).optional() }).strict();
const logInput = z.object({ routine_id: z.string().min(1).optional(), limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().min(0).default(0) }).strict();
const runInput = z.object({ run_id: z.string().min(1) }).strict();
const scheduleOnceInput = z.object({
  run_at: z.string().optional(),
  in_minutes: z.number().int().min(1).max(MAX_ONCE_AHEAD_MS / 60_000).optional()
}).passthrough().refine((input) => (input.run_at === undefined) !== (input.in_minutes === undefined), 'Pass either run_at or in_minutes');
const runsInput = z.object({ routine_id: z.string().min(1), limit: z.number().int().min(1).max(100).default(20) }).strict();

const launchProperties = {
  harness: { type: 'string', enum: [...ROUTINE_HARNESSES], description: 'Agent CLI to start. harness_list shows which are installed.' },
  preset: { type: ['string', 'null'], description: 'A configured preset name for this harness (harness_presets). Leave null to pick a model instead, or for the harness default.' },
  model: { type: ['string', 'null'], description: 'A model ID from harness_models, used instead of a preset.' },
  reasoning: { type: ['string', 'null'], description: 'Effort level for the chosen model.' },
  service_tier: { type: ['string', 'null'], description: 'Codex only: priority for Fast, default for Standard.' }
};

const routineProperties = {
  name: { type: 'string', maxLength: 120 },
  enabled: { type: 'boolean', description: 'Whether it runs on schedule. Paused routines can still run with routine_run_now.' },
  project_id: { type: ['string', 'null'], description: 'Project the run belongs to. Null makes a workspace routine that reads across every project; only the user, the assistant, and workspace routines can choose this.' },
  days: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 }, description: 'Weekdays to run on: 0 is Sunday, 1 Monday, through 6 Saturday.' },
  time: { type: 'string', description: 'Local 24-hour time, HH:MM.' },
  timezone: { type: 'string', description: 'IANA time zone, such as Europe/London. Defaults to the server\'s zone.' },
  prompt: { type: 'string', maxLength: 20000, description: 'Task for each run. {{date}}, {{weekday}}, {{since}} (the last successful run), and {{last_run_at}} are filled in when it starts.' },
  ...launchProperties,
  delivery: { type: 'string', enum: ['notification', 'none'], description: 'What happens when a run reports: notify the user, or nothing.' },
  run_at: { type: ['string', 'null'], description: 'ISO time with an offset. Set it to run once at that time instead of on days; null makes it repeat again.' },
  worktree_id: { type: ['string', 'null'], description: 'A project worktree to start each run in, from worktree_list.' }
};

const { days: _days, time: _time, enabled: _enabled, run_at: _runAt, ...onceProperties } = routineProperties;

const USAGE_NOTES = [
  'A routine starts a fresh agent on the chosen days and time. The run uses the harness\'s native permissions; nothing in a routine changes them, and a run that stops on a permission prompt waits for the user.',
  'Each run must call report_to_parent when finished. That completes the run; Patterm stops the session after it has been idle for 10 minutes.',
  'Choose either a preset or a model with optional reasoning and service_tier, as spawn_agent accepts.',
  'Agents create and manage routines in their own project. The assistant and workspace routines may pass project_id, or null for a workspace routine.',
  'Create routines only when the user asks for recurring work; tell them what you scheduled and when it next runs.',
  'For a single later run, use routine_schedule_once.'
];

const ONCE_NOTES = [
  'Starts a fresh agent once, later, instead of keeping this one waiting. Use it to hand off follow-up work, such as checking a deploy in an hour, so a long-idle agent does not have to resume on a cold cache.',
  'The new agent knows only the prompt. Make it stand alone: the goal, what is done so far, the branch, files, PR or URLs involved, and what to report. It can read your conversation with get_conversation_output if something is missing.',
  'Pass worktree_id to start it in your worktree. Its report goes to the user, not to you.',
  'Pass in_minutes, or run_at as an ISO time with an offset. It runs within a year; a project holds at most 20 waiting one-off runs.',
  'Choose either a preset or a model with optional reasoning and service_tier, as spawn_agent accepts. Tell the user what you scheduled and when.'
];

// Saves or reads routines on a paired host for the calling agent.
export type RoutineForward = (host: string, tool: string, args: Record<string, unknown>, context: McpCallContext) => Promise<unknown>;

const HOST_NOTE = 'Pass host, a paired host\'s name, to save or read routines on that host in the project linked with yours. They are owned by that host and run there, and routine IDs are that host\'s. Its worktree IDs come from host_read worktree_list.';

export function registerRoutineTools(registry: McpToolRegistry, routines: RoutineService, callerOf: (context: McpCallContext) => RoutineCaller | null, forward?: RoutineForward) {
  // Every routine tool except run_now also works on a paired host. Runs
  // start only on the host that owns the routine.
  const register = (descriptor: McpToolDescriptor, handler: McpToolHandler) => {
    if (!forward) return registry.register(descriptor, handler);
    if (descriptor.name === 'routine_run_now') {
      return registry.register(descriptor, (args, context) => {
        if (args && typeof args === 'object' && 'host' in args) throw new Error('routine.run_now cannot start a run on another host. Routines there run on their schedule; ask the user to run one now.');
        return handler(args, context);
      });
    }
    const schema = descriptor.inputSchema as { properties?: Record<string, unknown> };
    registry.register({
      ...descriptor,
      inputSchema: { ...schema, properties: { ...schema.properties, host: { type: 'string', description: 'A paired host to run this on, instead of this host.' } } },
      usageNotes: [...(descriptor.usageNotes ?? []), HOST_NOTE]
    }, (args, context) => {
      const { host, ...rest } = (args ?? {}) as Record<string, unknown>;
      if (host === undefined) return handler(args, context);
      if (typeof host !== 'string' || !host) throw new Error('host must be a paired host name');
      return forward(host, descriptor.name, rest, context);
    });
  };
  const scoped = (context: McpCallContext, routineId: string): RoutineRecord => {
    const routine = routines.get(routineId);
    const caller = callerOf(context);
    if (caller && !caller.workspace && routine.project_id !== caller.projectId) throw new Error('routine is outside the current caller scope');
    return routine;
  };
  // A routine can move between projects, but its runs stay with the project they ran in,
  // so a project agent sees only its own project's runs and reports.
  const runVisible = (context: McpCallContext, run: RoutineRunRecord): boolean => {
    const caller = callerOf(context);
    return !caller || caller.workspace || run.project_id === caller.projectId;
  };
  const withVisibleRuns = (context: McpCallContext, routine: RoutineRecord): RoutineRecord => ({
    ...routine,
    last_run: routine.last_run && runVisible(context, routine.last_run) ? routine.last_run : null,
    waiting_run: routine.waiting_run && runVisible(context, routine.waiting_run) ? routine.waiting_run : null
  });
  const actorOf = (context: McpCallContext): RoutineActor => {
    // An agent on a paired host, named and addressed from this host.
    const remote = context.remote;
    if (remote?.agent) {
      return {
        type: 'agent',
        id: `${remote.host_name}:${remote.agent.session_id}`,
        remote: { name: `${remote.agent.name} on ${remote.host_name}`, process_id: remote.agent.process_id ? `${remote.host_name}:${remote.agent.process_id}` : null }
      };
    }
    const caller = callerOf(context);
    return caller ? { type: 'agent', id: caller.sessionId } : { type: 'user', id: null };
  };
  // Project agents may only place routines in their own project.
  const projectFor = (context: McpCallContext, requested: unknown): string | null | undefined => {
    const caller = callerOf(context);
    if (!caller || caller.workspace) return requested as string | null | undefined;
    if (requested !== undefined && requested !== caller.projectId) throw new Error('Agents can only create routines in their own project');
    return caller.projectId;
  };

  register({
    name: 'routine_list',
    namespace: 'routine',
    description: 'List scheduled routines with their next run and latest run.',
    changes: [],
    inputSchema: { type: 'object', additionalProperties: false, properties: { project_id: { type: 'string', description: 'Only for the user, the assistant, and workspace routines.' } } },
    usageNotes: USAGE_NOTES
  }, (args, context) => {
    const input = listInput.parse(args ?? {});
    const caller = callerOf(context);
    if (caller && !caller.workspace) return { routines: routines.list({ projectId: caller.projectId }).map((routine) => withVisibleRuns(context, routine)) };
    return { routines: routines.list(input.project_id ? { projectId: input.project_id } : {}) };
  });

  register({
    name: 'routine_get',
    namespace: 'routine',
    description: 'Read one routine, including its prompt and launch settings.',
    changes: [],
    inputSchema: { type: 'object', required: ['routine_id'], additionalProperties: false, properties: { routine_id: { type: 'string' } } }
  }, (args, context) => withVisibleRuns(context, scoped(context, routineIdInput.parse(args).routine_id)));

  register({
    name: 'routine_create',
    namespace: 'routine',
    description: 'Schedule a routine: an agent that starts on chosen weekdays at a local time with a prompt.',
    changes: ['routines'],
    inputSchema: { type: 'object', required: ['name'], additionalProperties: false, properties: routineProperties },
    usageNotes: USAGE_NOTES
  }, (args, context) => {
    const input = { ...(args as Record<string, unknown>) };
    const projectId = projectFor(context, input.project_id);
    if (projectId !== undefined) input.project_id = projectId;
    return routines.create(input, actorOf(context));
  });

  register({
    name: 'routine_schedule_once',
    namespace: 'routine',
    description: 'Schedule a fresh agent to run once, later, with a prompt. It reports to the user and appears under Scheduled.',
    changes: ['routines'],
    inputSchema: { type: 'object', required: ['name', 'prompt'], additionalProperties: false, properties: {
      ...onceProperties,
      in_minutes: { type: 'integer', minimum: 1, description: 'Minutes from now. Use this or run_at.' },
      run_at: { type: 'string', description: 'ISO time with an offset, such as 2026-10-07T09:00:00+01:00. Use this or in_minutes.' }
    } },
    usageNotes: ONCE_NOTES
  }, (args, context) => {
    const { in_minutes: inMinutes, ...input } = scheduleOnceInput.parse(args ?? {}) as Record<string, unknown> & { in_minutes?: number; run_at?: string };
    const runAt = inMinutes !== undefined ? new Date(Date.now() + inMinutes * 60_000).toISOString() : input.run_at!;
    const projectId = projectFor(context, input.project_id);
    return routines.create({ ...input, run_at: runAt, days: [], enabled: true, ...(projectId !== undefined ? { project_id: projectId } : {}) }, actorOf(context));
  });

  register({
    name: 'routine_update',
    namespace: 'routine',
    description: 'Change a routine. Pass only the fields to change; set enabled false to pause it.',
    changes: ['routines'],
    inputSchema: { type: 'object', required: ['routine_id'], additionalProperties: false, properties: { routine_id: { type: 'string' }, ...routineProperties } },
    usageNotes: ['Changing harness clears preset, model, reasoning, and service_tier unless you pass new ones.']
  }, (args, context) => {
    const input = { ...(args as Record<string, unknown>) };
    scoped(context, String(input.routine_id ?? ''));
    if ('project_id' in input) input.project_id = projectFor(context, input.project_id);
    return withVisibleRuns(context, routines.update(input));
  });

  register({
    name: 'routine_delete',
    namespace: 'routine',
    description: 'Delete a routine and its run history. Running agents keep running.',
    changes: ['routines'],
    inputSchema: { type: 'object', required: ['routine_id'], additionalProperties: false, properties: { routine_id: { type: 'string' } } }
  }, (args, context) => routines.delete(scoped(context, routineIdInput.parse(args).routine_id).routine_id));

  register({
    name: 'routine_run_now',
    namespace: 'routine',
    description: 'Start a run of a routine immediately, outside its schedule.',
    changes: ['routines', 'workbench'],
    inputSchema: { type: 'object', required: ['routine_id'], additionalProperties: false, properties: { routine_id: { type: 'string' } } }
  }, (args, context) => routines.runNow(scoped(context, routineIdInput.parse(args).routine_id).routine_id));

  register({
    name: 'routine_runs',
    namespace: 'routine',
    description: 'List a routine\'s runs, newest first, with each report excerpt and session.',
    changes: [],
    inputSchema: { type: 'object', required: ['routine_id'], additionalProperties: false, properties: { routine_id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } } }
  }, (args, context) => {
    const input = runsInput.parse(args);
    scoped(context, input.routine_id);
    return { runs: routines.runs(input.routine_id, input.limit).filter((run) => runVisible(context, run)) };
  });

  register({
    name: 'routine_log',
    namespace: 'routine',
    description: 'Page through recent routine reports, newest first, across routines or for one routine. Skipped runs are left out.',
    changes: [],
    inputSchema: { type: 'object', additionalProperties: false, properties: { routine_id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }, offset: { type: 'integer', minimum: 0, default: 0 } } }
  }, (args, context) => {
    const input = logInput.parse(args ?? {});
    if (input.routine_id) scoped(context, input.routine_id);
    const caller = callerOf(context);
    return { runs: routines.reports({ limit: input.limit, offset: input.offset, ...(input.routine_id ? { routineId: input.routine_id } : {}), ...(caller && !caller.workspace ? { projectId: caller.projectId } : {}) }) };
  });

  register({
    name: 'routine_run',
    namespace: 'routine',
    description: 'Read one routine run, including its full report.',
    changes: [],
    inputSchema: { type: 'object', required: ['run_id'], additionalProperties: false, properties: { run_id: { type: 'string' } } }
  }, (args, context) => {
    const run = routines.getRun(runInput.parse(args).run_id);
    scoped(context, run.routine_id);
    if (!runVisible(context, run)) throw new Error('routine run is outside the current caller scope');
    return run;
  });
}
