import { z } from 'zod';
import type { McpCallContext, McpToolRegistry } from '../MCP/ToolRegistry';
import path from 'node:path';
import type { BrowserService } from '../Services/Browser/BrowserService';
import { DEFAULT_RUN_SECONDS, MAX_RUN_SECONDS, type SecretRunner } from '../Services/Secrets/SecretRunner';
import { hostAllowed, SECRET_NAME, SECRET_USES, type SecretService } from '../Services/Secrets/SecretService';

// What the UI reads, and the calls that answer an agent. Answering messages
// the agent, so a browser client sends those over its socket as its controller.
export const SECRET_VIEW_TOOLS = ['secret_session_list'] as const;
export const SECRET_CONTROL_TOOLS = ['secret_save', 'secret_remove'] as const;

const id = z.string().min(1).max(200);
const name = z.string().regex(SECRET_NAME, 'Use lower-case letters, digits and underscores, starting with a letter');
const kind = z.enum(['api_key', 'login']);
const host = z.string().trim().min(1).max(253);
const uses = z.array(z.enum(SECRET_USES as [string, ...string[]])).max(3) as z.ZodType<Array<'env' | 'proxy' | 'browser'>>;
const injection = z.object({
  in: z.enum(['header', 'query']),
  name: z.string().trim().regex(/^[A-Za-z0-9_-]{1,100}$/, 'Not a header or parameter name'),
  prefix: z.string().max(100).default('')
}).strict();

const requestInput = z.object({
  name,
  kind: kind.default('api_key'),
  purpose: z.string().trim().min(1).max(500),
  hosts: z.array(host).max(20).default([]),
  uses: uses.optional(),
  injection: injection.optional()
}).strict();
const fillInput = z.object({
  secret: name,
  field: z.enum(['value', 'username', 'password']).optional(),
  selector: z.string().min(1).max(1000),
  target_id: z.string().min(1).max(200).optional()
}).strict();
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, 'Not an environment variable name');
const ref = z.string().min(1).max(400);
const runInput = z.object({
  command: z.string().min(1).max(20_000),
  env: z.record(envName, ref).default({}),
  urls: z.record(envName, ref).default({}),
  cwd: z.string().min(1).max(4096).optional(),
  timeout_seconds: z.number().int().min(1).max(MAX_RUN_SECONDS).default(DEFAULT_RUN_SECONDS)
}).strict();
const writeInput = z.object({
  path: z.string().min(1).max(4096),
  env: z.record(envName, ref)
}).strict();
const processInput = z.object({ process_id: id }).strict();
const values = z.union([
  z.object({ value: z.string().min(1).max(64 * 1024) }).strict(),
  z.object({ username: z.string().max(1000), password: z.string().min(1).max(64 * 1024) }).strict()
]);
const saveInput = z.object({
  process_id: id,
  secret_id: id.nullable().default(null),
  name,
  kind,
  values: values.nullable().default(null),
  allowed_hosts: z.array(host).max(20).default([]),
  uses,
  injection: injection.nullable().default(null)
}).strict();
const removeInput = z.object({ process_id: id, secret_id: id, note: z.string().trim().max(500).optional() }).strict();

export const SECRET_INSTRUCTIONS = [
  'When a task needs a password, API key or token, call secret_request. Never ask the user to paste one into the conversation, and never print, echo, log or commit a secret value.',
  'The user enters it in Patterm and chooses how you may use it: through Patterm\'s egress proxy for API requests (secret_run with urls), as a value in a command\'s environment (secret_run with env, or secret_write for a .env file), or typed into your browser with browser_fill_secret. A message arrives when it is ready; secret_list shows each secret\'s usage.',
  'Prefer the proxy for API keys: the key never reaches your processes, and it works only for the hosts the user allowed.'
];

export class SecretActions {
  constructor(private readonly secrets: SecretService, private readonly browsers: BrowserService, private readonly runner: SecretRunner) {}

  request(raw: unknown, context: McpCallContext) {
    const input = requestInput.parse(raw);
    const session = this.secrets.liveSession(this.identity(context));
    const defaultUses: Array<'env' | 'proxy' | 'browser'> = input.kind === 'login' ? ['browser'] : input.hosts.length ? ['proxy'] : ['env'];
    const { secret, created } = this.secrets.request(session, {
      name: input.name, kind: input.kind, purpose: input.purpose, hosts: input.hosts,
      uses: input.uses?.length ? input.uses : defaultUses,
      injection: input.injection ?? null
    });
    if (secret.status === 'ready') return { ok: true, secret: this.view(secret), message: `"${secret.name}" is already available.` };
    return {
      ok: true,
      secret: this.view(secret),
      message: `${created ? 'Asked' : 'Reminded'} the user to enter "${secret.name}" in Patterm. You will get a message when it is ready; carry on with other work meanwhile, or stop and wait.`
    };
  }

  list(context: McpCallContext) {
    const session = this.secrets.liveSession(this.identity(context));
    return { secrets: this.secrets.list(session.id).map((secret) => this.view(secret)) };
  }

  async run(raw: unknown, context: McpCallContext) {
    const input = runInput.parse(raw);
    const session = this.secrets.liveSession(this.identity(context));
    const env = Object.entries(input.env).map(([name, ref]) => {
      const value = this.secrets.commandValue(session.id, ref);
      return { name, value, label: ref, mask: value };
    });
    const urls = Object.entries(input.urls).map(([name, ref]) => {
      const value = this.secrets.proxyUrl(session.id, ref);
      // The URL's token is the credential, so masking it hides any form of the URL.
      return { name, value, label: `${ref} url`, mask: new URL(value).pathname.split('/')[1]! };
    });
    if (!env.length && !urls.length) throw new Error('secret_run needs at least one secret in env or urls; run other commands in your own shell');
    return this.runner.run({ sessionId: session.id, command: input.command, cwd: this.place(session.cwd, input.cwd), env: [...env, ...urls], timeoutSeconds: input.timeout_seconds });
  }

  async write(raw: unknown, context: McpCallContext) {
    const input = writeInput.parse(raw);
    const session = this.secrets.liveSession(this.identity(context));
    const entries = Object.entries(input.env).map(([name, ref]) => ({ name, value: this.secrets.commandValue(session.id, ref) }));
    if (!entries.length) throw new Error('Name at least one secret to write');
    const file = this.place(session.cwd, input.path);
    const { excluded, warning } = await this.runner.write(file, entries);
    return { ok: true, path: file, written: entries.map((entry) => entry.name), excluded_by: excluded, ...(warning ? { warning } : {}) };
  }

  async fill(raw: unknown, context: McpCallContext) {
    const input = fillInput.parse(raw);
    const session = this.secrets.liveSession(this.identity(context));
    const { secret, value } = this.secrets.reveal(session.id, input.secret, 'browser', input.field);
    const filled = await this.browsers.fillSecret(session.id, {
      targetId: input.target_id, selector: input.selector, value,
      allowed: (pageHost) => hostAllowed(secret.allowed_hosts, pageHost)
    });
    return { ok: true, ...filled, message: `Filled ${input.field ?? (secret.kind === 'login' ? 'password' : 'value')} of "${secret.name}" into ${input.selector}.` };
  }

  sessionList(raw: unknown) {
    const session = this.secrets.sessionForProcess(processInput.parse(raw).process_id);
    return { secrets: this.secrets.list(session.id), keyring_protected: this.secrets.keyringProtected };
  }

  async save(raw: unknown) {
    const input = saveInput.parse(raw);
    const session = this.secrets.sessionForProcess(input.process_id);
    const secret = await this.secrets.save(session, input.secret_id, {
      name: input.name, kind: input.kind, values: input.values,
      allowed_hosts: input.allowed_hosts, uses: input.uses, injection: input.injection
    });
    return { ok: true, secret };
  }

  async remove(raw: unknown) {
    const input = removeInput.parse(raw);
    const session = this.secrets.sessionForProcess(input.process_id);
    if (this.secrets.get(input.secret_id).session_id !== session.id) throw new Error('That secret belongs to another session');
    await this.secrets.remove(input.secret_id, input.note);
    return { ok: true };
  }

  private view(secret: ReturnType<SecretService['get']>) {
    return {
      name: secret.name, kind: secret.kind, status: secret.status, purpose: secret.purpose,
      allowed_hosts: secret.allowed_hosts, uses: secret.uses, usage: this.secrets.usage(secret)
    };
  }

  // Relative paths start where the agent works.
  private place(cwd: string | null, target: string | undefined): string {
    if (target && path.isAbsolute(target)) return target;
    if (!cwd) throw new Error('Your session has no working folder; give an absolute path');
    return path.resolve(cwd, target ?? '.');
  }

  private identity(context: McpCallContext): string | null {
    if (context.remote) throw new Error('Secrets belong to agents on their own host');
    return context.identity ?? null;
  }
}

export function registerSecretTools(registry: McpToolRegistry, actions: SecretActions): void {
  registry.register(
    {
      name: 'secret_request', namespace: 'secrets', changes: ['secrets'],
      description: 'Ask the user for a password, API key or token. They enter it in Patterm, never in the conversation, and decide how you may use it. Returns at once; a message arrives when it is ready.',
      usageNotes: SECRET_INSTRUCTIONS,
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['name', 'purpose'],
        properties: {
          name: { type: 'string', pattern: SECRET_NAME.source, description: 'A short handle such as "stripe_test" or "github_login".' },
          kind: { type: 'string', enum: ['api_key', 'login'], default: 'api_key', description: '"login" holds a username and password; "api_key" one value.' },
          purpose: { type: 'string', minLength: 1, maxLength: 500, description: 'What you need it for, shown to the user.' },
          hosts: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'Hosts it is for, such as "api.stripe.com" or "*.example.com". Required for the proxy and the browser.' },
          uses: { type: 'array', items: { type: 'string', enum: [...SECRET_USES] }, description: 'How you want to use it: "proxy" (API requests through Patterm), "env" (values in secret_run and secret_write), "browser" (browser_fill_secret). The user decides.' },
          injection: {
            type: 'object', additionalProperties: false, required: ['in', 'name'],
            description: 'Where the proxy puts the credential. Defaults to the header "Authorization: Bearer <value>".',
            properties: { in: { type: 'string', enum: ['header', 'query'] }, name: { type: 'string' }, prefix: { type: 'string', default: '' } }
          }
        }
      }
    },
    (args, context) => actions.request(args, context)
  );
  registry.register(
    {
      name: 'secret_list', namespace: 'secrets',
      description: 'List your session\'s secrets: their status, allowed hosts, and how to use each. Never shows values.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} }
    },
    (_args, context) => actions.list(context)
  );
  const secretMap = (description: string) => ({ type: 'object', additionalProperties: { type: 'string' }, description });
  registry.register(
    {
      name: 'secret_run', namespace: 'secrets', changes: [],
      description: 'Run a shell command with your secrets in its environment and return its exit code and output, with secret values and proxy URLs masked. Patterm runs it outside your own shell and sandbox, without stdin; use it only for commands that need a secret.',
      usageNotes: [
        'env maps variable names to secrets, such as {"STRIPE_KEY": "stripe_test"}; a login\'s fields are "github_login.username" and "github_login.password". urls maps names to proxy addresses, such as {"STRIPE_URL": "stripe_test"} or "stripe_test@api.stripe.com", that stand in for https://<host>/ and add the key.',
        `It runs in your working folder unless cwd says otherwise, and stops after timeout_seconds (default ${DEFAULT_RUN_SECONDS}, at most ${MAX_RUN_SECONDS}); some harnesses stop waiting for a tool after about a minute. Output keeps the last 64 KB of each stream.`
      ],
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['command'],
        properties: {
          command: { type: 'string', description: 'The shell command, run with sh -c (cmd.exe on Windows).' },
          env: secretMap('Environment variables holding secret values, by secret name or name.field.'),
          urls: secretMap('Environment variables holding proxy URLs, by secret name or name@host.'),
          cwd: { type: 'string', description: 'Folder to run in, relative to your working folder.' },
          timeout_seconds: { type: 'integer', minimum: 1, maximum: MAX_RUN_SECONDS, default: DEFAULT_RUN_SECONDS }
        }
      }
    },
    (args, context) => actions.run(args, context)
  );
  registry.register(
    {
      name: 'secret_write', namespace: 'secrets', changes: [],
      description: 'Write secrets into a dotenv file as NAME=value lines, replacing ones already there. The file gets mode 0600 and is added to .git/info/exclude unless git already ignores it. Never returns the values.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['path', 'env'],
        properties: {
          path: { type: 'string', description: 'The file, such as ".env.local", relative to your working folder.' },
          env: secretMap('Variable names and the secrets they hold, by secret name or name.field.')
        }
      }
    },
    (args, context) => actions.write(args, context)
  );
  registry.register(
    {
      name: 'browser_fill_secret', namespace: 'browser',
      description: 'Type a secret into a field of a page in your browser, on a site the user allowed for it. Load the page and find the field first.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['secret', 'selector'],
        properties: {
          secret: { type: 'string', description: 'The secret\'s name.' },
          field: { type: 'string', enum: ['value', 'username', 'password'], description: 'For a login, "username" or "password" (the default).' },
          selector: { type: 'string', description: 'A CSS selector for the input, such as "#password".' },
          target_id: { type: 'string', description: 'The tab, if not the newest.' }
        }
      }
    },
    (args, context) => actions.fill(args, context)
  );
  const ui = (name: typeof SECRET_VIEW_TOOLS[number] | typeof SECRET_CONTROL_TOOLS[number], description: string, handler: (args: unknown) => unknown, required: string[]) => registry.register(
    { name, namespace: 'secrets', description, hidden: true, changes: name === 'secret_session_list' ? [] : ['secrets'], inputSchema: { type: 'object', required } },
    handler
  );
  ui('secret_session_list', 'List an agent session\'s secrets, without values.', (args) => actions.sessionList(args), ['process_id']);
  ui('secret_save', 'Enter, edit, or add a secret for an agent session.', (args) => actions.save(args), ['process_id', 'name', 'kind', 'uses']);
  ui('secret_remove', 'Decline a secret request, or forget a secret.', (args) => actions.remove(args), ['process_id', 'secret_id']);
}
