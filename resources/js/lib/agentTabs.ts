import { buildAgentTree, type AgentNode } from './agentTree';
import type { SessionRecord } from '../types';

export interface AgentTabOption {
  session: SessionRecord;
  depth: number;
  parentId: string | null;
  hasChildren: boolean;
}

export interface AgentTabFamily {
  rootId: string;
  root: AgentNode;
  active: SessionRecord;
  options: AgentTabOption[];
}

export interface AgentTabSelectionTarget {
  rootId: string;
  session: SessionRecord;
}

export type SelectedAgentByRoot = Record<string, string | null | undefined>;

export function activeAgentSessions(sessions: readonly SessionRecord[]): SessionRecord[] {
  return sessions.filter((session) => Boolean(session.processId) && session.processStatus !== 'closed'
    && ((!session.exitedAt && (session.interfaceMode === 'integrated' || Boolean(session.ptyProcessId)))
      || (session.interfaceMode === 'integrated' && Boolean(session.processStatus))));
}

export function buildAgentTabFamilies(
  sessions: readonly SessionRecord[],
  selectedByRoot: SelectedAgentByRoot = {}
): AgentTabFamily[] {
  return buildAgentTree(activeAgentSessions(sessions)).map((root) => {
    const options = flattenAgentOptions(root);
    const selectedId = selectedByRoot[root.session.id];
    const active = options.find((option) => option.session.id === selectedId)?.session ?? root.session;

    return {
      rootId: root.session.id,
      root,
      active,
      options
    };
  });
}

export function selectAgentInFamilies(
  sessions: readonly SessionRecord[],
  selectedByRoot: SelectedAgentByRoot,
  sessionId: string
): SelectedAgentByRoot {
  for (const family of buildAgentTabFamilies(sessions, selectedByRoot)) {
    if (family.options.some((option) => option.session.id === sessionId)) {
      return { ...selectedByRoot, [family.rootId]: sessionId };
    }
  }

  return selectedByRoot;
}

export function matchesAgentTabSelection(session: SessionRecord, activeTerminalId: string | null, activeSessionId: string | null): boolean {
  return Boolean((activeSessionId && session.id === activeSessionId)
    || (activeTerminalId && session.ptyProcessId === activeTerminalId));
}

export function activeAgentFamilyIndex(families: readonly AgentTabFamily[], activeTerminalId: string | null, activeSessionId: string | null = null): number {
  if (!activeTerminalId && !activeSessionId) return -1;
  return families.findIndex((family) => family.options.some((option) => matchesAgentTabSelection(option.session, activeTerminalId, activeSessionId)));
}

export function agentFamilyTargetAt(families: readonly AgentTabFamily[], index: number): AgentTabSelectionTarget | null {
  const family = families[index];
  if (!family) return null;
  return { rootId: family.rootId, session: family.active };
}

export function agentFamilyTargetByDelta(families: readonly AgentTabFamily[], activeTerminalId: string | null, delta: number, activeSessionId: string | null = null): AgentTabSelectionTarget | null {
  if (families.length === 0) return null;
  const activeIndex = activeAgentFamilyIndex(families, activeTerminalId, activeSessionId);
  if (activeIndex === -1) return null;
  return agentFamilyTargetAt(families, wrapIndex(activeIndex + delta, families.length));
}

export function agentOptionTargetByDelta(families: readonly AgentTabFamily[], activeTerminalId: string | null, delta: number, activeSessionId: string | null = null): AgentTabSelectionTarget | null {
  const family = families[activeAgentFamilyIndex(families, activeTerminalId, activeSessionId)];
  if (!family || family.options.length === 0) return null;

  const activeOptionIndex = family.options.findIndex((option) => matchesAgentTabSelection(option.session, activeTerminalId, activeSessionId));
  if (activeOptionIndex === -1) return null;
  const option = family.options[wrapIndex(activeOptionIndex + delta, family.options.length)];
  if (!option) return null;

  return {
    rootId: family.rootId,
    session: option.session
  };
}

export function agentLabel(session: SessionRecord): string {
  return session.title ?? session.displayName ?? session.lastTitle ?? session.harness ?? session.id;
}

// Tab menus list a family below its root, so a direct child sits flush and each
// deeper level steps in, keeping grandchildren visibly under their parent.
export function agentOptionIndent(depth: number): number {
  return Math.max(0, depth - 1) * 12;
}

// Names the family agent that owns a process, or null when the root owns it.
export function familyOwnerLabel(family: AgentTabFamily, processId: string | null): string | null {
  if (!processId || processId === family.root.session.processId) return null;
  const owner = family.options.find((option) => option.session.processId === processId)?.session;
  return owner ? agentLabel(owner) : null;
}

function wrapIndex(index: number, length: number): number {
  return ((index % length) + length) % length;
}

function flattenAgentOptions(root: AgentNode): AgentTabOption[] {
  const rows: AgentTabOption[] = [];

  function visit(node: AgentNode, depth: number): void {
    rows.push({
      session: node.session,
      depth,
      parentId: node.session.parentId,
      hasChildren: node.children.length > 0
    });
    for (const child of node.children) {
      visit(child, depth + 1);
    }
  }

  visit(root, 0);
  return rows;
}
