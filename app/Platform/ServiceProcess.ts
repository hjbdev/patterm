import { execFile, spawn, type ChildProcess, type ChildProcessByStdio, type ExecFileException, type ExecFileOptions, type SpawnOptions, type SpawnOptionsWithStdioTuple, type StdioNull, type StdioPipe } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import type { Readable, Writable } from 'node:stream';
import { envValue } from './Environment';
import { findExecutable, resolveCommand, type ResolvedCommand } from './Executable';
import { killProcessTree } from './ProcessTree';

// Child processes started by services: every command goes through
// resolveCommand() so npm/pnpm .cmd shims and .bat files start on Windows, and
// hides the console window a GUI parent would otherwise flash. POSIX calls pass
// through to Node unchanged.

// CreateProcess takes a command line of at most 32767 UTF-16 characters;
// cmd.exe, which runs batch files, at most 8191.
const COMMAND_LINE_LIMIT = 32_767;
const CMD_LINE_LIMIT = 8_191;

const resolvedFiles = new Map<string, string>();

// resolveCommand() for a bare command name, remembering where PATH found it on
// Windows. Git runs many times a second, and each lookup would otherwise stat
// every PATH directory for every PATHEXT extension.
export function resolveService(command: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): ResolvedCommand {
  if (process.platform !== 'win32' || /[\\/]/.test(command)) return resolveCommand(command, args, env);
  const key = `${envValue(env, 'PATH') ?? ''}\0${envValue(env, 'PATHEXT') ?? ''}\0${command}`;
  let file = resolvedFiles.get(key);
  if (!file || !fs.existsSync(file)) {
    file = findExecutable(command, env) ?? command;
    resolvedFiles.set(key, file);
  }
  return resolveCommand(file, args, env);
}

// execFile() with UTF-8 output. Windows cannot signal the process group, so a
// timeout there ends the whole process tree rather than only the launcher
// (a .cmd shim or a launcher .exe leaves its child running).
export function execFileResolved(
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void
): ChildProcess {
  const resolved = resolveService(file, args, options.env ?? process.env);
  const { timeout, ...rest } = options;
  const common = { ...rest, encoding: 'utf8' as const, windowsHide: true, windowsVerbatimArguments: resolved.verbatim };
  if (process.platform !== 'win32' || !timeout) return execFile(resolved.command, resolved.args, { ...common, ...(timeout ? { timeout } : {}) }, callback);
  const child = execFile(resolved.command, resolved.args, common, callback);
  const timer = setTimeout(() => { if (child.pid) void killProcessTree(child.pid); }, timeout);
  child.once('close', () => clearTimeout(timer));
  child.once('error', () => clearTimeout(timer));
  return child;
}

export function spawnResolved(file: string, args: readonly string[], options: SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioPipe>): ChildProcessByStdio<Writable, Readable, Readable>;
export function spawnResolved(file: string, args: readonly string[], options: SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioNull>): ChildProcessByStdio<Writable, Readable, null>;
export function spawnResolved(file: string, args: readonly string[], options?: SpawnOptions): ChildProcess;
export function spawnResolved(file: string, args: readonly string[], options: SpawnOptions = {}): ChildProcess {
  const resolved = resolveService(file, args, options.env ?? process.env);
  return spawn(resolved.command, resolved.args, { ...options, windowsHide: true, windowsVerbatimArguments: resolved.verbatim });
}

// Ends `child`. `group` signals the child's whole process group on POSIX, which
// needs the child to have been spawned `detached`. Windows has no groups or
// signals, so it ends the process tree instead.
export function stopChild(child: ChildProcess, signal: NodeJS.Signals, group = false): void {
  try {
    if (process.platform === 'win32' && child.pid) void killProcessTree(child.pid, signal);
    else if (group && process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { /* The owned process may already have exited. */ }
}

// An upper bound on the command line Node builds for `resolved`, in UTF-16
// characters: every quote and backslash may need an escape.
export function commandLineLength(resolved: ResolvedCommand): number {
  if (resolved.verbatim) return resolved.command.length + 2 + resolved.args.reduce((sum, arg) => sum + arg.length + 1, 0);
  const quoted = (value: string): number => value.length + 2 + (value.match(/["\\]/g)?.length ?? 0);
  return resolved.args.reduce((sum, arg) => sum + quoted(arg) + 1, quoted(resolved.command));
}

// True when Windows would refuse `resolved` for its length.
export function commandLineTooLong(resolved: ResolvedCommand): boolean {
  return commandLineLength(resolved) >= (resolved.verbatim ? CMD_LINE_LIMIT : COMMAND_LINE_LIMIT);
}

// The home directory a harness CLI uses. Windows programs read USERPROFILE and
// ignore HOME, which Git Bash or MSYS may set to a POSIX-style path.
export function userHome(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform !== 'win32') return env.HOME ?? os.homedir();
  return envValue(env, 'USERPROFILE') || os.homedir();
}
