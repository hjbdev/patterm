import { randomUUID } from 'node:crypto';
import type { DatabaseService } from '../Services/DatabaseService';
import type { DiscoveredHarness, HarnessDiscoveryService } from '../Services/HarnessDiscoveryService';
import type { TimelineService } from '../Services/TimelineService';

interface HarnessInstallationRow {
  id: string;
  discovered_at: string;
}

// Runs harness discovery and upserts the result into harness_installations,
// keyed by harness so re-running refreshes status/version without duplicating
// rows or losing the original discovered_at. The timeline records a scan only
// when it changed something, since Get started re-scans while it is open.
export class DiscoverHarnessesAction {
  constructor(
    private readonly database: DatabaseService,
    private readonly timeline: TimelineService,
    private readonly discovery: HarnessDiscoveryService
  ) {}

  // changed: whether any harness's status, version or path differs.
  async execute(env?: NodeJS.ProcessEnv): Promise<{ harnesses: DiscoveredHarness[]; changed: boolean }> {
    const found = await this.discovery.discover(env);
    const now = new Date().toISOString();
    const db = this.database.connection;
    const before = new Map((db.prepare(`select harness, status, version, executable_path from harness_installations`).all() as Array<{ harness: string; status: string; version: string | null; executable_path: string }>)
      .map((row) => [row.harness, `${row.status}|${row.version ?? ''}|${row.executable_path}`]));
    const changed = found.some((row) => before.get(row.harness) !== `${row.status}|${row.version ?? ''}|${row.executablePath ?? ''}`);

    const upsert = db.transaction((rows: DiscoveredHarness[]) => {
      for (const row of rows) {
        const existing = db
          .prepare(`select id, discovered_at from harness_installations where harness = ?`)
          .get(row.harness) as HarnessInstallationRow | undefined;

        if (existing) {
          db.prepare(
            `update harness_installations
             set executable_path = ?, version = ?, status = ?, last_checked_at = ?
             where id = ?`
          ).run(row.executablePath ?? '', row.version, row.status, now, existing.id);
        } else {
          db.prepare(
            `insert into harness_installations
             (id, harness, executable_path, version, status, discovered_at, last_checked_at)
             values (?, ?, ?, ?, ?, ?, ?)`
          ).run(`harness_${randomUUID()}`, row.harness, row.executablePath ?? '', row.version, row.status, now, now);
        }
      }
    });

    upsert(found);

    if (changed) this.timeline.append({
      event_type: 'harness.discovered',
      actor_type: 'system',
      metadata: {
        count: found.length,
        available: found.filter((row) => row.status === 'available').map((row) => row.harness)
      }
    });

    return { harnesses: found, changed };
  }
}
