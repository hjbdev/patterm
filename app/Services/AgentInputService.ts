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
  preserve_attention?: boolean | undefined;
}

export async function sendAgentInput(database: DatabaseService, terminal: TerminalInputSink, input: AgentInputPayload, integrated?: Pick<IntegratedAgentService, 'prompt'>): Promise<unknown> {
  const row = database.connection.prepare(`select kind from processes where id = ? or pty_process_id = ? order by status = 'running' desc limit 1`)
    .get(input.process_id, input.process_id) as { kind: string } | undefined;
  const session = row?.kind === 'agent'
    ? true
    : Boolean(database.connection.prepare(`select 1 from sessions where process_id = ? or id = ? limit 1`).get(input.process_id, input.process_id));
  if (session) {
    if (!integrated) throw new Error('Integrated agent input is unavailable');
    return integrated.prompt(input.process_id, input.preserve_attention ? { text: input.text, preserveAttention: true } : input.text);
  }
  return terminal.request('terminal.process.input', {
    process_id: resolvePtyProcessId(database, input.process_id),
    kind: input.kind ?? 'text',
    text: input.text,
    submit: input.submit
  });
}
