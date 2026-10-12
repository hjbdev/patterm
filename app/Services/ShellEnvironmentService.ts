import { execFile } from 'node:child_process';
import { caseInsensitiveEnv } from '../Platform/Environment';

export interface ShellEnvironmentOptions {
  env?: NodeJS.ProcessEnv;
  shell?: string;
  timeoutMs?: number;
}

// Resolves the user's interactive shell environment once so desktop-launched
// Patterm can see PATH/tool-manager shims that are normally added by shell init.
// Windows apps already receive the user's environment, so it is used as is.
export class ShellEnvironmentService {
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly shell: string;
  private readonly timeoutMs: number;
  private resolved: NodeJS.ProcessEnv | null = null;

  constructor(options: ShellEnvironmentOptions = {}) {
    this.baseEnv = options.env ?? process.env;
    this.shell = options.shell ?? this.baseEnv.SHELL ?? '/bin/sh';
    this.timeoutMs = options.timeoutMs ?? 4000;
  }

  async resolve(): Promise<NodeJS.ProcessEnv> {
    if (this.resolved) {
      return this.resolved;
    }

    const shellEnv = process.platform === 'win32' ? {} : await this.captureInteractiveEnv();
    this.resolved = caseInsensitiveEnv({ ...this.baseEnv, ...shellEnv });
    return this.resolved;
  }

  private captureInteractiveEnv(): Promise<Record<string, string>> {
    return new Promise((resolve) => {
      execFile(
        this.shell,
        ['-ic', 'env -0'],
        {
          env: this.baseEnv,
          encoding: 'buffer',
          maxBuffer: 1024 * 1024,
          timeout: this.timeoutMs,
          windowsHide: true
        },
        (error, stdout) => {
          if (error || !stdout.length) {
            resolve({});
            return;
          }
          resolve(parseNulEnv(stdout));
        }
      );
    });
  }
}

export function parseNulEnv(buffer: Buffer): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of buffer.toString('utf8').split('\0')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const key = entry.slice(0, separator);
    const value = entry.slice(separator + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    env[key] = value;
  }
  return env;
}
