import type { ProcessRecord, SessionRecord } from '../types';

export type LiveProcessRecord = ProcessRecord & { ptyProcessId: string };

export function activeProcesses(processes: readonly ProcessRecord[]): LiveProcessRecord[] {
  return processes.filter((process): process is LiveProcessRecord => process.status === 'running' && Boolean(process.ptyProcessId));
}

export function ownedProcessesForSessions(
  sessions: readonly SessionRecord[],
  processes: readonly ProcessRecord[]
): LiveProcessRecord[] {
  const ownerIds = new Set(sessions.map((session) => session.processId).filter((id): id is string => Boolean(id)));
  return activeProcesses(processes).filter((process) => Boolean(process.parentProcessId && ownerIds.has(process.parentProcessId)));
}

// Orphaned processes remain reachable when their owning agent is closed.
export function topLevelProcessesForSessions(
  sessions: readonly SessionRecord[],
  processes: readonly ProcessRecord[]
): LiveProcessRecord[] {
  const ownedIds = new Set(ownedProcessesForSessions(sessions, processes).map((process) => process.id));
  return activeProcesses(processes).filter((process) => !ownedIds.has(process.id));
}
