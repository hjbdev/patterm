import type { McpServerActions } from '../Actions/McpServerActions';
import type { McpToolRegistry } from './ToolRegistry';

// Hidden owner tools behind Settings → MCP servers. Agents cannot see them.
export const MCP_SERVER_TOOLS = [
  'patterm.mcp_servers.list', 'patterm.mcp_servers.save', 'patterm.mcp_servers.delete', 'patterm.mcp_servers.import',
  'patterm.mcp_servers.test', 'patterm.mcp_servers.signin.start', 'patterm.mcp_servers.signin.complete',
  'patterm.mcp_servers.signin.cancel', 'patterm.mcp_servers.signout', 'patterm.mcp.callback.paste'
] as const;

export function registerMcpServerTools(registry: McpToolRegistry, actions: McpServerActions): void {
  // Sign-in state changes are announced by the OAuth service itself.
  const hidden = (name: typeof MCP_SERVER_TOOLS[number], description: string, changesServers: boolean, handler: (args: unknown) => unknown) => {
    registry.register({ name, namespace: 'settings', description, hidden: true, changes: changesServers ? ['mcp-servers'] : [], inputSchema: { type: 'object' } }, (args) => handler(args));
  };
  hidden('patterm.mcp_servers.list', 'List global MCP servers and their sign-in status.', false, () => actions.list());
  hidden('patterm.mcp_servers.save', 'Add or update a global MCP server.', true, (args) => actions.save(args));
  hidden('patterm.mcp_servers.delete', 'Remove a global MCP server.', true, (args) => actions.delete(args));
  hidden('patterm.mcp_servers.import', 'Import MCP servers from the harnesses\' own configuration.', true, () => actions.import());
  hidden('patterm.mcp_servers.test', 'Connect to a global MCP server and list its tools.', false, (args) => actions.test(args));
  hidden('patterm.mcp_servers.signin.start', 'Start signing in to a remote MCP server.', false, (args) => actions.startSignIn(args));
  hidden('patterm.mcp_servers.signin.complete', 'Finish a sign-in with the address the browser was sent to.', false, (args) => actions.completeSignIn(args));
  hidden('patterm.mcp_servers.signin.cancel', 'Cancel a sign-in in progress.', false, (args) => actions.cancelSignIn(args));
  hidden('patterm.mcp_servers.signout', 'Forget a remote MCP server\'s tokens.', false, (args) => actions.signOut(args));
  hidden('patterm.mcp.callback.paste', 'Finish a sign-in from a pasted redirect address, if it belongs to one.', false, (args) => actions.pasteCallback(args));
}
