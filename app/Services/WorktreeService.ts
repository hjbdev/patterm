import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DatabaseService } from './DatabaseService';
import type { TimelineService } from './TimelineService';
import type { WorkbenchRepository } from '../Repositories/WorkbenchRepository';
import { GitService } from './GitService';
import { pathsMatch, storedPath } from '../Platform/PathIdentity';
import { normalizePath } from '../Platform/Paths';

// Git would read a base ref or branch starting with "-" as an option.
export const worktreeCreateInput = z.object({
  name: z.string().trim().min(1),
  project_id: z.string().min(1),
  repo_path: z.string().optional(),
  base_ref: z.string().min(1).refine((value) => !value.startsWith('-'), 'base_ref cannot start with "-"').default('HEAD'),
  branch: z.string().refine((value) => !value.trim().startsWith('-'), 'branch cannot start with "-"').optional(),
  worktree_path: z.string().optional(),
  actor_type: z.enum(['user', 'agent', 'system']).default('user'),
  actor_id: z.string().nullable().default(null)
});

export const worktreeLinkInput = z.object({
  project_id: z.string().min(1),
  worktree_path: z.string().min(1),
  repo_path: z.string().optional(),
  branch: z.string().nullable().optional(),
  actor_type: z.enum(['user', 'agent', 'system']).default('user'),
  actor_id: z.string().nullable().default(null)
});

export const worktreeListInput = z.object({
  project_id: z.string().optional()
});

export const worktreeAbandonInput = z.object({
  worktree_id: z.string().min(1),
  actor_type: z.enum(['user', 'agent', 'system']).default('user'),
  actor_id: z.string().nullable().default(null)
});

export type WorktreeCreateInput = z.input<typeof worktreeCreateInput>;
export type WorktreeLinkInput = z.input<typeof worktreeLinkInput>;
export type WorktreeListInput = z.input<typeof worktreeListInput>;
export type WorktreeAbandonInput = z.input<typeof worktreeAbandonInput>;

interface WorktreeRow {
  id: string;
  project_id: string;
  repo_path: string;
  worktree_path: string;
  branch: string | null;
  created_by: string;
  created_at: string;
}

export class WorktreeService {
  constructor(
    private readonly deps: {
      database: DatabaseService;
      timeline: TimelineService;
      workbench: WorkbenchRepository;
      git?: GitService;
      // The project whose sandbox holds a path; git there runs in that sandbox.
      sandboxOwner?: (path: string) => string | null;
      // Whether a worktree has a sandbox, which needs it registered.
      hasSandbox?: (worktreeId: string) => boolean;
    }
  ) {}

  async create(raw: WorktreeCreateInput) {
    const input = worktreeCreateInput.parse(raw);
    const project = this.project(input.project_id);
    const requestedRepoPath = input.repo_path ?? project.path;
    if (!requestedRepoPath) {
      throw new Error(`project ${project.id} has no path`);
    }
    this.refuseOtherSandbox(input.project_id, requestedRepoPath, input.worktree_path);

    const git = this.deps.git ?? new GitService();
    const repoPath = storedPath(await git.root(requestedRepoPath));
    const friendlyId = slug(input.name);
    const branch = input.branch?.trim() || `patterm/${friendlyId}`;
    const worktreePath = normalizePath(input.worktree_path ?? path.join(repoPath, '.worktrees', friendlyId));
    // The repository git resolved is where the next commands run.
    this.refuseOtherSandbox(input.project_id, repoPath, worktreePath);

    if (fs.existsSync(worktreePath)) {
      throw new Error(`worktree path already exists: ${worktreePath}`);
    }

    await git.run(repoPath, ['worktree', 'add', '-b', branch, '--', worktreePath, input.base_ref]);
    await ensureWorktreesIgnored(git, repoPath);

    return this.insert({
      projectId: input.project_id,
      repoPath,
      worktreePath,
      branch,
      createdBy: input.actor_id ?? input.actor_type,
      eventType: 'worktree.created',
      actorType: input.actor_type,
      actorId: input.actor_id
    });
  }

  async link(raw: WorktreeLinkInput) {
    const input = worktreeLinkInput.parse(raw);
    this.project(input.project_id);
    const worktreePath = normalizePath(input.worktree_path);
    if (!fs.existsSync(worktreePath) || !fs.statSync(worktreePath).isDirectory()) {
      throw new Error(`worktree path is not a directory: ${worktreePath}`);
    }
    // Linking a directory the project already registers returns that
    // registration, including when either path goes through a symlink.
    const realPath = fs.realpathSync(worktreePath);
    const registered = this.deps.database.connection
      .prepare('select * from worktrees where project_id = ? order by created_at')
      .all(input.project_id) as WorktreeRow[];
    const existing = registered.find((row) => pathsMatch(row.worktree_path, worktreePath) || pathsMatch(realPathOrNull(row.worktree_path), realPath));
    if (existing) {
      return { worktree: mapWorktree(existing) };
    }
    this.refuseOtherSandbox(input.project_id, worktreePath, realPath, input.repo_path);

    const git = this.deps.git ?? new GitService();
    const repoPath = storedPath(input.repo_path ? await git.root(input.repo_path) : await git.root(worktreePath));
    this.refuseOtherSandbox(input.project_id, repoPath);
    const branch = input.branch === undefined ? await git.branch(worktreePath) : input.branch;

    return this.insert({
      projectId: input.project_id,
      repoPath,
      worktreePath,
      branch: branch ?? null,
      createdBy: input.actor_id ?? input.actor_type,
      eventType: 'worktree.linked',
      actorType: input.actor_type,
      actorId: input.actor_id
    });
  }

  list(raw: WorktreeListInput) {
    const input = worktreeListInput.parse(raw);
    const db = this.deps.database.connection;
    const rows = input.project_id
        ? db.prepare(`select * from worktrees where project_id = ? order by created_at asc`).all(input.project_id)
        : db.prepare(`select * from worktrees order by created_at asc`).all();

    return { worktrees: (rows as WorktreeRow[]).map(mapWorktree) };
  }

  abandon(raw: WorktreeAbandonInput) {
    const input = worktreeAbandonInput.parse(raw);
    const db = this.deps.database.connection;
    const row = db.prepare(`select * from worktrees where id = ?`).get(input.worktree_id) as WorktreeRow | undefined;
    if (!row) {
      throw new Error(`unknown worktree: ${input.worktree_id}`);
    }
    // Its sandbox finds its agents through this registration.
    if (this.deps.hasSandbox?.(row.id)) throw new Error('Delete this worktree\'s sandbox in Settings › Sandboxes before abandoning it');

    db.transaction(() => {
      // sessions.worktree_id has no FK. Process and historical diff snapshot FKs
      // clear their links, and session worktree links cascade.
      db.prepare('update sessions set worktree_id = null where worktree_id = ?').run(row.id);
      db.prepare('delete from worktrees where id = ?').run(row.id);
      this.deps.timeline.append({
        event_type: 'worktree.abandoned',
        project_id: row.project_id,
        actor_type: input.actor_type,
        actor_id: input.actor_id,
        metadata: { worktree_id: row.id, worktree_path: row.worktree_path, branch: row.branch }
      });
    })();

    return { worktree_id: row.id, abandoned: true, deleted: false };
  }

  // Git for a path inside a sandbox runs in that sandbox, so another
  // project's agents cannot name one.
  private refuseOtherSandbox(projectId: string, ...paths: Array<string | undefined>): void {
    for (const target of paths) {
      const owner = target ? this.deps.sandboxOwner?.(storedPath(normalizePath(target))) : null;
      if (owner && owner !== projectId) throw new Error('This directory is another project\'s sandboxed worktree');
    }
  }

  get(worktreeId: string): WorktreeRow {
    const row = this.deps.database.connection.prepare(`select * from worktrees where id = ?`).get(worktreeId) as
      | WorktreeRow
      | undefined;
    if (!row) {
      throw new Error(`unknown worktree: ${worktreeId}`);
    }
    return row;
  }

  private insert(input: {
    projectId: string;
    repoPath: string;
    worktreePath: string;
    branch: string | null;
    createdBy: string;
    eventType: string;
    actorType: 'user' | 'agent' | 'system';
    actorId: string | null;
  }) {
    const id = `worktree_${randomUUID()}`;
    const now = new Date().toISOString();
    const db = this.deps.database.connection;

    db.transaction(() => {
      db.prepare(
        `insert into worktrees (id, project_id, repo_path, worktree_path, branch, created_by, created_at)
         values (?, ?, ?, ?, ?, ?, ?)`
      ).run(id, input.projectId, input.repoPath, input.worktreePath, input.branch, input.createdBy, now);

      this.deps.timeline.append({
        event_type: input.eventType,
        project_id: input.projectId,
        actor_type: input.actorType,
        actor_id: input.actorId,
        metadata: { worktree_id: id, repo_path: input.repoPath, worktree_path: input.worktreePath, branch: input.branch }
      });
    })();

    return {
      worktree: mapWorktree({
        id,
        project_id: input.projectId,
        repo_path: input.repoPath,
        worktree_path: input.worktreePath,
        branch: input.branch,
        created_by: input.createdBy,
        created_at: now
      })
    };
  }

  private project(projectId: string) {
    const project = this.deps.workbench.getProject(projectId);
    if (!project) throw new Error(`unknown project: ${projectId}`);
    return project;
  }
}

async function ensureWorktreesIgnored(git: GitService, repoPath: string): Promise<void> {
  const commonDirRaw = (await git.run(repoPath, ['rev-parse', '--git-common-dir'])).stdout.trim();
  const commonDir = path.isAbsolute(commonDirRaw) ? commonDirRaw : path.resolve(repoPath, commonDirRaw);
  const excludePath = path.join(commonDir, 'info', 'exclude');
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  const current = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
  if (!current.split(/\r?\n/).includes('/.worktrees/')) {
    fs.appendFileSync(excludePath, `${current.endsWith('\n') || current.length === 0 ? '' : '\n'}/.worktrees/\n`);
  }
}

function realPathOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'worktree';
}

function mapWorktree(row: WorktreeRow) {
  return {
    id: row.id,
    repoPath: row.repo_path,
    worktreePath: row.worktree_path,
    branch: row.branch
  };
}
