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
// rows or losing the original discovered_at.
export class DiscoverHarnessesAction {
  constructor(
    private readonly database: DatabaseService,
    private readonly timeline: TimelineService,
    private readonly discovery: HarnessDiscoveryService
  ) {}

  async execute(): Promise<{ harnesses: DiscoveredHarness[] }> {
    const found = await this.discovery.discover();
    const now = new Date().toISOString();
    const db = this.database.connection;

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

    this.timeline.append({
      event_type: 'harness.discovered',
      actor_type: 'system',
      metadata: {
        count: found.length,
        available: found.filter((row) => row.status === 'available').map((row) => row.harness)
      }
    });

    return { harnesses: found };
  }
}
