import { execFile } from 'node:child_process';

// Create the native thread before starting the TUI so Patterm can record an
// exact resume ID even if the terminal is closed before Amp prints one.
export class AmpThreadService {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async prepare(executable: string, cwd: string, resumeId: string | null): Promise<string> {
    if (resumeId) {
      if (!/^T-[A-Za-z0-9-]+$/.test(resumeId)) throw new Error('Invalid Amp thread ID');
      return resumeId;
    }
    return new Promise((resolve, reject) => {
      execFile(executable, ['threads', 'new'], { cwd, env: this.env, timeout: 30_000, maxBuffer: 16_384 }, (error, stdout) => {
        if (error) return reject(new Error('Amp could not create a thread; check the CLI and its login'));
        const threadId = /(?:^|\/threads\/)(T-[A-Za-z0-9-]+)(?:\s|$|\/)/.exec(stdout.trim())?.[1];
        if (!threadId) return reject(new Error('Amp did not return a thread ID'));
        resolve(threadId);
      });
    });
  }

  // Amp names threads during the first turn but its execute stream never says
  // so. The recent-thread list is small; exporting one thread carries its whole
  // transcript, so it is only the fallback for a thread outside that page.
  async title(executable: string, cwd: string, threadId: string): Promise<string | null> {
    const listed = await this.json(executable, cwd, ['threads', 'list', '--json', '--limit', '20'], 1024 * 1024);
    const match = (Array.isArray(listed) ? listed : []).map(record).find((thread) => thread.id === threadId);
    const exported = match ?? record(await this.json(executable, cwd, ['threads', 'export', threadId], 256 * 1024 * 1024));
    return typeof exported.title === 'string' && exported.title.trim() ? exported.title.trim() : null;
  }

  private json(executable: string, cwd: string, args: string[], maxBuffer: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      execFile(executable, args, { cwd, env: this.env, timeout: 30_000, maxBuffer }, (error, stdout) => {
        if (error) return reject(new Error('Amp could not read the thread title'));
        try { resolve(JSON.parse(stdout) as unknown); } catch { reject(new Error('Amp returned invalid thread JSON')); }
      });
    });
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
