import fs from 'node:fs';
import { claudeSessionTranscript, type ClaudeTaskLocation } from './ClaudeTaskOutput';
import { GoalLog, type IntegratedGoal } from './IntegratedGoal';

// Claude Code's stream-json output announces `/goal` only as a local command;
// its checks are written to the session transcript as `goal_status`
// attachments. The transcript only grows, so each read scans the bytes added
// since the last one, and only lines that mention a goal are parsed.

const CHUNK_BYTES = 1024 * 1024;

interface GoalScan {
  file: string;
  offset: number;
  log: GoalLog;
}

export class ClaudeGoalReader {
  private readonly scans = new Map<string, GoalScan>();

  read(location: ClaudeTaskLocation): { goal: IntegratedGoal | null; markers: ReturnType<GoalLog['list']> } {
    const key = location.sessionId;
    let scan = this.scans.get(key);
    if (!scan) {
      const file = claudeSessionTranscript(location);
      if (!file) return { goal: null, markers: [] };
      scan = { file, offset: 0, log: new GoalLog() };
      this.scans.set(key, scan);
      if (this.scans.size > 100) this.scans.delete(this.scans.keys().next().value!);
    }
    try {
      this.advance(scan, key);
    } catch {
      // An unreadable transcript keeps the last state read.
    }
    return { goal: scan.log.goal(key), markers: scan.log.list(key) };
  }

  forget(sessionId: string): void {
    this.scans.delete(sessionId);
  }

  private advance(scan: GoalScan, key: string): void {
    const size = fs.statSync(scan.file).size;
    // A shorter file is a rewritten one; read it again from the start.
    if (size < scan.offset) {
      scan.offset = 0;
      scan.log.forget(key);
    }
    if (size === scan.offset) return;
    const handle = fs.openSync(scan.file, 'r');
    let position = scan.offset;
    let carry = Buffer.alloc(0);
    try {
      while (position < size) {
        const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, size - position));
        const read = fs.readSync(handle, buffer, 0, buffer.length, position);
        if (!read) break;
        position += read;
        const data = Buffer.concat([carry, buffer.subarray(0, read)]);
        const end = data.lastIndexOf(0x0a);
        // A line still being written waits for the next read.
        if (end < 0) { carry = data; continue; }
        for (const line of data.subarray(0, end).toString('utf8').split('\n')) {
          if (line.includes('"goal_status"') || line.includes('"command":"goal"')) this.apply(scan.log, key, line);
        }
        carry = data.subarray(end + 1);
      }
    } finally {
      fs.closeSync(handle);
    }
    scan.offset = position - carry.length;
  }

  private apply(log: GoalLog, key: string, line: string): void {
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    const at = typeof row.timestamp === 'string' ? row.timestamp : undefined;
    const attachment = record(row.attachment);
    if (attachment.type === 'goal_status' && typeof attachment.condition === 'string') {
      const previous = log.goal(key);
      const rounds = typeof attachment.iterations === 'number' ? attachment.iterations : previous?.objective === attachment.condition ? previous.rounds : undefined;
      const reason = typeof attachment.reason === 'string' && attachment.reason.trim() ? attachment.reason.trim() : undefined;
      // The sentinel marks a goal being set; later rows are its checks.
      // It adds no marker, since Claude's own reply already says so.
      const status = attachment.sentinel === true ? 'active' : attachment.failed === true ? 'failed' : attachment.met === true ? 'complete' : 'active';
      log.observe(key, {
        objective: attachment.condition,
        status,
        ...(attachment.sentinel === true ? {} : reason ? { reason } : {}),
        ...(rounds !== undefined ? { rounds } : {}),
        ...(typeof attachment.durationMs === 'number' ? { timeUsedSeconds: Math.round(attachment.durationMs / 1000) } : {}),
        ...(at ? { updatedAt: at } : {})
      }, at, attachment.sentinel === true);
      return;
    }
    const run = record(row.commandRun);
    // A met goal clears itself; a later /goal clear only confirms it.
    if (row.type === 'system' && run.command === 'goal' && String(run.args ?? '').trim().toLowerCase() === 'clear' && log.goal(key)?.status !== 'complete') {
      log.observe(key, null, at);
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
