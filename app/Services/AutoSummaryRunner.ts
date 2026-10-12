import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseService } from './DatabaseService';
import { SUMMARY_SYSTEM_PROMPT, SUMMARY_TEST_SYSTEM_PROMPT, summaryResult, type AutoSummarySettings, type SummaryContext, type SummaryResult, SUMMARY_INPUT_BYTES } from './AutoSummarySettings';

const REQUIRED_FLAGS = ['--print', '--tools', '--strict-mcp-config', '--mcp-config', '--disable-slash-commands', '--no-session-persistence', '--setting-sources', '--settings', '--system-prompt', '--output-format', '--no-chrome'];

export function summaryEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  // Preserve native login locations; exclude API keys, Patterm identities, and provider overrides.
  for (const name of ['HOME', 'PATH', 'SHELL', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    if (env[name] !== undefined) result[name] = env[name];
  }
  result.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  return result;
}

export function codexSummaryCatalog(raw: string, model: string): string {
  const catalog = JSON.parse(raw) as { models?: Array<Record<string, unknown>> };
  const selected = catalog.models?.find((entry) => entry.slug === model);
  if (!selected) throw new Error('Summary model is not in this Codex build. Update Codex or choose an available model.');
  // Keep the native model metadata, but remove every model-selected tool source.
  return JSON.stringify({ models: [{ ...selected, shell_type: 'disabled', apply_patch_tool_type: null,
    tool_mode: 'direct', multi_agent_version: 'disabled', experimental_supported_tools: [], supports_search_tool: false,
    include_skills_usage_instructions: false, include_plugin_usage_instructions: false, include_apps_usage_instructions: false }] });
}

export function codexSummaryArgs(model: string, directory: string, reasoning: string | null = null): string[] {
  const config: Record<string, unknown> = {
    model_provider: 'openai', forced_login_method: 'chatgpt', cli_auth_credentials_store: 'file', approval_policy: 'never',
    model_catalog_json: path.join(directory, 'models.json'), model_instructions_file: path.join(directory, 'instructions.txt'),
    project_doc_max_bytes: 0, 'skills.include_instructions': false, developer_instructions: '',
    web_search: 'disabled', 'tools.update_plan.enabled': false, 'tools.experimental_request_user_input.enabled': false,
    'history.persistence': 'none', log_dir: directory, sqlite_home: directory,
  };
  for (const feature of ['shell_tool', 'view_image', 'apps', 'plugins', 'hooks', 'memories', 'multi_agent', 'multi_agent_v2',
    'code_mode', 'code_mode_only', 'browser_use', 'computer_use', 'image_generation', 'goals', 'sleep_tool',
    'tool_suggest', 'skill_search', 'shell_snapshot', 'workspace_dependencies']) config[`features.${feature}`] = false;
  config['features.skip_host_skill_discovery'] = true;
  if (reasoning) config.model_reasoning_effort = reasoning;
  return ['exec', '--ignore-user-config', '--ignore-rules', '--strict-config', '--ephemeral', '--skip-git-repo-check',
    '--sandbox', 'read-only', '--model', model, '--json', '--color', 'never',
    ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]), '-'];
}

export async function codexSummaryEnvironment(directory: string, env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const authFile = path.resolve(env.CODEX_HOME ?? path.join(env.HOME ?? os.homedir(), '.codex'), 'auth.json');
  try { await fs.access(authFile); }
  catch { throw new Error('Summary requires Codex file-based ChatGPT login. Run codex -c cli_auth_credentials_store="file" login.'); }
  const home = path.join(directory, 'codex');
  await fs.mkdir(home, { mode: 0o700 });
  // Codex's file auth store writes through this link, so native token refresh is retained.
  // Link only auth.json: global AGENTS.md and user configuration stay outside this home.
  await fs.symlink(authFile, path.join(home, 'auth.json'));
  return { ...env, CODEX_HOME: home };
}

export function codexSummaryOutput(output: string): string {
  const events = output.trim().split('\n').map((line) => JSON.parse(line)) as Array<{ type: string; item?: { type: string; text?: string } }>;
  if (!events.some((event) => event.type === 'turn.completed') || events.some((event) => ['error', 'turn.failed'].includes(event.type))) {
    throw new Error('Summary failed. Check Codex login, model access, and usage limits.');
  }
  const messages = events.filter((event) => event.type === 'item.completed' && event.item?.type === 'agent_message');
  const text = messages.at(-1)?.item?.text;
  if (typeof text !== 'string') throw new Error('Summariser returned no final message.');
  return text;
}

// Takes the JSON input document, as the other providers read it from stdin.
export function openCodeSummaryArgs(model: string, input: string, mode: 'summary' | 'test'): string[] {
  const id = model.startsWith('openai/') ? model.slice('openai/'.length) : model;
  if (!id || /[/#]/.test(id)) throw new Error('Summary requires an OpenCode OpenAI model ID, for example gpt-5.6-luna.');
  // The native stateless endpoint has no tools, session history, or project instructions.
  return ['api', 'POST', '/api/generate', '--data', JSON.stringify({ model: { providerID: 'openai', id },
    prompt: `${mode === 'test' ? SUMMARY_TEST_SYSTEM_PROMPT : SUMMARY_SYSTEM_PROMPT}\n\n${input}` })];
}

export function claudeSummaryArgs(model: string, mode: 'summary' | 'test' = 'summary', reasoning: string | null = null): string[] {
  return ['--print', '--model', model, ...(reasoning ? ['--effort', reasoning] : []), '--output-format', 'json', '--no-session-persistence',
    '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--disable-slash-commands', '--setting-sources', '', '--settings', '{"disableAllHooks":true,"claudeMdExcludes":["**"],"autoMemoryEnabled":false}',
    '--no-chrome', '--system-prompt', mode === 'test' ? SUMMARY_TEST_SYSTEM_PROMPT : SUMMARY_SYSTEM_PROMPT];
}

export class AutoSummaryRunner {
  constructor(private readonly database: DatabaseService, private readonly env: NodeJS.ProcessEnv) {}

  availability(provider: AutoSummarySettings['provider']): { available: boolean; reason: string | null } {
    const names = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };
    return this.executable(provider) ? { available: true, reason: null }
      : { available: false, reason: `${names[provider]} was not discovered. Install it and sign in with its native CLI.` };
  }

  async run(settings: AutoSummarySettings, text: string, signal: AbortSignal, mode: 'summary' | 'test' = 'summary', context: SummaryContext = {}): Promise<SummaryResult> {
    const input = JSON.stringify({ ...context, ...(context.memory ? { conversation_text: text } : { terminal_output: text }) });
    if (Buffer.byteLength(input) + Buffer.byteLength(mode === 'test' ? SUMMARY_TEST_SYSTEM_PROMPT : SUMMARY_SYSTEM_PROMPT) > SUMMARY_INPUT_BYTES) throw new Error('Summary input exceeded the limit.');
    signal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const available = this.availability(settings.provider);
    if (!available.available) throw new Error(available.reason!);
    const executable = this.executable(settings.provider)!;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'patterm-summary-'));
    try {
      const env = summaryEnvironment(this.env);
      let result: string;
      if (settings.provider === 'codex') {
        const codexEnv = await codexSummaryEnvironment(directory, env);
        const help = await runSummaryCommand(executable, ['exec', '--help'], '', directory, codexEnv, signal, 64 * 1024);
        if (!['--ignore-user-config', '--ignore-rules', '--strict-config', '--ephemeral'].every((flag) => help.includes(flag))) {
          throw new Error('Summary requires a newer Codex CLI with isolated ephemeral execution. Update Codex.');
        }
        const catalog = (args: string[]) => runSummaryCommand(executable, args, '', directory, codexEnv, signal, 2 * 1024 * 1024);
        let models: string;
        // The bundled catalogue needs no network. Settings list the refreshed
        // catalogue, so a newer model is looked up there, inside this private home.
        try { models = codexSummaryCatalog(await catalog(['debug', 'models', '--bundled']), settings.models.codex); }
        catch { models = codexSummaryCatalog(await catalog(['debug', 'models']), settings.models.codex); }
        await fs.writeFile(path.join(directory, 'models.json'), models, { mode: 0o600 });
        await fs.writeFile(path.join(directory, 'instructions.txt'), mode === 'test' ? SUMMARY_TEST_SYSTEM_PROMPT : SUMMARY_SYSTEM_PROMPT, { mode: 0o600 });
        const output = await runSummaryCommand(executable, codexSummaryArgs(settings.models.codex, directory, settings.reasoning.codex), input, directory, codexEnv, signal);
        try { result = codexSummaryOutput(output); }
        catch { throw new Error('Summary failed. Check Codex login, model access, and output format.'); }
      } else if (settings.provider === 'opencode') {
        const output = await runSummaryCommand(executable, openCodeSummaryArgs(settings.models.opencode, input, mode), '', directory, env, signal);
        try {
          const envelope = JSON.parse(output) as { data?: { text?: string } };
          if (typeof envelope.data?.text !== 'string') throw new Error();
          result = envelope.data.text;
        } catch { throw new Error('Summary failed. Update OpenCode and check its OpenAI login and model access.'); }
      } else {
        const help = await runSummaryCommand(executable, ['--help'], '', directory, env, signal, 64 * 1024);
        if (!REQUIRED_FLAGS.every((flag) => help.includes(flag))) throw new Error('This Claude CLI lacks required summary isolation flags. Update Claude Code.');
        if (settings.reasoning.claude && !help.includes('--effort')) throw new Error('Summary reasoning requires a newer Claude Code. Update it or use the model default.');
        const output = await runSummaryCommand(executable, claudeSummaryArgs(settings.models.claude, mode, settings.reasoning.claude),
          input, directory, env, signal);
        let envelope: { type?: string; subtype?: string; is_error?: boolean; result?: string };
        try { envelope = JSON.parse(output); }
        catch { throw new Error('Summariser returned invalid JSON.'); }
        if (envelope.type !== 'result' || envelope.subtype !== 'success' || envelope.is_error || typeof envelope.result !== 'string') {
          throw new Error('Summary failed. Check Claude login, model access, and subscription usage; no API fallback was used.');
        }
        result = envelope.result;
      }
      try {
        const parsed = summaryResult.parse(JSON.parse(result));
        if (context.memory && !parsed.memory) throw new Error();
        return parsed;
      }
      catch { throw new Error('Summariser did not return a short summary in the required format.'); }
    } finally {
      // Only this invocation's freshly created, private directory is removed.
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  private executable(provider: AutoSummarySettings['provider']): string | null {
    const row = this.database.connection.prepare("select executable_path from harness_installations where harness = ? and status = 'available' order by last_checked_at desc limit 1").get(provider) as { executable_path: string } | undefined;
    return row?.executable_path ?? null;
  }
}

export function runSummaryCommand(executable: string, args: string[], input: string, cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal, limit = 16 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Summary cancelled.')); return; }
    const child = spawn(executable, args, { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: Error | null = null;
    const stop = (message: string) => {
      failure ??= new Error(message);
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* The owned process may already have exited. */ }
    };
    const abort = () => stop('Summary cancelled.');
    const timer = setTimeout(() => stop('Summary timed out.'), 30_000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on('data', (data: Buffer) => {
      size += data.length;
      if (size > limit) stop('Summary output exceeded the limit.');
      else chunks.push(data);
    });
    // Drain without retaining provider diagnostics, which can include credentials or input.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.on('error', () => { failure = new Error('Could not start the summariser CLI.'); });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error('Summariser exited unsuccessfully. Check login, model access, and usage limits.'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.end(input);
  });
}
