import type { DatabaseService } from './DatabaseService';
import type { GitService } from './GitService';

export interface LinkableProject {
  id: string;
  name: string;
  path: string;
  // The `origin` remote, normalised so SSH and HTTPS forms match. Null for a
  // directory that is not a repository or has no origin.
  git_remote: string | null;
}

export interface ProjectLink {
  host_id: string;
  project_id: string;
  project_name: string;
  remote_project_id: string;
  remote_project_name: string;
  created_at: string;
}

// `git@github.com:Org/Repo.git`, `ssh://git@github.com/Org/Repo` and
// `https://github.com/Org/Repo.git` all become `github.com/org/repo`.
export function normaliseGitRemote(value: string): string | null {
  let remote = value.trim();
  if (!remote) return null;
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(remote);
  if (scp) remote = `${scp[1]}/${scp[2]}`;
  else {
    try {
      const url = new URL(remote);
      remote = `${url.hostname}${url.port && !['22', '443', '80'].includes(url.port) ? `:${url.port}` : ''}${url.pathname}`;
    } catch {
      return null;
    }
  }
  return remote.replace(/\.git\/?$/, '').replace(/\/+$/, '').toLowerCase() || null;
}

export class ProjectLinkService {
  constructor(private readonly database: DatabaseService, private readonly git: GitService, private readonly now: () => number = Date.now) {}

  // Only repository projects link. Each host's Personal project is its own
  // folder, so it shows on other hosts on its own instead.
  async projects(): Promise<LinkableProject[]> {
    const rows = this.database.connection.prepare(`select id, name, path from projects where kind = 'workspace' and removed_at is null order by name collate nocase`).all() as Array<{ id: string; name: string; path: string }>;
    return Promise.all(rows.map(async (row) => {
      const url = await this.git.query(row.path, ['remote', 'get-url', 'origin']).catch(() => null);
      return { ...row, git_remote: url ? normaliseGitRemote(url) : null };
    }));
  }

  links(hostId?: string): ProjectLink[] {
    return this.database.connection.prepare(`select project_links.*, projects.name as project_name from project_links
      join projects on projects.id = project_links.project_id
      where ? is null or project_links.host_id = ? order by projects.name collate nocase`).all(hostId ?? null, hostId ?? null) as unknown as ProjectLink[];
  }

  link(hostId: string, projectId: string, remote: { id: string; name: string }): ProjectLink {
    const db = this.database.connection;
    const project = db.prepare(`select id from projects where id = ? and kind = 'workspace' and removed_at is null`).get(projectId);
    if (!project) throw new Error('That project does not exist.');
    const clash = db.prepare('select project_id from project_links where host_id = ? and remote_project_id = ? and project_id <> ?').get(hostId, remote.id, projectId);
    if (clash) throw new Error(`${remote.name} is already linked to another project here.`);
    db.prepare(`insert into project_links(host_id, project_id, remote_project_id, remote_project_name, created_at) values(?, ?, ?, ?, ?)
      on conflict(host_id, project_id) do update set remote_project_id = excluded.remote_project_id, remote_project_name = excluded.remote_project_name`)
      .run(hostId, projectId, remote.id, remote.name.slice(0, 200), new Date(this.now()).toISOString());
    return this.links(hostId).find((link) => link.project_id === projectId)!;
  }

  unlink(hostId: string, projectId: string): boolean {
    return Number(this.database.connection.prepare('delete from project_links where host_id = ? and project_id = ?').run(hostId, projectId).changes) > 0;
  }

  // The local project linked to a peer's project, if any.
  localProjectFor(hostId: string, remoteProjectId: string): string | null {
    return (this.database.connection.prepare('select project_id from project_links where host_id = ? and remote_project_id = ?').get(hostId, remoteProjectId) as { project_id: string } | undefined)?.project_id ?? null;
  }

  // Keeps remote names current when the peer lists its projects.
  refreshRemoteNames(hostId: string, projects: ReadonlyArray<{ id: string; name: string }>): void {
    const update = this.database.connection.prepare('update project_links set remote_project_name = ? where host_id = ? and remote_project_id = ? and remote_project_name <> ?');
    for (const project of projects) update.run(project.name.slice(0, 200), hostId, project.id, project.name.slice(0, 200));
  }
}
