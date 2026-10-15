import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { expandHome } from './ListDirectoriesAction';
import { pathColumn, pathParam, pathsMatch, storedPath } from '../Platform/PathIdentity';
import { isUserProjectKind, USER_PROJECT_KINDS_SQL } from '../Services/PersonalProject';
import type { DatabaseService } from '../Services/DatabaseService';
import type { TimelineService } from '../Services/TimelineService';

export const createProjectInput = z.object({
  path: z.string().min(1),
  name: z.string().default(''),
  // Creates the directory first when it is missing. Its parent must exist,
  // so a mistyped parent fails instead of creating a stray tree.
  create_directory: z.boolean().optional(),
  actor_type: z.enum(['user', 'agent', 'system']).default('user'),
  actor_id: z.string().nullable().default(null)
});

export type CreateProjectInput = z.infer<typeof createProjectInput>;

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  kind: string;
}

// Registers a local project rooted at a real filesystem path. Re-registering an
// existing path returns the existing project rather than duplicating it.
export class CreateProjectAction {
  constructor(
    private readonly database: DatabaseService,
    private readonly timeline: TimelineService,
    private readonly home: string = os.homedir()
  ) {}

  execute(input: CreateProjectInput): { project_id: string; name: string; path: string; existed: boolean; created_directory: boolean } {
    const requested = expandHome(input.path, this.home);
    // A relative path would resolve against the server's working directory.
    if (!path.isAbsolute(requested)) throw new Error(`path must be absolute or start with ~/: ${input.path}`);
    const resolved = storedPath(path.resolve(requested));

    let createdDirectory = false;
    if (input.create_directory) {
      try {
        fs.mkdirSync(resolved);
        createdDirectory = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') throw new Error(`parent directory does not exist: ${path.dirname(resolved)}`);
        if (code !== 'EEXIST') throw error;
      }
    }

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
      .prepare(`select id, name, path, kind from projects where ${pathColumn('path')} = ?`)
      .get(pathParam(resolved)) as ProjectRow | undefined;
    if ((existing && !isUserProjectKind(existing.kind)) || this.isInternalDirectory(resolved)) throw new Error(`path belongs to Patterm's internal project: ${resolved}`);
    if (existing) {
      return { project_id: existing.id, name: existing.name, path: existing.path, existed: true, created_directory: createdDirectory };
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
      metadata: { name, path: resolved, created_directory: createdDirectory }
    });

    return { project_id: id, name, path: resolved, existed: false, created_directory: createdDirectory };
  }

  // Compares real paths, so a symlink cannot alias an internal project's folder.
  private isInternalDirectory(resolved: string): boolean {
    const real = (target: string) => { try { return fs.realpathSync(target); } catch { return null; } };
    const target = real(resolved);
    const internal = this.database.connection.prepare(`select path from projects where kind not in ${USER_PROJECT_KINDS_SQL}`).all() as Array<{ path: string }>;
    return internal.some((project) => pathsMatch(real(project.path), target));
  }
}
