export interface PeerLinkStatus {
  state: 'connected' | 'connecting' | 'offline';
  error: string | null;
  since: string;
}

// A paired host. This host dials an `outbound` peer; an `inbound` peer dials
// this host.
export interface PeerHost {
  host_id: string;
  name: string;
  direction: 'outbound' | 'inbound';
  url: string | null;
  grant_id: string | null;
  show_agents: boolean;
  created_at: string;
  last_connected_at: string | null;
  last_error: string | null;
  link: PeerLinkStatus;
  projects: ProjectLink[];
}

export interface ProjectLink {
  host_id: string;
  project_id: string;
  project_name: string;
  remote_project_id: string;
  remote_project_name: string;
  created_at: string;
}

export interface LinkableProject { id: string; name: string; path: string; git_remote: string | null }

export interface HostProjects {
  host_id: string;
  local: LinkableProject[];
  remote: LinkableProject[];
  links: ProjectLink[];
  suggestions: Array<{ project_id: string; remote_project_id: string }>;
}

export interface HostOverview {
  self: { host_id: string; name: string };
  accepts_pairing: boolean;
  pairing_blocked: string | null;
  password_set: boolean;
  peers: PeerHost[];
}

export interface PairingCode { code: string; expires_at: string }

const call = <T>(tool: string, args: Record<string, unknown> = {}) => window.patterm.call(tool, args) as Promise<T>;

export const readHosts = () => call<HostOverview>('hosts_get');
export const renameHost = (name: string) => call<HostOverview>('hosts_rename', { name });
export const pairHost = (url: string, code: string) => call<HostOverview>('hosts_pair', { url, code });
export const unpairHost = (hostId: string) => call<HostOverview>('hosts_unpair', { host_id: hostId });
export const setShowAgents = (hostId: string, show: boolean) => call<HostOverview>('hosts_show_agents', { host_id: hostId, show_agents: show });
export const createPairingCode = () => call<PairingCode>('hosts_code_create');
export const cancelPairingCode = () => call<{ ok: true }>('hosts_code_cancel');
export const readHostProjects = (hostId: string) => call<HostProjects>('hosts_projects', { host_id: hostId });
export const linkProject = (hostId: string, projectId: string, remoteProjectId: string) => call<ProjectLink[]>('hosts_link', { host_id: hostId, project_id: projectId, remote_project_id: remoteProjectId });
export const unlinkProject = (hostId: string, projectId: string) => call<ProjectLink[]>('hosts_unlink', { host_id: hostId, project_id: projectId });

// Names an agent or process on a paired host, for labels without room for a
// separate host marker.
export const hostLabel = (name: string, host?: string) => host ? `${name} on ${host}` : name;
