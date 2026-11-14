import type { ChildProcess } from 'node:child_process';
import { z } from 'zod';
import { execFileResolved, stopChild, userHome } from '../Platform/ServiceProcess';
import type { DatabaseService } from './DatabaseService';
import type { DebugLogService } from './DebugLogService';
import type { UsageService } from './UsageService';

const reportSchema = z.object({
  status: z.literal('SUCCESS'),
  num_turns: z.literal(0),
  command: z.object({
    name: z.literal('usage'),
    data: z.object({ groups: z.array(z.object({
      name: z.string().trim().min(1).max(120),
      buckets: z.array(z.object({
        id: z.string().min(1).max(120),
        name: z.string().trim().min(1).max(120),
        window: z.string().optional(),
        remaining_fraction: z.number().finite().min(0).max(1).optional(),
        reset_time: z.string().datetime({ offset: true }).optional(),
        disabled: z.boolean().optional()
      }))
    })) })
  })
});

interface Options {
  database: DatabaseService;
  usage: Pick<UsageService, 'recordLimits'>;
  env: NodeJS.ProcessEnv;
  debugLog?: Pick<DebugLogService, 'write'>;
  now?: () => number;
  timeoutMs?: number;
}

// /usage is handled by the native CLI, not a model. Keep authentication there;
// only its structured quota report crosses into Patterm's existing usage store.
export class AntigravityQuotaService {
  private pending: Promise<void> | null = null;
  private lastAttempt: { executable: string; at: number } | null = null;
  private child: ChildProcess | null = null;
  private disposed = false;
  private readonly now: () => number;

  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
  }

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.pending) return this.pending;
    const installation = this.options.database.connection.prepare(`
      select executable_path from harness_installations
      where harness = 'agy' and status = 'available' order by last_checked_at desc limit 1
    `).get() as { executable_path: string | null } | undefined;
    const executable = installation?.executable_path?.trim();
    if (!executable) return Promise.resolve();
    const at = this.now();
    if (this.lastAttempt?.executable === executable && at >= this.lastAttempt.at && at - this.lastAttempt.at < 60_000) return Promise.resolve();
    this.lastAttempt = { executable, at };
    this.pending = this.collect(executable).catch(() => {
      // Provider diagnostics may contain account details. Retain the last dated
      // observation and log only that refresh failed, never its raw output.
      if (!this.disposed) this.options.debugLog?.write('usage', 'agy-quota.failed', {});
    }).finally(() => { this.pending = null; });
    return this.pending;
  }

  dispose(): void {
    this.disposed = true;
    if (this.child) stopChild(this.child, 'SIGTERM');
  }

  private async collect(executable: string): Promise<void> {
    const output = await new Promise<string>((resolve, reject) => {
      this.child = execFileResolved(executable, ['--print', '/usage', '--output-format', 'json'], {
        env: this.options.env, cwd: userHome(this.options.env), timeout: this.options.timeoutMs ?? 15_000, maxBuffer: 1024 * 1024
      }, (error, stdout) => {
        this.child = null;
        if (error) reject(new Error('Antigravity quota refresh failed'));
        else resolve(stdout);
      });
    });
    if (this.disposed) return;
    const report = reportSchema.parse(JSON.parse(output));
    const observedAt = new Date(this.now()).toISOString();
    const limits = report.command.data.groups.flatMap((group) => group.buckets.flatMap((bucket) => {
      if (bucket.disabled || bucket.remaining_fraction === undefined) return [];
      const window = bucket.window === '5h' ? '5h limit' : bucket.window === 'weekly' ? 'Weekly limit' : bucket.name;
      return [{ label: `${group.name} · ${window}`, usedPercent: (1 - bucket.remaining_fraction) * 100,
        observedAt, ...(bucket.reset_time ? { resetsAt: new Date(bucket.reset_time).toISOString() } : {}) }];
    }));
    this.options.usage.recordLimits('agy', limits);
  }
}
