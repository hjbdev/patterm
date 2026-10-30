import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { killProcessTree } from '../../Platform/ProcessTree';

const execFileAsync = promisify(execFile);

// Output kept per stream, after masking. A command that prints more keeps
// its last part, where errors usually are.
const OUTPUT_LIMIT = 64 * 1024;
// Commands one session may run at once.
const RUNS_PER_SESSION = 4;
export const DEFAULT_RUN_SECONDS = 50;
export const MAX_RUN_SECONDS = 600;

export interface SecretRunInput {
  sessionId: string;
  command: string;
  cwd: string;
  // Environment variables and what they hold. Labels name them in masked
  // output, such as `stripe_test` or `stripe_test url`.
  env: Array<{ name: string; value: string; label: string; mask: string }>;
  timeoutSeconds: number;
}

export interface SecretRunResult {
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

// Runs an agent's command with secrets in its environment, for every harness
// alike. Patterm starts it, so values never pass through the agent's own
// shell, and masks them in the output before anything is kept or returned.
export class SecretRunner {
  private readonly running = new Map<string, Set<ChildProcess>>();

  constructor(private readonly baseEnv: () => NodeJS.ProcessEnv) {}

  async run(input: SecretRunInput): Promise<SecretRunResult> {
    const own = this.running.get(input.sessionId) ?? new Set<ChildProcess>();
    if (own.size >= RUNS_PER_SESSION) throw new Error(`At most ${RUNS_PER_SESSION} secret_run commands run at once`);
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(this.baseEnv())) {
      // The command must not reach Patterm as the agent.
      if (!key.startsWith('PATTERM_')) env[key] = value;
    }
    for (const entry of input.env) env[entry.name] = entry.value;
    const masks = maskSet(input.env.map((entry) => ({ value: entry.mask, label: entry.label })));
    let child: ChildProcess;
    try {
      child = spawn(input.command, { cwd: input.cwd, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    } catch (error) {
      // Node's validation errors quote the environment, values included.
      throw new Error(`Could not start the command (${(error as NodeJS.ErrnoException).code ?? 'invalid input'})`);
    }
    own.add(child);
    this.running.set(input.sessionId, own);
    const stdout = new Masker(masks);
    const stderr = new Masker(masks);
    child.stdout!.on('data', (chunk: Buffer) => stdout.write(chunk));
    child.stderr!.on('data', (chunk: Buffer) => stderr.write(chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abortRun(child);
    }, input.timeoutSeconds * 1000);
    try {
      const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once('error', (error: NodeJS.ErrnoException) => reject(new Error(`Could not start the command (${error.code ?? 'error'})`)));
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      const out = stdout.end();
      const err = stderr.end();
      return { exit_code: code, signal, timed_out: timedOut, stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated };
    } finally {
      clearTimeout(timer);
      // Anything the command left running in the background holds the
      // secrets too, so it ends with the command.
      void endRun(child);
      own.delete(child);
      if (!own.size) this.running.delete(input.sessionId);
    }
  }

  // Ends every command, or those of sessions that are no longer running.
  stop(isLive: (sessionId: string) => boolean = () => false): void {
    for (const [session, children] of this.running) {
      if (isLive(session)) continue;
      for (const child of children) abortRun(child);
    }
  }

  // Writes `NAME=value` lines into a dotenv file, replacing ones already
  // there, with mode 0600, and keeps it out of git. Returns how it is
  // excluded, or a warning.
  async write(file: string, entries: Array<{ name: string; value: string }>): Promise<{ excluded: string | null; warning: string | null }> {
    // A symlink would put the secret in a file the git checks never see.
    const existing = await fs.promises.lstat(file).catch(() => null);
    if (existing?.isSymbolicLink()) throw new Error(`${file} is a symlink; write to the file it points to`);
    if (existing && !existing.isFile()) throw new Error(`${file} is not a file`);
    let lines: string[] = [];
    try {
      lines = (await fs.promises.readFile(file, 'utf8')).split('\n');
      if (lines.at(-1) === '') lines.pop();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const entry of entries) {
      const line = `${entry.name}=${dotenvQuote(entry.value)}`;
      const existing = lines.findIndex((text) => new RegExp(`^(export\\s+)?${entry.name}\\s*=`).test(text));
      if (existing >= 0) lines[existing] = line;
      else lines.push(line);
    }
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, `${lines.join('\n')}\n`, { mode: 0o600 });
    await fs.promises.chmod(file, 0o600);
    return excludeFromGit(file);
  }
}

// Each command leads its own process group on POSIX, so the shell's children
// end with it, even after the shell exits. Windows ends the tree only while
// the shell runs: once it has exited, its ID may belong to another process.
// Node marks the exit before the output closes, so the check is the
// process's own state.
function endRun(child: ChildProcess): Promise<void> {
  if (!child.pid) return Promise.resolve();
  if (process.platform === 'win32') {
    return child.exitCode === null && child.signalCode === null ? killProcessTree(child.pid) : Promise.resolve();
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
  return Promise.resolve();
}

// Ends a command that ran out of time or whose agent stopped. A child it
// left behind may hold its output open, which would keep the call waiting,
// so the output closes too, once the tree has ended, so the call returns
// only when the command is gone.
function abortRun(child: ChildProcess): void {
  void endRun(child).finally(() => {
    child.stdout?.destroy();
    child.stderr?.destroy();
  });
}

function dotenvQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]*$/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

// Keeps a written secrets file out of commits, unless git already tracks it,
// which the agent must sort out with the user.
async function excludeFromGit(file: string): Promise<{ excluded: string | null; warning: string | null }> {
  const folder = path.dirname(file);
  const git = async (...args: string[]) => (await execFileAsync('git', args, { cwd: folder, encoding: 'utf8', windowsHide: true })).stdout.trim();
  let prefix: string;
  try {
    prefix = await git('rev-parse', '--show-prefix');
  } catch {
    return { excluded: null, warning: null };
  }
  // Git runs in the file's folder, so its pathspecs are the file name. The
  // exclude entry is from the top, built from git's own prefix for the folder,
  // since the top and the file's path can name it differently (Windows short
  // names, symlinks).
  const name = path.basename(file);
  const relative = `${prefix}${name}`;
  try {
    await git('ls-files', '--error-unmatch', '--', name);
    return { excluded: null, warning: `git tracks ${relative}; the secret will be committed unless it is untracked` };
  } catch {
    // Not tracked.
  }
  try {
    await git('check-ignore', '-q', '--', name);
    return { excluded: 'existing ignore rules', warning: null };
  } catch {
    // Not ignored yet.
  }
  // Relative to the folder git ran in.
  const exclude = path.resolve(folder, await git('rev-parse', '--git-path', 'info/exclude'));
  await fs.promises.mkdir(path.dirname(exclude), { recursive: true });
  const current = await fs.promises.readFile(exclude, 'utf8').catch(() => '');
  const entry = `/${gitignoreLiteral(relative)}`;
  if (!current.split('\n').includes(entry)) await fs.promises.appendFile(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}${entry}\n`);
  try {
    await git('check-ignore', '-q', '--', name);
  } catch {
    return { excluded: null, warning: `git does not ignore ${relative}; keep it out of commits yourself` };
  }
  return { excluded: '.git/info/exclude', warning: null };
}

// A path as a gitignore pattern that matches only itself.
function gitignoreLiteral(relative: string): string {
  return relative.replace(/[\\[\]*?]/g, '\\$&').replace(/^([!#])/, '\\$1').replace(/ $/, '\\ ');
}

// Raw and common encodings of each value, longest first.
export function maskSet(entries: Array<{ value: string; label: string }>): Array<{ needle: Buffer; label: Buffer }> {
  const masks = new Map<string, Buffer>();
  for (const { value, label } of entries) {
    const text = Buffer.from(`[secret:${label}]`);
    for (const form of [value, encodeURIComponent(value), Buffer.from(value).toString('base64'), JSON.stringify(value).slice(1, -1)]) {
      if (form.length >= 4 && !masks.has(form)) masks.set(form, text);
    }
  }
  return [...masks].map(([needle, label]) => ({ needle: Buffer.from(needle), label })).sort((a, b) => b.needle.length - a.needle.length);
}

// Collects a stream's output, masks values in it, and keeps the last
// OUTPUT_LIMIT bytes. It masks as it goes, holding back the last few bytes,
// which may be the start of a value split across writes, so nothing kept
// ever holds a value.
export class Masker {
  private carry: Buffer = Buffer.alloc(0);
  private kept: Buffer[] = [];
  private size = 0;
  private dropped = false;
  private readonly keep: number;

  constructor(private readonly masks: Array<{ needle: Buffer; label: Buffer }>) {
    this.keep = Math.max(0, ...masks.map((mask) => mask.needle.length - 1));
  }

  write(chunk: Buffer): void {
    const text = this.mask(Buffer.concat([this.carry, chunk]));
    const cut = Math.max(0, text.length - this.keep);
    this.append(text.subarray(0, cut));
    this.carry = text.subarray(cut);
  }

  end(): { text: string; truncated: boolean } {
    this.append(this.carry);
    this.carry = Buffer.alloc(0);
    return { text: Buffer.concat(this.kept).toString('utf8'), truncated: this.dropped };
  }

  private append(bytes: Buffer): void {
    if (!bytes.length) return;
    this.kept.push(bytes);
    this.size += bytes.length;
    while (this.size > OUTPUT_LIMIT && this.kept.length) {
      const first = this.kept[0]!;
      const over = this.size - OUTPUT_LIMIT;
      if (first.length <= over) {
        this.kept.shift();
        this.size -= first.length;
      } else {
        this.kept[0] = first.subarray(over);
        this.size -= over;
      }
      this.dropped = true;
    }
  }

  private mask(input: Buffer): Buffer {
    let text: Buffer = input;
    for (const { needle, label } of this.masks) {
      let at = text.indexOf(needle);
      if (at < 0) continue;
      const parts: Buffer[] = [];
      let from = 0;
      while (at >= 0) {
        parts.push(text.subarray(from, at), label);
        from = at + needle.length;
        at = text.indexOf(needle, from);
      }
      parts.push(text.subarray(from));
      text = Buffer.concat(parts);
    }
    return text;
  }
}
