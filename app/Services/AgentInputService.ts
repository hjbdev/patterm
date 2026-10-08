import type { DatabaseService } from './DatabaseService';
import { resolvePtyProcessId } from './ProcessIdentity';
import type { IntegratedAgentService } from './IntegratedAgentService';

export interface TerminalInputSink {
  request(method: string, params: unknown): Promise<unknown>;
}

export type TerminalInputKind = 'text' | 'paste';

export interface AgentInputPayload {
  process_id: string;
  kind?: TerminalInputKind | undefined;
  text: string;
  submit?: boolean | undefined;
}

export async function sendAgentInput(database: DatabaseService, terminal: TerminalInputSink, input: AgentInputPayload, integrated?: Pick<IntegratedAgentService, 'prompt'>): Promise<unknown> {
  const session = database.connection.prepare(`select interface_mode from sessions where process_id = ? or id = ? order by exited_at is null desc, started_at desc limit 1`)
    .get(input.process_id, input.process_id) as { interface_mode: string } | undefined;
  if (session?.interface_mode === 'integrated') {
    if (!integrated) throw new Error('Integrated agent input is unavailable');
    return integrated.prompt(input.process_id, input.text);
  }
  return terminal.request('terminal.process.input', {
    process_id: resolvePtyProcessId(database, input.process_id),
    kind: inputKindForHarness(database, input),
    text: input.text,
    submit: input.submit
  });
}

function inputKindForHarness(database: DatabaseService, input: AgentInputPayload): TerminalInputKind {
  if (input.submit && isFullscreenTuiHarness(database, input.process_id)) {
    return 'paste';
  }

  return input.kind ?? 'text';
}

function isFullscreenTuiHarness(database: DatabaseService, processId: string): boolean {
  const row = database.connection
    .prepare(
      `select harness
       from sessions
       where process_id = ? or id = ?
       order by exited_at is null desc, started_at desc
       limit 1`
    )
    .get(processId, processId) as { harness: string | null } | undefined;

  return row?.harness === 'claude' || row?.harness === 'codex' || row?.harness === 'opencode' || row?.harness === 'amp';
}
