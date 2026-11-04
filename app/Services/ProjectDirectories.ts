import fs from 'node:fs';
import type { SqliteConnection } from '../Database/SqliteConnection';
import { pathContains } from '../Platform/PathIdentity';

// Where an agent runs decides its worktree. A native session can move to
// another directory (OpenCode's session_move), so a recorded worktree ID only
// holds while the directory still lies in that worktree.

export interface ProjectWorktree {
  id: string;
  worktree_path: string;
}

// The registered project worktree a directory lies in, the innermost when
// worktrees nest. Unregistered directories have none: Patterm never registers
// a worktree as a side effect. A launch passes `live` to skip worktrees whose
// directory is gone; history keeps them.
export function projectWorktreeAt(connection: SqliteConnection, projectId: string, directory: string, live = true): ProjectWorktree | null {
  const rows = connection.prepare('select id, worktree_path from worktrees where project_id = ?').all(projectId) as unknown as ProjectWorktree[];
  const target = realDirectory(directory);
  return rows
    .flatMap((row) => {
      if (live && !isDirectory(row.worktree_path)) return [];
      const root = containingRoot(row.worktree_path, directory, target);
      return root === null ? [] : [{ row, depth: root.length }];
    })
    .sort((a, b) => b.depth - a.depth)[0]?.row ?? null;
}

// The recorded worktree when the directory still lies in it, otherwise the
// registered worktree the directory has moved into, if any.
export function worktreeForDirectory(connection: SqliteConnection, projectId: string, worktreeId: string | null, directory: string, live = true): ProjectWorktree | null {
  const recorded = worktreeId
    ? connection.prepare('select id, worktree_path from worktrees where id = ? and project_id = ?').get(worktreeId, projectId) as ProjectWorktree | undefined
    : undefined;
  if (recorded && (!live || isDirectory(recorded.worktree_path)) && containingRoot(recorded.worktree_path, directory, realDirectory(directory)) !== null) return recorded;
  return projectWorktreeAt(connection, projectId, directory, live);
}

// True when the directory lies in the project or one of its registered
// worktrees once symlinks are resolved, so a link cannot lead outside.
export function withinProject(connection: SqliteConnection, projectId: string, directory: string): boolean {
  const target = realDirectory(directory);
  if (!target) return false;
  const project = connection.prepare('select path from projects where id = ?').get(projectId) as { path: string } | undefined;
  const worktrees = connection.prepare('select worktree_path from worktrees where project_id = ?').all(projectId) as unknown as Array<{ worktree_path: string }>;
  return [project?.path, ...worktrees.map((row) => row.worktree_path)].some((root) => {
    const real = root ? realDirectory(root) : null;
    return real !== null && pathContains(real, target);
  });
}

// The root as compared when it contains the directory, or null. Symlinks
// resolve when both exist; history of removed directories compares as written.
function containingRoot(root: string, directory: string, realTarget: string | null): string | null {
  const realRoot = realTarget ? realDirectory(root) : null;
  if (realRoot && realTarget) return pathContains(realRoot, realTarget) ? realRoot : null;
  return pathContains(root, directory) ? root : null;
}

export function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

// Roots and targets resolve with the same function: realpathSync and
// promises.realpath can disagree about Windows 8.3 names.
function realDirectory(candidate: string): string | null {
  try {
    return isDirectory(candidate) ? fs.realpathSync.native(candidate) : null;
  } catch {
    return null;
  }
}
