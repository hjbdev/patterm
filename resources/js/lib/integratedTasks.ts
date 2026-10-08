import { taskIsActive, type IntegratedTask } from './integratedConversation';

// Native task types from Claude (local_agent, local_bash, ...), Codex
// (subagent, shell), and OpenCode (shell, or the subagent's agent name).
const KIND_LABELS: Record<string, string> = {
  local_agent: 'Agent',
  remote_agent: 'Remote agent',
  in_process_teammate: 'Teammate',
  subagent: 'Agent',
  agent: 'Agent',
  local_bash: 'Shell',
  shell: 'Shell',
  bash: 'Shell',
  local_workflow: 'Workflow',
  workflow: 'Workflow',
  monitor_mcp: 'Monitor',
  monitor: 'Monitor'
};

// OpenCode names a subagent task after its agent, such as "general".
export function taskKindLabel(task: IntegratedTask): string {
  if (!task.kind) return 'Task';
  const known = KIND_LABELS[task.kind];
  if (known) return known;
  const words = task.kind.replace(/[_-]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : 'Task';
}

export function taskStatusLabel(task: IntegratedTask): string {
  switch (task.status) {
    case 'running': return 'Running';
    case 'pending': return 'Queued';
    case 'paused': return 'Paused';
    case 'completed': return 'Done';
    case 'failed': return 'Failed';
    case 'stopped': return 'Stopped';
  }
}

// Live progress or a failure reason. A finished task's summary is mostly a
// note that its report went to the agent; the drawer shows the real output.
export function taskInlineDetail(task: IntegratedTask): string | undefined {
  return taskIsActive(task) || task.status === 'failed' ? task.detail : undefined;
}

export function taskIsFinished(task: IntegratedTask): boolean {
  return task.status === 'completed' || task.status === 'stopped';
}

export interface TaskCounts {
  active: number;
  failed: number;
  finished: number;
}

export function countTasks(tasks: IntegratedTask[]): TaskCounts {
  const counts: TaskCounts = { active: 0, failed: 0, finished: 0 };
  for (const task of tasks) {
    if (taskIsActive(task)) counts.active++;
    else if (task.status === 'failed') counts.failed++;
    else counts.finished++;
  }
  return counts;
}

// "2 running · 1 failed · 3 done", leaving out empty groups.
export function taskCountParts(counts: TaskCounts): string[] {
  const parts: string[] = [];
  if (counts.active) parts.push(`${counts.active} running`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  if (counts.finished) parts.push(`${counts.finished} done`);
  return parts;
}
