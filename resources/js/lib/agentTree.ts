import type { SessionRecord } from '../types';

export interface AgentNode {
  session: SessionRecord;
  children: AgentNode[];
}

// Build a parent→child tree from a flat session list using `parentId`. Sessions
// whose parent is absent from the list are treated as roots, so a subset (e.g.
// a subset of project sessions) still renders sensibly.
export function buildAgentTree(sessions: SessionRecord[]): AgentNode[] {
  const byId = new Map<string, AgentNode>();
  for (const session of sessions) {
    byId.set(session.id, { session, children: [] });
  }

  const roots: AgentNode[] = [];
  for (const session of sessions) {
    const node = byId.get(session.id);
    if (!node) {
      continue;
    }
    const parent = session.parentId ? byId.get(session.parentId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}
