import fs from 'node:fs';
import path from 'node:path';
import { envValue } from './Environment';

// Command resolution for Windows. CreateProcess runs only .exe/.com files, and
// Node refuses to spawn .cmd/.bat files without a shell, which is how npm and
// pnpm install CLIs. These helpers turn a command into something both Node and
// the terminal sidecar can start. POSIX commands pass through unchanged.

export interface ResolvedCommand {
  command: string;
  args: string[];
  // The args are a ready-made Windows command line tail: pass them through
  // unquoted (Node `windowsVerbatimArguments`, sidecar `verbatim_args`).
  verbatim: boolean;
}

const windows = (): boolean => process.platform === 'win32';

export function windowsExtensions(env: NodeJS.ProcessEnv = process.env): string[] {
  return (envValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
    .map((extension) => extension.toLowerCase());
}

// Finds `name` on PATH. On Windows the PATHEXT extensions are tried in order and
// an extensionless file is never chosen, because npm installs a POSIX script
// beside each .cmd shim.
export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const extensions = windows() ? windowsExtensions(env) : [];
  const candidates = (base: string): string[] => {
    if (!windows()) return [base];
    return extensions.includes(path.extname(base).toLowerCase()) ? [base] : extensions.map((extension) => base + extension);
  };
  if (name.includes('/') || (windows() && name.includes('\\'))) {
    return candidates(path.resolve(name)).find(isExecutableFile) ?? null;
  }
  const dirs = (envValue(env, 'PATH') ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const found = candidates(path.join(dir, name)).find(isExecutableFile);
    if (found) return found;
  }
  return null;
}

export function resolveCommand(command: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): ResolvedCommand {
  if (!windows()) return { command, args: [...args], verbatim: false };
  const file = findExecutable(command, env) ?? command;
  if (!/\.(cmd|bat)$/i.test(file)) return { command: file, args: [...args], verbatim: false };
  const shim = readCmdShim(file, env);
  if (shim) return { command: shim.command, args: [...shim.args, ...args], verbatim: false };
  return cmdCommand(file, args, env);
}

// npm (cmd-shim) and pnpm shims end with `"%dp0%\<target>" %*` or
// `"%~dp0\<target>" %*`. Running the target directly avoids cmd.exe's argument
// re-parsing and its 8191-character command line limit.
export function readCmdShim(file: string, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } | null {
  let source: string;
  try {
    if (fs.statSync(file).size > 64 * 1024) return null;
    source = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const match = /"%(?:~dp0|dp0%)\\?([^"%]+)"\s+%\*/i.exec(source);
  if (!match) return null;
  const target = path.resolve(path.dirname(file), match[1]!);
  if (!fs.existsSync(target)) return null;
  if (/\.(exe|com)$/i.test(target)) return { command: target, args: [] };
  if (!/\.[cm]?js$/i.test(target)) return null;
  const bundledNode = path.join(path.dirname(file), 'node.exe');
  const node = fs.existsSync(bundledNode) ? bundledNode : findExecutable('node', env);
  return node ? { command: node, args: [target] } : null;
}

// Runs a batch file through cmd.exe, escaping each argument for both cmd.exe
// and the C runtime. Arguments containing newlines cannot pass through cmd.exe.
export function cmdCommand(file: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): ResolvedCommand {
  const line = [escapeCmdMeta(path.normalize(file)), ...args.map((arg) => escapeCmdArgument(arg))].join(' ');
  return { command: envValue(env, 'ComSpec') ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdMeta(value: string): string {
  return value.replace(CMD_META, '^$1');
}

export function escapeCmdArgument(arg: string): string {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
  return escapeCmdMeta(quoted);
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    if (!windows()) fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
