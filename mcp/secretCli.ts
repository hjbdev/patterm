import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withEnv } from '../app/Platform/Environment';
import { resolveCommand } from '../app/Platform/Executable';

type Fetch = (refs: string[]) => Promise<string[]>;
// Values by `name` or `name.field`; proxy URLs by `name` or `name@host`.
export interface SecretSource { values: Fetch; urls: Fetch }

const USAGE = `usage: patterm-secret run [--env NAME=secret[.field]] [--url NAME=secret[@host]] ... -- <command> [args...]
       patterm-secret write <file> NAME=secret[.field] [...]

Secrets come from your Patterm session; ask for one with the secret_request tool.
--env passes a value; a login's fields are .username and .password.
--url passes a local proxy address that stands in for https://<host>/ and adds
the key, so the command never holds it. Output that contains either is masked.`;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Output is held back this long at most, so a value split across writes is
// still masked without stalling interactive programs.
const FLUSH_MS = 100;

// The `patterm-secret` command agents run in their shells. Values travel from
// Patterm to the child process's environment, or to a file, and never to the
// agent's own environment or arguments.
export async function secretCli(args: string[], source: SecretSource): Promise<number> {
  const [command, ...rest] = args;
  if (command === 'run') return run(rest, source);
  if (command === 'write') return write(rest, source.values);
  process.stderr.write(`${USAGE}\n`);
  return command === 'help' || command === '--help' || command === '-h' ? 0 : 2;
}

function assignment(text: string): { name: string; ref: string } {
  const separator = text.indexOf('=');
  const name = text.slice(0, separator);
  const ref = text.slice(separator + 1);
  if (separator < 1 || !ENV_NAME.test(name) || !ref) throw new Error(`expected NAME=secret, got ${JSON.stringify(text)}`);
  return { name, ref };
}

async function run(args: string[], source: SecretSource): Promise<number> {
  const envs: Array<{ name: string; ref: string }> = [];
  const urls: Array<{ name: string; ref: string }> = [];
  let index = 0;
  for (; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--') { index += 1; break; }
    if (arg === '--env' || arg === '-e') envs.push(assignment(args[++index] ?? ''));
    else if (arg.startsWith('--env=')) envs.push(assignment(arg.slice(6)));
    else if (arg === '--url') urls.push(assignment(args[++index] ?? ''));
    else if (arg.startsWith('--url=')) urls.push(assignment(arg.slice(6)));
    else break;
  }
  const command = args.slice(index);
  if ((!envs.length && !urls.length) || !command.length) throw new Error(`nothing to run\n${USAGE}`);
  const [values, addresses] = await Promise.all([source.values(envs.map((entry) => entry.ref)), source.urls(urls.map((entry) => entry.ref))]);
  const assignments = [...envs, ...urls];
  const given = [...values, ...addresses];
  const env = withEnv(process.env, Object.fromEntries(assignments.map((entry, i) => [entry.name, given[i]!])));
  // A proxy URL's token is a credential too: it stays out of the output, and
  // so out of the conversation, where other agents could read it.
  const tokens = addresses.map((address) => new URL(address).pathname.split('/')[1]!);
  const masks = maskSet([...values, ...tokens], [...envs.map((entry) => entry.ref), ...urls.map((entry) => `${entry.ref} url`)]);
  const target = resolveCommand(command[0]!, command.slice(1), env);
  const child = spawn(target.command, target.args, { stdio: ['inherit', 'pipe', 'pipe'], env, windowsHide: true, windowsVerbatimArguments: target.verbatim });
  const out = new Masker(masks, process.stdout);
  const err = new Masker(masks, process.stderr);
  child.stdout!.on('data', (chunk: Buffer) => out.write(chunk));
  child.stderr!.on('data', (chunk: Buffer) => err.write(chunk));
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => child.kill(signal));
  return new Promise((resolve) => {
    child.once('error', (error) => {
      process.stderr.write(`patterm-secret: could not start ${command[0]}: ${error.message}\n`);
      resolve(127);
    });
    child.once('close', (code, signal) => {
      out.end();
      err.end();
      resolve(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 1) : 0));
    });
  });
}

async function write(args: string[], fetchValues: Fetch): Promise<number> {
  const [file, ...pairs] = args;
  if (!file || !pairs.length) throw new Error(`nothing to write\n${USAGE}`);
  const assignments = pairs.map(assignment);
  const values = await fetchValues(assignments.map((entry) => entry.ref));
  const target = path.resolve(file);
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(target, 'utf8').split('\n');
    if (lines.at(-1) === '') lines.pop();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  assignments.forEach((entry, i) => {
    const line = `${entry.name}=${dotenvQuote(values[i]!)}`;
    const existing = lines.findIndex((text) => new RegExp(`^(export\\s+)?${entry.name}\\s*=`).test(text));
    if (existing >= 0) lines[existing] = line;
    else lines.push(line);
  });
  fs.writeFileSync(target, `${lines.join('\n')}\n`, { mode: 0o600 });
  fs.chmodSync(target, 0o600);
  const excluded = excludeFromGit(target);
  process.stderr.write(`patterm-secret: wrote ${assignments.map((entry) => entry.name).join(', ')} to ${file}${excluded ? ` (git-excluded via ${excluded})` : ''}\n`);
  return 0;
}

function dotenvQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]*$/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

// Keeps a written secrets file out of commits, unless git already tracks it,
// which the agent must sort out with the user.
function excludeFromGit(file: string): string | null {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: path.dirname(file), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let prefix: string;
  try {
    prefix = git('rev-parse', '--show-prefix');
  } catch {
    return null;
  }
  // Git runs in the file's folder, so its pathspecs are the file name. The
  // exclude entry is from the top, built from git's own prefix for the folder,
  // since the top and the file's path can name it differently (Windows short
  // names, symlinks).
  const relative = `${prefix}${path.basename(file)}`;
  try {
    git('ls-files', '--error-unmatch', '--', path.basename(file));
    process.stderr.write(`patterm-secret: warning: git tracks ${relative}; the secret will be committed unless you untrack it\n`);
    return null;
  } catch {
    // Not tracked.
  }
  try {
    if (git('check-ignore', '-q', '--', path.basename(file)) === '') return 'existing ignore rules';
  } catch {
    // Not ignored yet.
  }
  // Relative to the folder git ran in.
  const exclude = path.resolve(path.dirname(file), git('rev-parse', '--git-path', 'info/exclude'));
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  const entry = `/${relative}`;
  if (!current.split('\n').includes(entry)) fs.appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}${entry}\n`);
  return path.relative(process.cwd(), exclude) || exclude;
}

// Raw and common encodings of each value, longest first.
export function maskSet(values: string[], refs: string[]): Array<{ needle: Buffer; label: Buffer }> {
  const masks = new Map<string, Buffer>();
  values.forEach((value, i) => {
    const label = Buffer.from(`[secret:${refs[i]}]`);
    for (const form of [value, encodeURIComponent(value), Buffer.from(value).toString('base64'), JSON.stringify(value).slice(1, -1)]) {
      if (form.length >= 4 && !masks.has(form)) masks.set(form, label);
    }
  });
  return [...masks].map(([needle, label]) => ({ needle: Buffer.from(needle), label })).sort((a, b) => b.needle.length - a.needle.length);
}

// Replaces values in a byte stream. It holds back the last few bytes, which
// may be the start of a value split across writes.
export class Masker {
  private carry: Buffer = Buffer.alloc(0);
  private timer: NodeJS.Timeout | null = null;
  private readonly keep: number;

  constructor(private readonly masks: Array<{ needle: Buffer; label: Buffer }>, private readonly output: NodeJS.WritableStream) {
    this.keep = Math.max(0, ...masks.map((mask) => mask.needle.length - 1));
  }

  write(chunk: Buffer): void {
    const text = this.mask(Buffer.concat([this.carry, chunk]));
    const cut = Math.max(0, text.length - this.keep);
    this.output.write(text.subarray(0, cut));
    this.carry = text.subarray(cut);
    if (this.timer) clearTimeout(this.timer);
    this.timer = this.carry.length ? setTimeout(() => this.end(), FLUSH_MS) : null;
  }

  end(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.carry.length) this.output.write(this.carry);
    this.carry = Buffer.alloc(0);
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
