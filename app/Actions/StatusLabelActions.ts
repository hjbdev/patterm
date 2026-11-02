import { z } from 'zod';
import type { DatabaseService } from '../Services/DatabaseService';
import type { SettingsService } from '../Services/SettingsService';
import type { TimelineService } from '../Services/TimelineService';
import { STATUS_LABEL_LIMIT, createStatusLabelInput, findStatusLabel, statusLabelId, type StatusLabel, type StatusLabelSettings } from '../Services/StatusLabels';

// label: a label's id or name, or null to clear.
export const statusSetInput = z.object({ label: z.string().trim().min(1).max(80).nullable() }).strict();
export const processStatusSetInput = z.object({ process_id: z.string().min(1).max(200), label: z.string().trim().min(1).max(80).nullable() }).strict();

interface AgentProcess { id: string; project_id: string; session_id: string | null; status: string; status_label_id: string | null; status_label_set_by: string | null }

export interface StatusLabelResult { label: Pick<StatusLabel, 'id' | 'name' | 'color'> | null }

// Pins a status label on an agent, or clears it. The label sits beside the
// agent's activity; idle detection is unchanged. An agent's own label
// clears when the user talks to it, since the user has taken over.
export class StatusLabelActions {
  constructor(
    private readonly database: DatabaseService,
    private readonly store: Pick<SettingsService, 'statusLabels' | 'updateStatusLabels'>,
    private readonly timeline: Pick<TimelineService, 'append'>,
    private readonly onChanged: () => void
  ) {}

  labels(): StatusLabel[] {
    return this.store.statusLabels().labels;
  }

  settings(): StatusLabelSettings {
    return this.store.statusLabels();
  }

  // Agents keep the id of a deleted label; it reads as none.
  updateSettings(raw: unknown): StatusLabelSettings {
    const settings = this.store.updateStatusLabels(raw);
    this.onChanged();
    return settings;
  }

  set(processId: string, wanted: string | null, source: 'agent' | 'user'): StatusLabelResult {
    const process = this.process(processId);
    if (!process || !process.session_id) throw new Error('Only an agent can have a status label');
    if (process.status !== 'running') throw new Error('Only a running agent can have a status label');
    const labels = this.labels();
    const label = wanted === null ? null : findStatusLabel(labels, wanted);
    if (wanted !== null && !label) {
      throw new Error(`Unknown status label "${wanted}". Configured labels: ${labels.map((item) => item.name).join(', ') || 'none'}. Status labels are configured in Settings › Status labels.`);
    }
    const now = new Date().toISOString();
    this.database.connection.prepare('update processes set status_label_id = ?, status_label_set_at = ?, status_label_set_by = ? where id = ?')
      .run(label?.id ?? null, label ? now : null, label ? source : null, process.id);
    this.timeline.append({ event_type: label ? 'agent.status_set' : 'agent.status_cleared', project_id: process.project_id, session_id: process.session_id, process_id: process.id, actor_type: source, metadata: label ? { label_id: label.id, name: label.name } : {} });
    this.onChanged();
    return { label: label ? { id: label.id, name: label.name, color: label.color } : null };
  }

  // An agent creates a label only when the user asks; its description says so.
  // A label already named so is returned instead of a duplicate.
  create(raw: unknown): { label: StatusLabel; created: boolean } {
    const input = createStatusLabelInput.parse(raw);
    const settings = this.store.statusLabels();
    const existing = findStatusLabel(settings.labels, input.name);
    if (existing) return { label: existing, created: false };
    if (settings.labels.length >= STATUS_LABEL_LIMIT) throw new Error(`There are already ${STATUS_LABEL_LIMIT} status labels. Ask the user to remove one in Settings › Status labels.`);
    const label: StatusLabel = { id: statusLabelId(input.name, settings.labels.map((item) => item.id)), name: input.name, color: input.color, description: input.description ?? '', createdBy: 'agent' };
    this.store.updateStatusLabels({ labels: [...settings.labels, label] });
    this.onChanged();
    return { label, created: true };
  }

  // The user typed or sent a message to the agent. Accepts a Patterm or PTY
  // process id. Labels the user pinned stay.
  userInput(processId: string): void {
    const process = this.process(processId);
    if (!process?.status_label_id || process.status_label_set_by !== 'agent') return;
    this.database.connection.prepare('update processes set status_label_id = null, status_label_set_at = null, status_label_set_by = null where id = ?').run(process.id);
    this.timeline.append({ event_type: 'agent.status_cleared', project_id: process.project_id, session_id: process.session_id, process_id: process.id, actor_type: 'user', metadata: { reason: 'user_input' } });
    this.onChanged();
  }

  private process(processId: string): AgentProcess | null {
    return (this.database.connection.prepare(`select processes.id, processes.project_id, processes.status, processes.status_label_id, processes.status_label_set_by, sessions.id as session_id
      from processes
      left join sessions on sessions.process_id = processes.id
      where processes.id = ? or processes.pty_process_id = ?
      order by processes.status = 'running' desc, sessions.started_at desc limit 1`).get(processId, processId) as AgentProcess | undefined) ?? null;
  }
}
