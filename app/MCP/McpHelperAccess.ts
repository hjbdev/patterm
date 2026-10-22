import type { DatabaseService } from '../Services/DatabaseService';
import type { McpHelperCaller } from './McpSocketServer';

// Set once by a migration: agents started before it run helpers that carry
// no identity.
export const MCP_HELPER_CUTOVER_KEY = 'mcp.helper_identity_cutover.v1';

// Header helpers and bridges run inside a harness, so they may use only the
// MCP servers assigned to it. Helpers of agents launched before the cutover
// keep working until those agents exit.
export class McpHelperAccess {
  constructor(
    private readonly database: DatabaseService,
    private readonly isOpenCodeBridge: (token: unknown) => boolean,
    private readonly launching: LaunchingMcpIdentities = new LaunchingMcpIdentities()
  ) {}

  // The caller's harness, or null for a helper started before the cutover.
  harness(caller: McpHelperCaller): string | null {
    if (caller.opencodeBridge !== undefined) {
      if (!this.isOpenCodeBridge(caller.opencodeBridge)) throw new Error('Invalid OpenCode bridge identity');
      return 'opencode';
    }
    if (caller.identity) {
      const launching = this.launching.harness(caller.identity);
      if (launching) return launching;
      const row = this.database.connection.prepare('select harness from sessions where mcp_identity = ? and exited_at is null')
        .get(caller.identity) as { harness: string } | undefined;
      if (!row) throw new Error('Unknown or inactive agent identity');
      return row.harness;
    }
    if (this.earlierAgentsRunning()) return null;
    throw new Error('MCP server helper has no Patterm agent identity. Restart the agent from Patterm.');
  }

  private earlierAgentsRunning(): boolean {
    const cutover = this.database.connection.prepare('select value from settings where key = ?').get(MCP_HELPER_CUTOVER_KEY) as { value: string } | undefined;
    if (!cutover) return false;
    return Boolean(this.database.connection.prepare('select 1 from sessions where exited_at is null and started_at < ? limit 1').get(cutover.value));
  }
}

// Identities of launches still starting. Integrated harnesses start their MCP
// helpers before Patterm registers the session, so those helpers are
// recognised from the moment the identity is made.
export class LaunchingMcpIdentities {
  private readonly launching = new Map<string, { harness: string; role: string | null; sandbox?: string }>();

  reserve(identity: string, harness: string, role: string | null = null): () => void {
    this.launching.set(identity, { harness, role });
    return () => { this.launching.delete(identity); };
  }

  harness(identity: string): string | null {
    return this.launching.get(identity)?.harness ?? null;
  }

  role(identity: string): string | null {
    return this.launching.get(identity)?.role ?? null;
  }

  // A harness lists its tools while it starts, before its session exists,
  // so a sandboxed launch names its sandbox here.
  attachSandbox(identity: string, sandboxId: string): void {
    const entry = this.launching.get(identity);
    if (entry) entry.sandbox = sandboxId;
  }

  sandbox(identity: string): string | null {
    return this.launching.get(identity)?.sandbox ?? null;
  }
}
