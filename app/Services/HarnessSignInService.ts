import { spawn } from 'node:child_process';
import type { HarnessId, HarnessProvider, HarnessSignIn, SignInCheckResult } from '../Harness/HarnessProvider';
import { resolveCommand } from '../Platform/Executable';

export interface HarnessSignInOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  // A signed-in answer is reused this long; other answers are checked again
  // each time, since the user is likely signing in.
  signedInTtlMs?: number;
}

const OUTPUT_LIMIT = 64 * 1024;

// Runs each harness's own sign-in check and keeps only signed in, signed out
// or unknown. Account details in the output are never stored or returned.
export class HarnessSignInService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly signedInTtlMs: number;
  private readonly cache = new Map<HarnessId, { state: HarnessSignIn; at: number; path: string }>();
  private readonly running = new Map<HarnessId, Promise<HarnessSignIn>>();

  constructor(private readonly providers: HarnessProvider[], options: HarnessSignInOptions = {}) {
    this.env = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.signedInTtlMs = options.signedInTtlMs ?? 5 * 60_000;
  }

  // Null when the harness has no check.
  async check(harness: HarnessId, executablePath: string): Promise<HarnessSignIn | null> {
    const check = this.providers.find((provider) => provider.id === harness)?.signInCheck;
    if (!check) return null;
    const cached = this.cache.get(harness);
    if (cached?.state === 'signed_in' && cached.path === executablePath && Date.now() - cached.at < this.signedInTtlMs) return cached.state;
    const pending = this.running.get(harness);
    if (pending) return pending;
    const run = this.run(executablePath, check.args)
      .then((result) => result ? check.parse(result) : 'unknown' as const)
      .then((state) => {
        this.cache.set(harness, { state, at: Date.now(), path: executablePath });
        return state;
      })
      .finally(() => this.running.delete(harness));
    this.running.set(harness, run);
    return run;
  }

  private run(executablePath: string, args: string[]): Promise<SignInCheckResult | null> {
    const command = resolveCommand(executablePath, args, this.env);
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(command.command, command.args, {
          env: this.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          windowsVerbatimArguments: command.verbatim
        });
      } catch {
        resolve(null);
        return;
      }
      const timer = setTimeout(() => child.kill(), this.timeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => { if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString(); });
      child.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve(signal ? null : { code, stdout, stderr });
      });
    });
  }
}
