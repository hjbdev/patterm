import path from 'node:path';
import { envValue } from './Environment';
import { findExecutable } from './Executable';

// The shell for raw terminals and freeform commands: $SHELL on POSIX, and
// PowerShell 7 (falling back to Windows PowerShell) on Windows.
export function defaultShell(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform !== 'win32') return env.SHELL ?? '/bin/sh';
  return findExecutable('pwsh', env)
    ?? path.join(envValue(env, 'SystemRoot') ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// argv that runs `command` through `shell`, or starts it interactively.
export function shellArgv(shell: string, command?: string): string[] {
  const trimmed = command?.trim();
  switch (shellKind(shell)) {
    case 'powershell':
      return trimmed ? [shell, '-NoLogo', '-Command', trimmed] : [shell, '-NoLogo'];
    default:
      return trimmed ? [shell, '-lc', trimmed] : [shell];
  }
}

// The command a shellArgv() argv runs, or '' for an interactive shell.
export function commandFromShellArgv(argv: readonly string[]): string {
  const [shell, ...rest] = argv;
  if (!shell) return '';
  if (rest[0] === '-lc') return rest.slice(1).join(' ');
  if (shellKind(shell) === 'powershell' && rest[0] === '-NoLogo' && rest[1] === '-Command') return rest.slice(2).join(' ');
  return '';
}

function shellKind(shell: string): 'powershell' | 'posix' {
  const name = path.basename(shell.replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
  return name === 'pwsh' || name === 'powershell' ? 'powershell' : 'posix';
}
