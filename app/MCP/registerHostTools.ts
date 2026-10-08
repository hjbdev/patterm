import type { HostActions } from '../Actions/HostActions';
import type { ProjectLinkActions } from '../Actions/ProjectLinkActions';
import type { McpToolRegistry } from './ToolRegistry';

export const HOST_TOOLS = [
  'patterm.hosts.get', 'patterm.hosts.rename', 'patterm.hosts.pair', 'patterm.hosts.unpair',
  'patterm.hosts.code.create', 'patterm.hosts.code.cancel', 'patterm.hosts.show_agents',
  'patterm.hosts.projects', 'patterm.hosts.link', 'patterm.hosts.unlink'
] as const;

// Owner-only controls for pairing hosts. They are hidden, so agents cannot
// pair, unpair, or issue credentials.
export function registerHostTools(registry: McpToolRegistry, hosts: HostActions, projects: ProjectLinkActions) {
  const tool = (name: typeof HOST_TOOLS[number], description: string, changes: Array<'settings' | 'workbench'>, required: string[] = []) =>
    ({ name, namespace: 'hosts', description, hidden: true, changes, inputSchema: { type: 'object', required } });
  registry.register(tool('patterm.hosts.get', 'Read this host, its paired hosts, and the hosts allowed to connect to it.', []), () => hosts.overview());
  registry.register(tool('patterm.hosts.rename', 'Rename this host.', ['settings', 'workbench'], ['name']), (args) => hosts.rename(args));
  registry.register(tool('patterm.hosts.pair', 'Pair with another host using the code it shows.', ['settings', 'workbench'], ['url', 'code']), (args) => hosts.pair(args));
  registry.register(tool('patterm.hosts.unpair', 'Unpair a host on both sides.', ['settings', 'workbench'], ['host_id']), (args) => hosts.unpair(args));
  registry.register(tool('patterm.hosts.show_agents', 'Show or hide a paired host\'s agents on this host.', ['settings', 'workbench'], ['host_id', 'show_agents']), (args) => hosts.setShowAgents(args));
  registry.register(tool('patterm.hosts.code.create', 'Show a one-time code another host can pair with.', []), () => hosts.createPairingCode());
  registry.register(tool('patterm.hosts.projects', 'List this host\'s and a connected host\'s projects, their links, and suggested links.', [], ['host_id']), (args) => projects.projects(args));
  registry.register(tool('patterm.hosts.link', 'Link a project to a project on a connected host.', ['settings', 'workbench'], ['host_id', 'project_id', 'remote_project_id']), (args) => projects.link(args));
  registry.register(tool('patterm.hosts.unlink', 'Unlink a project from a paired host\'s project.', ['settings', 'workbench'], ['host_id', 'project_id']), (args) => projects.unlink(args));
  registry.register(tool('patterm.hosts.code.cancel', 'Discard the current pairing code.', []), () => { hosts.cancelPairingCode(); return { ok: true }; });
}
