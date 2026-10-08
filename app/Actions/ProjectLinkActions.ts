import { z } from 'zod';
import type { HostService } from '../Services/HostService';
import type { PeerLinkService } from '../Services/PeerLinkService';
import type { LinkableProject, ProjectLink, ProjectLinkService } from '../Services/ProjectLinkService';

const id = z.string().min(1).max(200);
const hostIdInput = z.object({ host_id: id }).strict();
const linkInput = z.object({ host_id: id, project_id: id, remote_project_id: id }).strict();
const unlinkInput = z.object({ host_id: id, project_id: id }).strict();

// Peer methods: the caller's own project and ours.
const remoteProjectList = z.array(z.object({ id, name: z.string().min(1).max(200), path: z.string().max(4096), git_remote: z.string().max(1000).nullable() })).max(1000);
const peerLinkInput = z.object({ project_id: id, remote_project_id: id, remote_project_name: z.string().min(1).max(200) }).strict();
const peerUnlinkInput = z.object({ project_id: id, remote_project_id: id }).strict();

export interface HostProjects {
  host_id: string;
  local: LinkableProject[];
  remote: LinkableProject[];
  links: ProjectLink[];
  // Unlinked local projects whose git remote matches exactly one unlinked
  // remote project.
  suggestions: Array<{ project_id: string; remote_project_id: string }>;
}

// Links a local project to a project on a paired host. Both hosts record the
// link, so linking needs the other host to be connected.
export class ProjectLinkActions {
  constructor(
    private readonly links: ProjectLinkService,
    private readonly hosts: HostService,
    private readonly peers: PeerLinkService,
    private readonly onChange: () => void = () => undefined
  ) {
    peers.handle('projects.list', () => this.links.projects());
    peers.handle('projects.link', (raw, peer) => {
      const input = peerLinkInput.parse(raw);
      const link = this.links.link(peer.host_id, input.project_id, { id: input.remote_project_id, name: input.remote_project_name });
      this.onChange();
      return { project_name: link.project_name };
    });
    peers.handle('projects.unlink', (raw, peer) => {
      const input = peerUnlinkInput.parse(raw);
      if (this.links.localProjectFor(peer.host_id, input.remote_project_id) === input.project_id) this.links.unlink(peer.host_id, input.project_id);
      this.onChange();
      return { ok: true };
    });
  }

  async projects(raw: unknown): Promise<HostProjects> {
    const { host_id } = hostIdInput.parse(raw);
    this.requirePeer(host_id);
    const [local, remote] = await Promise.all([this.links.projects(), this.remoteProjects(host_id)]);
    this.links.refreshRemoteNames(host_id, remote);
    const links = this.links.links(host_id);
    const linkedLocal = new Set(links.map((link) => link.project_id));
    const linkedRemote = new Set(links.map((link) => link.remote_project_id));
    const suggestions: HostProjects['suggestions'] = [];
    for (const project of local) {
      if (linkedLocal.has(project.id) || !project.git_remote) continue;
      const matches = remote.filter((candidate) => !linkedRemote.has(candidate.id) && candidate.git_remote === project.git_remote);
      if (matches.length === 1) suggestions.push({ project_id: project.id, remote_project_id: matches[0]!.id });
    }
    return { host_id, local, remote, links, suggestions };
  }

  async link(raw: unknown): Promise<ProjectLink[]> {
    const input = linkInput.parse(raw);
    const peer = this.requirePeer(input.host_id);
    const remote = (await this.remoteProjects(input.host_id)).find((project) => project.id === input.remote_project_id);
    if (!remote) throw new Error(`That project no longer exists on ${peer.name}.`);
    const local = (await this.links.projects()).find((project) => project.id === input.project_id);
    if (!local) throw new Error('That project does not exist.');
    // The other host records its half first, so a refusal there changes
    // nothing here.
    await this.peers.request(input.host_id, 'projects.link', { project_id: remote.id, remote_project_id: local.id, remote_project_name: local.name });
    this.links.link(input.host_id, local.id, remote);
    this.onChange();
    return this.links.links(input.host_id);
  }

  // Unlinks here, and on the other host when it is connected.
  async unlink(raw: unknown): Promise<ProjectLink[]> {
    const input = unlinkInput.parse(raw);
    const link = this.links.links(input.host_id).find((candidate) => candidate.project_id === input.project_id);
    if (!link) return this.links.links(input.host_id);
    if (this.peers.connected(input.host_id)) {
      await this.peers.request(input.host_id, 'projects.unlink', { project_id: link.remote_project_id, remote_project_id: link.project_id }).catch(() => undefined);
    }
    this.links.unlink(input.host_id, input.project_id);
    this.onChange();
    return this.links.links(input.host_id);
  }

  private requirePeer(hostId: string) {
    const peer = this.hosts.peer(hostId);
    if (!peer) throw new Error('That host is not paired.');
    return peer;
  }

  private async remoteProjects(hostId: string): Promise<LinkableProject[]> {
    return remoteProjectList.parse(await this.peers.request(hostId, 'projects.list'));
  }
}
