import { DEFAULT_CHANGE_TOPICS, type ChangeTopic } from '../Services/ChangeTopics';

export interface McpToolDescriptor {
  name: string;
  namespace: string;
  description: string;
  inputSchema: Record<string, unknown>;
  usageNotes?: string[];
  // MCP tool hints. Harnesses that honour them ask before a destructive call.
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  hidden?: boolean;
  // Client-visible data a successful call can change. Reads declare none.
  // Tools that omit it count as changing workbench and context data.
  changes?: readonly ChangeTopic[];
  // Why the tool is off for this caller, or null while it is on. An
  // unavailable tool leaves the caller's catalog and rejects its calls.
  unavailable?: (context: McpCallContext) => string | null;
}

export interface McpCallContext {
  identity?: string | null;
  // A call made for an agent on a paired host, scoped to the local project
  // linked with that agent's project. `agent` names the calling agent, on
  // its own host, for calls that record who made them.
  remote?: { host_id: string; host_name: string; project_id: string; agent?: { session_id: string; process_id: string | null; name: string } };
}

// Routes a public call elsewhere, such as to another host, or returns null
// to run it here.
export type McpCallRouter = (toolName: string, args: unknown, context: McpCallContext) => Promise<unknown> | null;

export type McpToolHandler = (args: unknown, context: McpCallContext) => Promise<unknown> | unknown;

const READ_ONLY_TOOL_NAMES = new Set([
  'list_processes',
  'get_process_status',
  'get_project_status',
  'get_process_output',
  'get_conversation_output',
  'search_conversation_history',
  'search_output',
  'wait_for_pattern',
  'get_process_ports',
  'timer_list',
  'whoami',
  'help',
  'search',
  'history_sources',
  'history_import_status',
  'history_list',
  'history_get',
  'project_list',
  'project_get',
  'terminal_process_output',
  'terminal_process_search',
  'terminal_process_selection_text',
  'harness_list',
  'worktree_list',
  'diff_current',
  'diff_file',
  'harness_presets',
  'harness_models'
]);

const TOOL_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

interface RegisteredTool {
  descriptor: McpToolDescriptor;
  handler: McpToolHandler;
}

export class McpToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private router: McpCallRouter | null = null;
  private checkCaller: ((context: McpCallContext) => void) | null = null;

  setRouter(router: McpCallRouter): void {
    this.router = router;
  }

  // Runs before every public call, so no tool can skip checking its caller.
  setCallerCheck(check: (context: McpCallContext) => void): void {
    this.checkCaller = check;
  }

  // Every tool name is snake_case, so harnesses that cannot pass dots show
  // the name agents call and pass to help.
  register(descriptor: McpToolDescriptor, handler: McpToolHandler): void {
    if (!TOOL_NAME.test(descriptor.name)) throw new Error(`MCP tool ${descriptor.name} must be snake_case`);
    if (this.tools.has(descriptor.name)) throw new Error(`duplicate MCP tool ${descriptor.name}`);
    this.tools.set(descriptor.name, { descriptor, handler });
  }

  // Without a caller, every public tool is listed.
  publicTools(context?: McpCallContext): McpToolDescriptor[] {
    return [...this.tools.values()].map(({ descriptor }) => descriptor).filter(({ hidden, unavailable }) => !hidden && !(context && unavailable?.(context)))
      .map(({ unavailable: _unavailable, ...descriptor }) => descriptor)
      .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  }

  setInputSchema(name: string, inputSchema: Record<string, unknown>): void {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`unknown MCP tool ${name}`);
    tool.descriptor.inputSchema = inputSchema;
  }

  help(toolName: string) {
    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new Error(`unknown MCP tool ${toolName}`);
    }

    return tool.descriptor;
  }

  helpPublic(toolName: string): McpToolDescriptor {
    const { unavailable: _unavailable, ...descriptor } = this.publicTool(toolName).descriptor;
    return descriptor;
  }

  async callPublic(toolName: string, args: unknown, context: McpCallContext = {}): Promise<unknown> {
    const tool = this.publicTool(toolName);
    const reason = tool.descriptor.unavailable?.(context);
    if (reason) throw new Error(reason);
    this.checkCaller?.(context);
    return this.router?.(tool.descriptor.name, args, context) ?? tool.handler(args, context);
  }

  async call(toolName: string, args: unknown, context: McpCallContext = {}) {
    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new Error(`unknown MCP tool ${toolName}`);
    }

    return tool.handler(args, context);
  }

  // The topics clients must update after a successful call. Calls ignore their
  // arguments and results, so a write that changes nothing still reports them.
  changedTopics(toolName: string): readonly ChangeTopic[] {
    const tool = this.tools.get(toolName);
    if (!tool) return [];
    return tool.descriptor.changes ?? (READ_ONLY_TOOL_NAMES.has(tool.descriptor.name) ? [] : DEFAULT_CHANGE_TOPICS);
  }

  private publicTool(name: string): RegisteredTool {
    const tool = this.tools.get(name);
    if (!tool || tool.descriptor.hidden) {
      throw new Error(`unknown MCP tool ${name}`);
    }
    return tool;
  }
}
