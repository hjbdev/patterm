import { DEFAULT_CHANGE_TOPICS, type ChangeTopic } from '../Services/ChangeTopics';

export interface McpToolDescriptor {
  name: string;
  namespace: string;
  description: string;
  inputSchema: Record<string, unknown>;
  usageNotes?: string[];
  hidden?: boolean;
  // Client-visible data a successful call can change. Reads declare none.
  // Tools that omit it count as changing workbench and context data.
  changes?: readonly ChangeTopic[];
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
  'patterm.help',
  'patterm.search',
  'patterm.history.sources',
  'patterm.history.import_status',
  'patterm.history.list',
  'patterm.history.get',
  'patterm.project.list',
  'patterm.project.get',
  'patterm.terminal.process.output',
  'patterm.terminal.process.search',
  'patterm.terminal.process.selection_text',
  'patterm.harness.list',
  'patterm.worktree.list',
  'patterm.diff.current',
  'patterm.diff.file',
  'patterm.harness.presets',
  'patterm.harness.models'
]);

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

  register(descriptor: McpToolDescriptor, handler: McpToolHandler): void {
    if (this.tools.has(descriptor.name)) throw new Error(`duplicate MCP tool ${descriptor.name}`);
    if (!descriptor.hidden && this.publicTools().some(({ name }) => name === publicName(descriptor.name))) {
      throw new Error(`duplicate public MCP tool ${publicName(descriptor.name)}`);
    }
    this.tools.set(descriptor.name, { descriptor, handler });
  }

  publicTools(): McpToolDescriptor[] {
    return [...this.tools.values()].map(({ descriptor }) => descriptor).filter(({ hidden }) => !hidden)
      .map((descriptor) => ({ ...descriptor, name: publicName(descriptor.name) }))
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
    const tool = this.publicTool(toolName);
    return { ...tool.descriptor, name: toolName };
  }

  async callPublic(toolName: string, args: unknown, context: McpCallContext = {}): Promise<unknown> {
    const tool = this.publicTool(toolName);
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
    const tool = this.tools.get(toolName) ?? this.tools.get(`patterm.${toolName}`);
    if (!tool) return [];
    return tool.descriptor.changes ?? (READ_ONLY_TOOL_NAMES.has(tool.descriptor.name) ? [] : DEFAULT_CHANGE_TOPICS);
  }

  private publicTool(name: string): RegisteredTool {
    const tool = this.tools.get(name) ?? this.tools.get(`patterm.${name}`);
    if (!tool || tool.descriptor.hidden || publicName(tool.descriptor.name) !== name) {
      throw new Error(`unknown MCP tool ${name}`);
    }
    return tool;
  }
}

function publicName(name: string): string {
  return name.startsWith('patterm.') ? name.slice('patterm.'.length) : name;
}
