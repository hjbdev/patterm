import type { DatabaseService } from '../Services/DatabaseService';
import type { OpenCodeServerService } from '../Services/OpenCodeServerService';
import type { TimelineService } from '../Services/TimelineService';

// Restarts OpenCode's shared background server with the installed CLI, so a
// launch blocked by a CLI/server version mismatch can proceed.
export class RestartOpenCodeServiceAction {
  constructor(
    private readonly database: DatabaseService,
    private readonly timeline: TimelineService,
    private readonly openCode?: Pick<OpenCodeServerService, 'restartService'>
  ) {}

  async execute(): Promise<{ version: string }> {
    if (!this.openCode) throw new Error('OpenCode is unavailable');
    const install = this.database.connection
      .prepare(`select executable_path from harness_installations where harness = 'opencode' and status = 'available' order by last_checked_at desc limit 1`)
      .get() as { executable_path: string } | undefined;
    if (!install?.executable_path) throw new Error('OpenCode is not installed');
    const result = await this.openCode.restartService(install.executable_path);
    this.timeline.append({ event_type: 'opencode.service_restarted', actor_type: 'user', metadata: { version: result.version } });
    return result;
  }
}
