import { GitError, GitService, type GitResult } from '../GitService';
import type { SandboxRow, SandboxService } from './SandboxService';

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

// Git for diff review and worktree records. Paths inside a sandboxed
// worktree run git on the sandbox's copy, where the agent made its changes;
// every other path runs git here.
export class SandboxGitService extends GitService {
  constructor(private readonly sandboxes: Pick<SandboxService, 'forPath' | 'exec'>) {
    super();
  }

  override async run(cwd: string, args: string[]): Promise<GitResult> {
    const sandbox = this.sandboxes.forPath(cwd);
    if (!sandbox) return super.run(cwd, args);
    const result = await this.remote(sandbox, cwd, args);
    return { stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8') };
  }

  override async buffer(cwd: string, args: string[], maxBuffer = MAX_OUTPUT_BYTES): Promise<Buffer> {
    const sandbox = this.sandboxes.forPath(cwd);
    if (!sandbox) return super.buffer(cwd, args, maxBuffer);
    const result = await this.remote(sandbox, cwd, args, false);
    if (result.stdout.length > maxBuffer) throw new GitError('git output exceeded the buffer', null);
    return result.stdout;
  }

  private async remote(sandbox: SandboxRow, cwd: string, args: string[], includeStdout = true) {
    const result = await this.sandboxes.exec(sandbox, ['git', ...args], { cwd, timeoutMs: 120_000 });
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString('utf8').trim();
      const stdout = includeStdout ? result.stdout.toString('utf8').trim() : '';
      throw new GitError(stderr || stdout || `git exited with ${result.exitCode}`, result.exitCode);
    }
    return result;
  }
}
