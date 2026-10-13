import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { pathColumn, pathParam, storedPath } from '../Platform/PathIdentity';
import type { DatabaseService } from '../Services/DatabaseService';
import type { TimelineService } from '../Services/TimelineService';

export const createProjectInput = z.object({
  path: z.string().min(1),
  name: z.string().default(''),
  actor_type: z.enum(['user', 'agent', 'system']).default('user'),
  actor_id: z.string().nullable().default(null)
});

export type CreateProjectInput = z.infer<typeof createProjectInput>;

interface ProjectRow {
  id: string;
  name: string;
  path: string;
}

// Registers a local project rooted at a real filesystem path. Re-registering an
// existing path returns the existing project rather than duplicating it.
export class CreateProjectAction {
  constructor(
    private readonly database: DatabaseService,
    private readonly timeline: TimelineService
  ) {}

  execute(input: CreateProjectInput): { project_id: string; name: string; path: string; existed: boolean } {
    const resolved = storedPath(path.resolve(input.path));

    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new Error(`path does not exist: ${resolved}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`path is not a directory: ${resolved}`);
    }

    const existing = this.database.connection
      .prepare(`select id, name, path from projects where ${pathColumn('path')} = ?`)
      .get(pathParam(resolved)) as ProjectRow | undefined;
    if (existing) {
      return { project_id: existing.id, name: existing.name, path: existing.path, existed: true };
    }

    const name = input.name.trim() || path.basename(resolved) || resolved;
    const id = `project_${randomUUID()}`;
    const now = new Date().toISOString();

    this.database.connection
      .prepare(`insert into projects (id, name, path, created_at, updated_at) values (?, ?, ?, ?, ?)`)
      .run(id, name, resolved, now, now);

    this.timeline.append({
      event_type: 'project.created',
      project_id: id,
      actor_type: input.actor_type,
      actor_id: input.actor_id,
      metadata: { name, path: resolved }
    });

    return { project_id: id, name, path: resolved, existed: false };
  }
}
