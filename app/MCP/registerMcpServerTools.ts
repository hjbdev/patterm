import type { McpServerActions } from '../Actions/McpServerActions';
import type { McpToolRegistry } from './ToolRegistry';

// Hidden owner tools behind Settings → MCP servers. Agents cannot see them.
export const MCP_SERVER_TOOLS = [
  'mcp_servers_list', 'mcp_servers_save', 'mcp_servers_delete', 'mcp_servers_import',
  'mcp_servers_test', 'mcp_servers_signin_start', 'mcp_servers_signin_complete',
  'mcp_servers_signin_cancel', 'mcp_servers_signout', 'mcp_callback_paste'
] as const;

export function registerMcpServerTools(registry: McpToolRegistry, actions: McpServerActions): void {
  // Sign-in state changes are announced by the OAuth service itself.
  const hidden = (name: typeof MCP_SERVER_TOOLS[number], description: string, changesServers: boolean, handler: (args: unknown) => unknown) => {
    registry.register({ name, namespace: 'settings', description, hidden: true, changes: changesServers ? ['mcp-servers'] : [], inputSchema: { type: 'object' } }, (args) => handler(args));
  };
  hidden('mcp_servers_list', 'List global MCP servers and their sign-in status.', false, () => actions.list());
  hidden('mcp_servers_save', 'Add or update a global MCP server.', true, (args) => actions.save(args));
  hidden('mcp_servers_delete', 'Remove a global MCP server.', true, (args) => actions.delete(args));
  hidden('mcp_servers_import', 'Import MCP servers from the harnesses\' own configuration.', true, () => actions.import());
  hidden('mcp_servers_test', 'Connect to a global MCP server and list its tools.', false, (args) => actions.test(args));
  hidden('mcp_servers_signin_start', 'Start signing in to a remote MCP server.', false, (args) => actions.startSignIn(args));
  hidden('mcp_servers_signin_complete', 'Finish a sign-in with the address the browser was sent to.', false, (args) => actions.completeSignIn(args));
  hidden('mcp_servers_signin_cancel', 'Cancel a sign-in in progress.', false, (args) => actions.cancelSignIn(args));
  hidden('mcp_servers_signout', 'Forget a remote MCP server\'s tokens.', false, (args) => actions.signOut(args));
  hidden('mcp_callback_paste', 'Finish a sign-in from a pasted redirect address, if it belongs to one.', false, (args) => actions.pasteCallback(args));
}
