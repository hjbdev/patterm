import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export interface GitResult {
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  constructor(message: string, readonly exitCode: number | null) {
    super(message);
    this.name = 'GitError';
  }
}

export class GitService {
  async run(cwd: string, args: string[]): Promise<GitResult> {
    try {
      const { stdout, stderr } = await execFileAsync('git', args, {
        cwd,
        encoding: 'utf8',
        maxBuffer: MAX_OUTPUT_BYTES
      });
      return { stdout, stderr };
    } catch (error) {
      throw gitError(error);
    }
  }

  // Query commands such as merge-base, symbolic-ref -q, and rev-parse -q
  // --verify exit with status 1 when there is no result; that returns null.
  async query(cwd: string, args: string[]): Promise<string | null> {
    try {
      return (await this.run(cwd, args)).stdout;
    } catch (error) {
      if (error instanceof GitError && error.exitCode === 1) return null;
      throw error;
    }
  }

  // Raw bytes, for blob contents that may not be text.
  async buffer(cwd: string, args: string[], maxBuffer = MAX_OUTPUT_BYTES): Promise<Buffer> {
    try {
      const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'buffer', maxBuffer });
      return stdout;
    } catch (error) {
      // Never echo partial file contents into an error message.
      throw gitError(error, false);
    }
  }

  async root(cwd: string): Promise<string> {
    const result = await this.run(cwd, ['rev-parse', '--show-toplevel']);
    return result.stdout.trim();
  }

  async branch(cwd: string): Promise<string | null> {
    const result = await this.run(cwd, ['branch', '--show-current']);
    return result.stdout.trim() || null;
  }
}

function gitError(error: unknown, includeStdout = true): Error {
  if (error && typeof error === 'object' && 'stderr' in error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim();
    const stdout = includeStdout ? String((error as { stdout?: unknown }).stdout ?? '').trim() : '';
    const code = (error as { code?: unknown }).code;
    return new GitError(stderr || stdout || String(error), typeof code === 'number' ? code : null);
  }
  return error instanceof Error ? error : new Error(String(error));
}
