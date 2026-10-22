import path from 'node:path';
import { z } from 'zod';
import type { McpCallContext, McpToolRegistry } from './ToolRegistry';
import type { SandboxRow, SandboxService } from '../Services/Sandbox/SandboxService';
import { SandboxExecTimeout } from '../Services/Sandbox/SandboxBackend';
import { shellQuote } from '../Services/Sandbox/SpritesBackend';

export const SANDBOX_AGENT_TOOLS = ['sandbox_bash', 'sandbox_read', 'sandbox_write', 'sandbox_edit', 'sandbox_grep', 'sandbox_glob', 'sandbox_push'] as const;
export const SANDBOX_SETTINGS_TOOLS = ['settings_sandboxes_get', 'settings_sandboxes_update', 'settings_sandboxes_sync', 'settings_sandboxes_delete'] as const;

const MAX_OUTPUT_CHARS = 30_000;
const MAX_LINE_CHARS = 2_000;
const DEFAULT_READ_LINES = 2_000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const bashInput = z.object({
  command: z.string().min(1),
  description: z.string().optional(),
  timeout: z.number().int().min(1_000).max(600_000).optional(),
  run_in_background: z.boolean().optional()
}).strict();
const readInput = z.object({ file_path: z.string().min(1), offset: z.number().int().min(1).optional(), limit: z.number().int().min(1).optional() }).strict();
const writeInput = z.object({ file_path: z.string().min(1), content: z.string() }).strict();
const editInput = z.object({ file_path: z.string().min(1), old_string: z.string().min(1), new_string: z.string(), replace_all: z.boolean().optional() }).strict();
const grepInput = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  glob: z.string().optional(),
  case_insensitive: z.boolean().optional(),
  output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
  head_limit: z.number().int().min(1).optional()
}).strict();
const globInput = z.object({ pattern: z.string().min(1), path: z.string().optional() }).strict();
const pushInput = z.object({ force_with_lease: z.boolean().optional() }).strict();
const updateInput = z.object({ token: z.string().max(4096).nullable().optional() }).strict();
const syncInput = z.object({ sandbox_id: z.string().min(1) }).strict();
const deleteInput = z.object({ sandbox_id: z.string().min(1), discard: z.boolean().optional() }).strict();

const NOTE = 'This agent\'s project lives in a remote sandbox at the same absolute path; files on this machine are a stale copy.';

// File and shell tools for agents whose worktree lives in a sandbox. Only
// those agents see them; their harness's own file and shell tools are off.
export function registerSandboxTools(registry: McpToolRegistry, sandboxes: SandboxService, options: {
  cwdFor: (context: McpCallContext) => string | null;
  launchingSandbox?: (identity: string) => string | null;
}): void {
  const sandboxFor = (context: McpCallContext): SandboxRow | null => {
    if (context.remote || !context.identity) return null;
    const launching = options.launchingSandbox?.(context.identity);
    return launching ? sandboxes.get(launching) : sandboxes.forIdentity(context.identity);
  };
  // OpenCode's shared bridge lists tools without an identity; its sessions
  // outside a sandbox deny these tools by permission instead.
  const unavailable = (context: McpCallContext) => !context.identity && !context.remote ? null
    : sandboxFor(context)?.status === 'ready' ? null : 'Only agents running in a sandbox have sandbox tools.';
  const resolve = (context: McpCallContext, row: SandboxRow, target: string | undefined) => {
    const base = options.cwdFor(context) ?? row.path;
    return !target ? base : path.posix.isAbsolute(target) ? path.posix.normalize(target) : path.posix.join(base, target);
  };
  const tool = <T>(name: typeof SANDBOX_AGENT_TOOLS[number], description: string, schema: z.ZodType<T>, inputSchema: Record<string, unknown>, handler: (input: T, row: SandboxRow, context: McpCallContext) => Promise<unknown>) => {
    registry.register({ name, namespace: 'sandbox', description: `${description} ${NOTE}`, inputSchema, changes: [], unavailable }, async (args, context) => {
      const row = sandboxFor(context);
      if (!row || row.status !== 'ready') throw new Error('This agent is not running in a sandbox');
      return handler(schema.parse(args), row, context);
    });
  };

  tool('sandbox_bash', 'Run a bash command in the sandbox, in the agent\'s working directory. Use it for git, tests, builds, package managers and other commands.', bashInput, {
    type: 'object', required: ['command'],
    properties: {
      command: { type: 'string' },
      description: { type: 'string', description: 'A few words on what the command does.' },
      timeout: { type: 'number', description: 'Milliseconds, up to 600000. Default 120000.' },
      run_in_background: { type: 'boolean', description: 'Start the command and return at once; its output goes to a log file in the sandbox.' }
    }
  }, async (input, row, context) => {
    const cwd = resolve(context, row, undefined);
    if (input.run_in_background) {
      const log = `/tmp/patterm-bg-${Date.now().toString(36)}.log`;
      const result = await sandboxes.exec(row, ['bash', '-c', `nohup bash -lc ${shellQuote(input.command)} > ${log} 2>&1 < /dev/null & echo $!`], { cwd, timeoutMs: 30_000 });
      return { background: true, pid: Number(result.stdout.toString('utf8').trim()) || null, log };
    }
    const timeout = input.timeout ?? 120_000;
    try {
      const result = await sandboxes.exec(row, ['bash', '-lc', input.command], { cwd, timeoutMs: timeout });
      return { exit_code: result.exitCode, stdout: clip(result.stdout.toString('utf8')), stderr: clip(withoutShellNoise(result.stderr.toString('utf8'))) };
    } catch (error) {
      if (error instanceof SandboxExecTimeout) return { exit_code: null, error: `Command timed out after ${Math.round(timeout / 1000)}s and was stopped` };
      throw error;
    }
  });

  tool('sandbox_read', 'Read a file from the sandbox with line numbers. Paths are absolute or relative to the working directory.', readInput, {
    type: 'object', required: ['file_path'],
    properties: { file_path: { type: 'string' }, offset: { type: 'number', description: 'First line, from 1.' }, limit: { type: 'number', description: 'Number of lines. Default 2000.' } }
  }, async (input, row, context) => {
    const file = resolve(context, row, input.file_path);
    const content = await readText(sandboxes, row, file);
    const lines = content.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const start = (input.offset ?? 1) - 1;
    const shown = lines.slice(start, start + (input.limit ?? DEFAULT_READ_LINES));
    const text = shown.map((line, index) => `${String(start + index + 1).padStart(6)}\t${line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line}`).join('\n');
    const more = start + shown.length < lines.length ? `\n… ${lines.length - start - shown.length} more lines; read on with offset ${start + shown.length + 1}` : '';
    return { file_path: file, content: text || '(empty file)', more: more || undefined };
  });

  tool('sandbox_write', 'Create or overwrite a file in the sandbox.', writeInput, {
    type: 'object', required: ['file_path', 'content'],
    properties: { file_path: { type: 'string' }, content: { type: 'string' } }
  }, async (input, row, context) => {
    const file = resolve(context, row, input.file_path);
    const before = await readText(sandboxes, row, file).catch(() => '');
    await writeText(sandboxes, row, file, input.content);
    return { file_path: file, diff: unifiedDiff(relativeTo(row.path, file), before, input.content) };
  });

  tool('sandbox_edit', 'Replace an exact string in a sandbox file. old_string must occur once unless replace_all is true; read the file first.', editInput, {
    type: 'object', required: ['file_path', 'old_string', 'new_string'],
    properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }
  }, async (input, row, context) => {
    const file = resolve(context, row, input.file_path);
    const before = await readText(sandboxes, row, file);
    const count = before.split(input.old_string).length - 1;
    if (count === 0) throw new Error('old_string was not found in the file');
    if (count > 1 && !input.replace_all) throw new Error(`old_string occurs ${count} times; add surrounding context or set replace_all`);
    const after = input.replace_all ? before.split(input.old_string).join(input.new_string) : before.replace(input.old_string, () => input.new_string);
    await writeText(sandboxes, row, file, after);
    return { file_path: file, replacements: input.replace_all ? count : 1, diff: unifiedDiff(relativeTo(row.path, file), before, after) };
  });

  tool('sandbox_grep', 'Search file contents in the sandbox with ripgrep regular expressions.', grepInput, {
    type: 'object', required: ['pattern'],
    properties: {
      pattern: { type: 'string' }, path: { type: 'string', description: 'File or directory; defaults to the working directory.' },
      glob: { type: 'string', description: 'Only files matching this glob, such as "*.ts".' }, case_insensitive: { type: 'boolean' },
      output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'Default files_with_matches.' },
      head_limit: { type: 'number', description: 'Return at most this many lines.' }
    }
  }, async (input, row, context) => {
    const mode = input.output_mode ?? 'files_with_matches';
    const args = ['rg', '--color=never', ...(mode === 'content' ? ['-n'] : mode === 'count' ? ['-c'] : ['-l']), ...(input.case_insensitive ? ['-i'] : []), ...(input.glob ? ['-g', input.glob] : []), '-e', input.pattern, '--', resolve(context, row, input.path)];
    const result = await sandboxes.exec(row, args, { timeoutMs: 120_000 });
    if (result.exitCode === 1) return { matches: 'No matches' };
    if (result.exitCode !== 0) throw new Error(result.stderr.toString('utf8').trim() || `ripgrep exited with ${result.exitCode}`);
    return { matches: limitLines(result.stdout.toString('utf8'), input.head_limit) };
  });

  tool('sandbox_glob', 'List sandbox files matching a glob pattern, such as "src/**/*.ts", respecting .gitignore.', globInput, {
    type: 'object', required: ['pattern'],
    properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Directory to search; defaults to the working directory.' } }
  }, async (input, row, context) => {
    const result = await sandboxes.exec(row, ['rg', '--files', '--color=never', '-g', input.pattern, '--', resolve(context, row, input.path)], { timeoutMs: 120_000 });
    if (result.exitCode === 1) return { files: 'No files found' };
    if (result.exitCode !== 0) throw new Error(result.stderr.toString('utf8').trim() || `ripgrep exited with ${result.exitCode}`);
    return { files: limitLines(result.stdout.toString('utf8'), 1_000) };
  });

  tool('sandbox_push', 'Push the sandbox\'s current branch to origin. Patterm first brings the sandbox\'s commits and files into the local worktree, then pushes from this machine with the owner\'s git credentials, which the sandbox does not have. Commit first; uncommitted changes are not pushed. Open pull requests with your git provider\'s tools afterwards.', pushInput, {
    type: 'object',
    properties: { force_with_lease: { type: 'boolean', description: 'Push with --force-with-lease, after rewriting the branch\'s history.' } }
  }, (input, row) => sandboxes.push(row, { forceWithLease: input.force_with_lease === true }));

  // Owner settings: hidden from agents, never echoing the token.
  registry.register(
    { name: 'settings_sandboxes_get', namespace: 'settings', description: 'Read sandbox settings and the sandboxes that exist.', hidden: true, changes: [], inputSchema: { type: 'object' } },
    () => sandboxes.state()
  );
  registry.register(
    { name: 'settings_sandboxes_update', namespace: 'settings', description: 'Save or remove the sandbox provider token.', hidden: true, changes: ['settings'], inputSchema: { type: 'object' } },
    (args) => sandboxes.saveSettings(updateInput.parse(args))
  );
  registry.register(
    { name: 'settings_sandboxes_sync', namespace: 'settings', description: 'Bring a sandbox\'s branch, commits and files into its local worktree.', hidden: true, changes: ['settings', 'workbench'], inputSchema: { type: 'object', required: ['sandbox_id'] } },
    async (args) => { await sandboxes.sync(syncInput.parse(args).sandbox_id); return sandboxes.state(); }
  );
  registry.register(
    { name: 'settings_sandboxes_delete', namespace: 'settings', description: 'Bring a sandbox\'s work back, then delete the sandbox. With discard, delete it without bringing anything back.', hidden: true, changes: ['settings', 'workbench'], inputSchema: { type: 'object', required: ['sandbox_id'] } },
    async (args) => {
      const input = deleteInput.parse(args);
      await sandboxes.delete(input.sandbox_id, { discard: input.discard === true });
      return sandboxes.state();
    }
  );
}

async function readText(sandboxes: SandboxService, row: SandboxRow, file: string): Promise<string> {
  const result = await sandboxes.exec(row, ['sh', '-c', 'test -f "$1" || { echo "$1 is not a file" >&2; exit 2; }; head -c "$2" -- "$1"', 'sh', file, String(MAX_FILE_BYTES + 1)], { timeoutMs: 60_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString('utf8').trim() || `could not read ${file}`);
  if (result.stdout.length > MAX_FILE_BYTES) throw new Error(`${file} is larger than 10 MiB; read parts of it with sandbox_bash`);
  if (result.stdout.subarray(0, 8000).includes(0)) throw new Error(`${file} is a binary file`);
  return result.stdout.toString('utf8');
}

async function writeText(sandboxes: SandboxService, row: SandboxRow, file: string, content: string): Promise<void> {
  const result = await sandboxes.exec(row, ['sh', '-c', 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', 'sh', file], { stdin: content, timeoutMs: 60_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString('utf8').trim() || `could not write ${file}`);
}

// One hunk spanning the changed lines, with three lines of context: enough
// for the transcript to show the edit without a diff library.
export function unifiedDiff(name: string, before: string, after: string): string {
  if (before === after) return '';
  const a = textLines(before);
  const b = textLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
  const from = Math.max(0, start - 3);
  const toA = Math.min(a.length - 1, endA + 3);
  const toB = Math.min(b.length - 1, endB + 3);
  const lines = [
    ...a.slice(from, start).map((line) => ` ${line}`),
    ...a.slice(start, endA + 1).map((line) => `-${line}`),
    ...b.slice(start, endB + 1).map((line) => `+${line}`),
    ...a.slice(endA + 1, toA + 1).map((line) => ` ${line}`)
  ];
  // An empty range names the line before it, as git does.
  const range = (first: number, last: number) => last < first ? `${first},0` : `${first + 1},${last - first + 1}`;
  return [
    `diff --git a/${name} b/${name}`,
    before ? `--- a/${name}` : '--- /dev/null',
    after ? `+++ b/${name}` : '+++ /dev/null',
    `@@ -${range(from, toA)} +${range(from, toB)} @@`,
    ...lines,
    ''
  ].join('\n');
}

function textLines(text: string): string[] {
  if (!text) return [];
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

function relativeTo(root: string, file: string): string {
  const relative = path.posix.relative(root, file);
  return relative && !relative.startsWith('..') ? relative : file.replace(/^\/+/, '');
}

function clip(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS / 2)}\n… output truncated …\n${text.slice(-MAX_OUTPUT_CHARS / 2)}` : text;
}

function limitLines(text: string, limit: number | undefined): string {
  const lines = text.trimEnd().split('\n');
  const max = limit ?? 500;
  return clip(lines.length > max ? `${lines.slice(0, max).join('\n')}\n… ${lines.length - max} more` : lines.join('\n'));
}

// A login shell without a terminal warns about line editing on every call.
function withoutShellNoise(text: string): string {
  return text.split('\n').filter((line) => !/: bind: warning: line editing not enabled$/.test(line)).join('\n');
}
