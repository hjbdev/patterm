import { linkLabel } from '../../Composables/useSessionContext';
import { queuePeek, type Peek } from '../../lib/peek';
import { phoneLayout } from '../../lib/phoneLayout';
import { contextRead, type SessionContext } from '../../lib/projectContext';
import { familyServers, type ServerEntry } from '../../lib/servers';
import { sendWorkspaceRequest } from '../../lib/workspaceRequests';
import type { ProcessRecord, SessionRecord } from '../../types';
import { familyTabOf, type AgentTab, type SidebarContext } from './sidebarContext';

// The agent that started a server, and the list row it belongs to.
export function serverOwner(sidebar: SidebarContext, process: ProcessRecord): { tab: AgentTab; session: SessionRecord } | null {
  if (!process.parentProcessId || process.host) return null;
  const tab = familyTabOf(sidebar, { processId: process.id });
  const session = tab?.family.options.find((option) => option.session.processId === process.parentProcessId)?.session;
  return tab && session ? { tab, session } : null;
}

// The server paired with the owner's preview link that names its port.
export async function serverPreview(sidebar: SidebarContext, process: ProcessRecord, owner: { tab: AgentTab; session: SessionRecord }): Promise<ServerEntry | null> {
  const projectId = sidebar.projectOf(owner.tab)?.id ?? sidebar.projectId.value;
  const context = await contextRead<SessionContext>('session_context', projectId, { session_id: owner.session.id, limit: 100 }).catch(() => null);
  const previews = context?.references.items.filter((link) => link.resource_type === 'preview') ?? [];
  return familyServers([process], previews, linkLabel)[0] ?? null;
}

// A server opens its preview in the peek beside the agent that started it,
// when it has one. Otherwise it opens as itself, as it always does on a phone,
// where a server has its own page.
export async function openServer(sidebar: SidebarContext, process: ProcessRecord): Promise<void> {
  const owner = phoneLayout.value ? null : serverOwner(sidebar, process);
  const server = owner ? await serverPreview(sidebar, process, owner) : null;
  if (!owner || !server?.url) return sidebar.selectProcess(process);
  const peek: Peek = { kind: 'preview', url: server.url, label: server.label, port: server.port, processId: process.id };
  if (sendWorkspaceRequest({ kind: 'peek', sessionId: owner.session.id, peek })) return;
  queuePeek(owner.session.id, peek);
  sidebar.selectSession(owner.tab.family.rootId, owner.session);
}
