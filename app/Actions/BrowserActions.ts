import { z } from 'zod';
import type { McpCallContext, McpToolRegistry } from '../MCP/ToolRegistry';
import type { BrowserService } from '../Services/Browser/BrowserService';
import type { DatabaseService } from '../Services/DatabaseService';

// What the UI reads, and the calls that act in an agent's browser. Acting
// ones change what every viewer sees, so a browser client sends them over
// its socket as the agent's controller.
export const BROWSER_VIEW_TOOLS = ['browser_state', 'browser_frame'] as const;
export const BROWSER_CONTROL_TOOLS = ['browser_input', 'browser_navigate', 'browser_select_tab', 'browser_help_done'] as const;

const id = z.string().min(1).max(200);
const processInput = z.object({ process_id: id }).strict();
const helpInput = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const frameInput = z.object({ process_id: id, after: z.number().int().nonnegative().default(0), wait_ms: z.number().int().min(0).max(25_000).default(20_000) }).strict();
const coordinate = z.number().finite().min(-10_000).max(100_000);
const modifiers = z.number().int().min(0).max(15).optional();
const inputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('mouse'),
    type: z.enum(['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel']),
    x: coordinate, y: coordinate,
    button: z.enum(['none', 'left', 'middle', 'right']).optional(),
    clickCount: z.number().int().min(0).max(3).optional(),
    deltaX: z.number().finite().min(-10_000).max(10_000).optional(),
    deltaY: z.number().finite().min(-10_000).max(10_000).optional(),
    modifiers
  }).strict(),
  z.object({
    kind: z.literal('key'),
    type: z.enum(['keyDown', 'keyUp', 'rawKeyDown', 'char']),
    key: z.string().max(32).optional(),
    code: z.string().max(32).optional(),
    text: z.string().max(8).optional(),
    windowsVirtualKeyCode: z.number().int().min(0).max(255).optional(),
    modifiers
  }).strict(),
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(10_000) }).strict()
]);
const controlInput = z.object({ process_id: id, input: inputSchema }).strict();
const navigateInput = z.object({
  process_id: id,
  url: z.string().max(4096).refine((value) => /^https?:\/\//i.test(value) && URL.canParse(value), 'Only http and https pages open in the browser')
}).strict();
const selectTabInput = z.object({ process_id: id, target_id: z.string().min(1).max(200) }).strict();
const doneInput = z.object({ process_id: id, note: z.string().trim().max(1000).optional() }).strict();

export const BROWSER_INSTRUCTIONS = [
  'browser_open starts your own Chrome, which Patterm runs for this session, and returns its CDP URL. Drive it with code over CDP.',
  'Prefer patchright-core, a Playwright fork that avoids the CDP traces stock Playwright leaves: import { chromium } from the `patchright` path browser_open returns, then `const browser = await chromium.connectOverCDP(cdp_url)` and use `browser.contexts()[0]`. Raw CDP and other clients work too.',
  'The browser keeps its tabs, cookies and sign-ins between your scripts, so each script can connect, act, and exit. Leave the browser running; Patterm stops it when your session ends.',
  'Call browser_request_help when a page needs a person, such as a CAPTCHA, a sign-in, or two-factor approval. The user sees your browser beside your conversation and takes over; you get a message when they finish. Don\'t try to solve CAPTCHAs yourself.'
];

export class BrowserActions {
  constructor(private readonly browsers: BrowserService, private readonly database: DatabaseService) {}

  open(context: McpCallContext) {
    const agent = this.agent(context);
    return this.browsers.open(agent.sessionId, agent.processId);
  }

  async requestHelp(raw: unknown, context: McpCallContext) {
    const agent = this.agent(context);
    await this.browsers.requestHelp(agent.sessionId, agent.processId, helpInput.parse(raw).reason);
    return { ok: true, message: 'The user has been asked to help in your browser. You will get a message when they finish; carry on with other work meanwhile, or stop and wait.' };
  }

  state(raw: unknown) {
    return this.browsers.state(this.session(processInput.parse(raw).process_id).sessionId);
  }

  frame(raw: unknown) {
    const input = frameInput.parse(raw);
    return this.browsers.frame(this.session(input.process_id).sessionId, input.after, input.wait_ms);
  }

  async input(raw: unknown) {
    const input = controlInput.parse(raw);
    await this.browsers.input(this.session(input.process_id).sessionId, input.input);
    return { ok: true };
  }

  async navigate(raw: unknown) {
    const input = navigateInput.parse(raw);
    const session = this.session(input.process_id);
    return { ok: true, ...await this.browsers.navigate(session.sessionId, session.processId, input.url) };
  }

  async selectTab(raw: unknown) {
    const input = selectTabInput.parse(raw);
    await this.browsers.selectTab(this.session(input.process_id).sessionId, input.target_id);
    return { ok: true };
  }

  async helpDone(raw: unknown) {
    const input = doneInput.parse(raw);
    await this.browsers.finishHelp(this.session(input.process_id).sessionId, input.note);
    return { ok: true };
  }

  private agent(context: McpCallContext): { sessionId: string; processId: string } {
    if (context.remote) throw new Error('Browsers belong to agents on their own host');
    const row = context.identity
      ? this.database.connection.prepare('select id, process_id from sessions where mcp_identity = ? and exited_at is null').get(context.identity) as { id: string; process_id: string | null } | undefined
      : undefined;
    if (!row?.process_id) throw new Error('Only a running agent has a browser');
    return { sessionId: row.id, processId: row.process_id };
  }

  private session(processId: string): { sessionId: string; processId: string } {
    const row = this.database.connection.prepare('select id from sessions where process_id = ? and exited_at is null order by started_at desc limit 1').get(processId) as { id: string } | undefined;
    if (!row) throw new Error('That agent is not running');
    return { sessionId: row.id, processId };
  }
}

export function registerBrowserTools(registry: McpToolRegistry, actions: BrowserActions): void {
  registry.register(
    {
      name: 'browser_open', namespace: 'browser', changes: ['browser'],
      description: 'Start your own Chrome, or find it if it is running, and return its CDP URL to drive it with code.',
      usageNotes: BROWSER_INSTRUCTIONS,
      inputSchema: { type: 'object', additionalProperties: false, properties: {} }
    },
    (_args, context) => actions.open(context)
  );
  registry.register(
    {
      name: 'browser_request_help', namespace: 'browser', changes: ['browser'],
      description: 'Ask the user to take over your browser, such as for a CAPTCHA or a sign-in. Returns at once; a message arrives when they finish.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: { type: 'string', minLength: 1, maxLength: 500, description: 'What the user should do, such as "Solve the CAPTCHA on the sign-in page".' } } }
    },
    (args, context) => actions.requestHelp(args, context)
  );
  const ui = (name: typeof BROWSER_VIEW_TOOLS[number] | typeof BROWSER_CONTROL_TOOLS[number], description: string, handler: (args: unknown) => unknown, required: string[]) => registry.register(
    { name, namespace: 'browser', description, hidden: true, changes: name === 'browser_frame' || name === 'browser_state' || name === 'browser_input' ? [] : ['browser'], inputSchema: { type: 'object', required } },
    handler
  );
  ui('browser_state', 'Read whether an agent\'s browser runs, its tabs, and any request for help.', (args) => actions.state(args), ['process_id']);
  ui('browser_frame', 'Wait for the next screencast frame of an agent\'s browser.', (args) => actions.frame(args), ['process_id']);
  ui('browser_input', 'Send the user\'s mouse, key, or text input to an agent\'s browser.', (args) => actions.input(args), ['process_id', 'input']);
  ui('browser_navigate', 'Open a page in an agent\'s browser.', (args) => actions.navigate(args), ['process_id', 'url']);
  ui('browser_select_tab', 'Watch another tab of an agent\'s browser.', (args) => actions.selectTab(args), ['process_id', 'target_id']);
  ui('browser_help_done', 'Tell the agent the user finished in its browser.', (args) => actions.helpDone(args), ['process_id']);
}
