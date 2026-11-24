import type { DatabaseService } from '../Services/DatabaseService';
import type { SessionRuntimeState, SupervisedHostKind } from './AgentProtocol';

const HIBERNATED_ARGV_MARKER = '--patterm-hibernated';
const SUPERVISED_HOST_KINDS = new Set<SupervisedHostKind>(['claude-host', 'app-server', 'acp-host']);

export function parseArgvArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseRuntimeStateJson(raw: string | null | undefined): SessionRuntimeState | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as SessionRuntimeState;
  } catch {
    return null;
  }
}

// Reads structured runtime state from sessions.runtime_state when present, and
// falls back cleanly to legacy processes.argv positional packing for pre-migration
// rows and direct-SQL fixtures.
export function resolveSessionRuntimeState(
  rawRuntimeState: string | null | undefined,
  rawArgv: string | null | undefined
): SessionRuntimeState {
  const stored = parseRuntimeStateJson(rawRuntimeState);
  const argv = parseArgvArray(rawArgv);
  const argvHostKind = argv[1] && SUPERVISED_HOST_KINDS.has(argv[1] as SupervisedHostKind)
    ? argv[1] as SupervisedHostKind
    : undefined;
  const legacySocket = typeof argv[2] === 'string' && argv[2] ? argv[2] : undefined;
  const legacyPid = typeof argv[3] === 'string' && /^\d+$/.test(argv[3]) ? Number(argv[3]) : null;
  const legacyConfig = typeof argv[4] === 'string' && argv[4] && argv[4] !== HIBERNATED_ARGV_MARKER ? argv[4] : undefined;
  const legacyHibernated = argv.includes(HIBERNATED_ARGV_MARKER);

  if (stored) {
    const executable = stored.executable ?? (typeof argv[0] === 'string' && argv[0] ? argv[0] : undefined);
    return {
      ...stored,
      ...(executable ? { executable } : {}),
      hibernatedAt: stored.hibernatedAt !== undefined ? stored.hibernatedAt : (legacyHibernated ? '' : null)
    };
  }

  return {
    ...(argvHostKind ? { hostKind: argvHostKind } : {}),
    ...(typeof argv[0] === 'string' && argv[0] ? { executable: argv[0] } : {}),
    ...(argvHostKind && legacySocket ? { socketPath: legacySocket } : {}),
    ...(argvHostKind ? { pid: legacyPid } : {}),
    ...(argvHostKind && legacyConfig ? { configPath: legacyConfig } : {}),
    ...(legacyHibernated ? { hibernatedAt: '' } : {})
  };
}

// Resolves a supervised host socket path from either sessions.runtime_state or
// legacy processes.argv[2] (including retired third-party hosts like amp-host).
export function hostSocketPathFromRow(
  rawRuntimeState: string | null | undefined,
  rawArgv: string | null | undefined
): string | null {
  const stored = parseRuntimeStateJson(rawRuntimeState);
  if (typeof stored?.socketPath === 'string' && stored.socketPath.endsWith('.sock')) {
    return stored.socketPath;
  }
  const argv = parseArgvArray(rawArgv);
  return typeof argv[2] === 'string' && argv[2].endsWith('.sock') ? argv[2] : null;
}

export function isHibernatedRuntimeState(
  rawRuntimeState: string | null | undefined,
  rawArgv: string | null | undefined
): boolean {
  const stored = parseRuntimeStateJson(rawRuntimeState);
  if (stored && 'hibernatedAt' in stored) {
    return typeof stored.hibernatedAt === 'string';
  }
  return parseArgvArray(rawArgv).includes(HIBERNATED_ARGV_MARKER);
}

export function serializeRuntimeState(state: SessionRuntimeState | null | undefined): string | null {
  return state ? JSON.stringify(state) : null;
}

export function updateSessionRuntimeState(
  database: DatabaseService,
  processId: string,
  edit: (current: SessionRuntimeState) => SessionRuntimeState
): void {
  const row = database.connection.prepare(`
    select sessions.id, sessions.runtime_state, processes.argv
    from sessions
    left join processes on processes.id = sessions.process_id
    where sessions.process_id = ?
    order by sessions.exited_at is null desc, sessions.started_at desc
    limit 1
  `).get(processId) as { id: string; runtime_state: string | null; argv: string | null } | undefined;
  if (!row) return;
  const next = edit(resolveSessionRuntimeState(row.runtime_state, row.argv));
  database.connection.prepare(`update sessions set runtime_state = ? where id = ?`)
    .run(JSON.stringify(next), row.id);
}
