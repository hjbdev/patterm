import fs from 'node:fs';
import type { IntegratedConversationMessage, IntegratedTask } from '../Services/IntegratedConversation';
import { antigravityTranscriptPath, extractAntigravitySubagentId } from '../Services/AntigravityTaskOutput';
import { buildTranscriptTool, toolActivityLabel } from '../Services/TranscriptProjection';

type Row = Record<string, unknown>;

const MAX_READ_BYTES = 1024 * 1024;
const MAX_CHUNKS_PER_POLL = 16;
const OVERSIZE_SCAN_CHUNK = 64 * 1024;
const MAX_OVERSIZE_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_PREVIEW_CHARS = 8_000;
const MAX_TASKS = 20;
const SETTLED_IDLE_MS = 5_000;
const DEFAULT_POLL_MS = 400;

interface FileTail {
  path: string;
  offset: number;
  dev: number | null;
  ino: number | null;
  skipPartial: boolean;
  mtimeMs: number;
  hasMore: boolean;
}

interface PendingInvoke {
  toolRowId: string;
  label: string;
  kind: string;
  role: string;
  prompt: string;
}

interface TrackedSubagent {
  id: string;
  parentToolRowId: string | null;
  label: string;
  kind: string;
  role: string;
  prompt: string;
  status: IntegratedTask['status'];
  detail?: string;
  tail: FileTail;
  seenSteps: Set<number>;
  pendingTools: Array<{ rowId: string; name: string; input: Record<string, unknown>; createdAt?: string }>;
  sendMessageCount: number;
  consumedSendMessages: number;
  lastStepWasFinal: boolean;
  authoritativeLink: boolean;
  historicalUnlinked: boolean;
  hasRows: boolean;
}

export interface AntigravitySubagentTrackerOptions {
  sessionId: string;
  hostEnv: NodeJS.ProcessEnv;
  pollMs?: number;
  onMessage(message: IntegratedConversationMessage): void;
  onSubagentDetached?(subagentId: string): void;
  onTasksChanged(): void;
}

// Tracks Antigravity native subagents spawned via invoke_subagent by pairing
// ACP tool rows with the parent and child transcript.jsonl files on disk.
export class AntigravitySubagentTracker {
  private readonly parentTail: FileTail | null;
  private readonly parentSeenSteps = new Set<number>();
  private readonly parentPendingTools: Array<{ name: string; args: Record<string, unknown> }> = [];
  private readonly observedInvokes = new Map<string, PendingInvoke>();
  private readonly unlinkedInvokes: PendingInvoke[] = [];
  private readonly subagents = new Map<string, TrackedSubagent>();
  private readonly toolRowToSubagent = new Map<string, string>();
  private readonly pollMs: number;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private initialLoadPending = false;
  private lastTasksDigest = '';

  constructor(private readonly options: AntigravitySubagentTrackerOptions) {
    const parentPath = antigravityTranscriptPath(options.sessionId, options.hostEnv);
    this.parentTail = parentPath ? createTail(parentPath) : null;
    this.pollMs = Math.max(25, options.pollMs ?? DEFAULT_POLL_MS);
  }

  observeToolCall(toolRowId: string, name: string, input: Record<string, unknown>, outputText: string, rawOutput: unknown): void {
    if (this.stopped) return;
    if (name === 'invoke_subagent') {
      const label = invokeLabel(input);
      const kind = invokeKind(input);
      const role = typeof input.Role === 'string' ? input.Role : typeof input.role === 'string' ? input.role : '';
      const prompt = typeof input.Prompt === 'string' ? input.Prompt : typeof input.prompt === 'string' ? input.prompt : '';
      const priorInvoke = this.observedInvokes.get(toolRowId);
      const invokeMeta: PendingInvoke = {
        toolRowId,
        label: label !== 'Subagent' ? label : priorInvoke?.label ?? label,
        kind: kind !== 'subagent' ? kind : priorInvoke?.kind ?? kind,
        role: role || priorInvoke?.role || '',
        prompt: prompt || priorInvoke?.prompt || ''
      };
      this.observedInvokes.set(toolRowId, invokeMeta);
      if (this.observedInvokes.size > 200) {
        const oldest = this.observedInvokes.keys().next().value;
        if (oldest !== undefined) this.observedInvokes.delete(oldest);
      }
      const existingId = this.toolRowToSubagent.get(toolRowId);
      const directId = extractAntigravitySubagentId(rawOutput) ?? extractAntigravitySubagentId(outputText);
      if (existingId) {
        if (directId && directId !== this.options.sessionId && directId !== existingId) {
          const previous = this.subagents.get(existingId);
          if (previous) this.detachParentToolRow(previous, false);
          else this.toolRowToSubagent.delete(toolRowId);
          this.registerSubagent(directId, toolRowId, invokeMeta.label, invokeMeta.kind, invokeMeta.role, invokeMeta.prompt, true);
          this.syncNow();
          return;
        }
        const subagent = this.subagents.get(existingId);
        if (subagent) {
          if (directId === existingId) subagent.authoritativeLink = true;
          else if (!subagent.authoritativeLink && invokeMatchScore(invokeMeta, subagent) < 0) {
            this.detachParentToolRow(subagent, true);
            this.syncNow();
            return;
          }
          if (invokeMeta.label && subagent.label === 'Subagent') subagent.label = invokeMeta.label;
          if (invokeMeta.kind && subagent.kind === 'subagent') subagent.kind = invokeMeta.kind;
          if (invokeMeta.role && !subagent.role) subagent.role = invokeMeta.role;
          if (invokeMeta.prompt && !subagent.prompt) subagent.prompt = invokeMeta.prompt;
          this.notifyTasksIfChanged();
        }
        return;
      }
      if (directId && directId !== this.options.sessionId) {
        this.registerSubagent(directId, toolRowId, invokeMeta.label, invokeMeta.kind, invokeMeta.role, invokeMeta.prompt, true);
        this.syncNow();
        return;
      }
      const unlinkedSubagent = this.matchUnlinkedSubagent(invokeMeta.role, invokeMeta.prompt);
      if (unlinkedSubagent) {
        this.attachParentToolRow(unlinkedSubagent, toolRowId, invokeMeta.label, invokeMeta.kind);
        this.syncNow();
        return;
      }
      const pending = this.unlinkedInvokes.find((item) => item.toolRowId === toolRowId);
      if (pending) {
        pending.label = invokeMeta.label;
        pending.kind = invokeMeta.kind;
        pending.role = invokeMeta.role;
        pending.prompt = invokeMeta.prompt;
      } else {
        this.unlinkedInvokes.push({ ...invokeMeta });
      }
      this.syncNow();
      return;
    }

    if (name === 'send_message') {
      const recipient = typeof input.Recipient === 'string' ? input.Recipient : typeof input.recipient === 'string' ? input.recipient : '';
      const subagent = recipient ? this.subagents.get(recipient) : undefined;
      if (subagent) {
        subagent.status = 'running';
        subagent.lastStepWasFinal = false;
        this.notifyTasksIfChanged();
        this.ensurePolling();
      }
      return;
    }

    if (name === 'manage_subagents') {
      const action = typeof input.Action === 'string' ? input.Action : typeof input.action === 'string' ? input.action : '';
      if (action === 'kill_all') {
        for (const subagent of this.subagents.values()) {
          if (subagent.status === 'running' || subagent.status === 'pending') subagent.status = 'stopped';
        }
        this.notifyTasksIfChanged();
        this.updateTimer();
      } else if (action === 'kill') {
        const ids = Array.isArray(input.ConversationIds) ? input.ConversationIds : Array.isArray(input.conversationIds) ? input.conversationIds : [];
        for (const raw of ids) {
          const subagent = typeof raw === 'string' ? this.subagents.get(raw) : undefined;
          if (subagent && (subagent.status === 'running' || subagent.status === 'pending')) subagent.status = 'stopped';
        }
        this.notifyTasksIfChanged();
        this.updateTimer();
      }
    }
  }

  syncNow(initialLoad = false): void {
    if (this.stopped) return;
    if (initialLoad) this.initialLoadPending = true;
    this.pollParent();
    this.reconcileUnlinked();
    for (const subagent of this.subagents.values()) {
      if (subagent.status !== 'stopped' || !subagent.hasRows) {
        this.pollSubagent(subagent, initialLoad);
      }
    }
    if (this.initialLoadPending && !this.parentTail?.hasMore) {
      this.initialLoadPending = false;
      for (const subagent of this.subagents.values()) {
        if (subagent.parentToolRowId === null && subagent.status !== 'running' && subagent.status !== 'pending') {
          subagent.historicalUnlinked = true;
        }
      }
    }
    this.notifyTasksIfChanged();
    this.updateTimer();
  }

  tasks(): IntegratedTask[] {
    return [...this.subagents.values()].slice(-MAX_TASKS).map((subagent) => ({
      id: subagent.id,
      label: subagent.label,
      kind: subagent.kind,
      status: subagent.status,
      ...(subagent.detail ? { detail: subagent.detail } : {}),
      stoppable: false
    }));
  }

  hasTask(taskId: string): boolean {
    return this.subagents.has(taskId);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private ensurePolling(): void {
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => this.syncNow(), this.pollMs);
    this.timer.unref?.();
  }

  private updateTimer(): void {
    const needsPoll = this.unlinkedInvokes.length > 0
      || Boolean(this.parentTail?.hasMore)
      || [...this.subagents.values()].some((subagent) =>
        subagent.status === 'running' || subagent.status === 'pending' || subagent.tail.hasMore
      );
    if (needsPoll) this.ensurePolling();
    else if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private dropUnlinkedInvoke(toolRowId: string): void {
    const index = this.unlinkedInvokes.findIndex((item) => item.toolRowId === toolRowId);
    if (index >= 0) this.unlinkedInvokes.splice(index, 1);
  }

  private detachParentToolRow(subagent: TrackedSubagent, requeueOldRow = false): void {
    const oldRowId = subagent.parentToolRowId;
    if (oldRowId && this.toolRowToSubagent.get(oldRowId) === subagent.id) {
      this.toolRowToSubagent.delete(oldRowId);
    }
    subagent.parentToolRowId = null;
    subagent.authoritativeLink = false;
    subagent.hasRows = false;
    this.options.onSubagentDetached?.(subagent.id);
    if (requeueOldRow && oldRowId && !this.unlinkedInvokes.some((item) => item.toolRowId === oldRowId)) {
      const observed = this.observedInvokes.get(oldRowId);
      if (observed) this.unlinkedInvokes.push({ ...observed });
    }
  }

  private attachParentToolRow(subagent: TrackedSubagent, toolRowId: string, label: string, kind: string, authoritative = false): void {
    this.dropUnlinkedInvoke(toolRowId);
    if (subagent.parentToolRowId && subagent.parentToolRowId !== toolRowId) {
      this.detachParentToolRow(subagent, true);
    }
    const existingOwnerId = this.toolRowToSubagent.get(toolRowId);
    if (existingOwnerId && existingOwnerId !== subagent.id) {
      const existingOwner = this.subagents.get(existingOwnerId);
      if (existingOwner) this.detachParentToolRow(existingOwner, false);
    }
    subagent.parentToolRowId = toolRowId;
    subagent.authoritativeLink = authoritative;
    subagent.historicalUnlinked = false;
    this.toolRowToSubagent.set(toolRowId, subagent.id);
    if (label && subagent.label === 'Subagent') subagent.label = label;
    if (kind && subagent.kind === 'subagent') subagent.kind = kind;
    // Replay the child's log once we know which parent tool row owns its rows.
    subagent.tail.offset = 0;
    subagent.tail.skipPartial = false;
    subagent.tail.hasMore = false;
    subagent.seenSteps.clear();
    subagent.pendingTools.length = 0;
    subagent.sendMessageCount = 0;
    subagent.hasRows = false;
  }

  private matchUnlinkedSubagent(role: string, prompt: string): TrackedSubagent | null {
    const candidates = [...this.subagents.values()].filter((subagent) =>
      subagent.parentToolRowId === null
      && !subagent.historicalUnlinked
      && (!role || !subagent.role || subagent.role === role)
      && (!prompt || !subagent.prompt || subagent.prompt === prompt)
    );
    if (!candidates.length) return null;
    if (role && prompt) {
      const exact = candidates.find((subagent) => subagent.role === role && subagent.prompt === prompt);
      if (exact) return exact;
    }
    if (prompt) {
      const byPrompt = candidates.find((subagent) => subagent.prompt === prompt);
      if (byPrompt) return byPrompt;
    }
    if (role) {
      const byRole = candidates.find((subagent) => subagent.role === role);
      if (byRole) return byRole;
    }
    return candidates[0] ?? null;
  }

  private registerSubagent(id: string, toolRowId: string | null, label: string, kind: string, role = '', prompt = '', authoritative = false): TrackedSubagent {
    if (toolRowId) this.dropUnlinkedInvoke(toolRowId);
    const existing = this.subagents.get(id);
    if (existing) {
      if (role && (!existing.role || authoritative)) existing.role = role;
      if (prompt && (!existing.prompt || authoritative)) existing.prompt = prompt;
      if (toolRowId && (!existing.parentToolRowId || (authoritative && existing.parentToolRowId !== toolRowId))) {
        this.attachParentToolRow(existing, toolRowId, label, kind, authoritative);
      } else {
        if (authoritative && toolRowId && existing.parentToolRowId === toolRowId) existing.authoritativeLink = true;
        if (label && existing.label === 'Subagent') existing.label = label;
        if (kind && existing.kind === 'subagent') existing.kind = kind;
      }
      return existing;
    }
    if (toolRowId) {
      const existingOwnerId = this.toolRowToSubagent.get(toolRowId);
      if (existingOwnerId && existingOwnerId !== id) {
        const existingOwner = this.subagents.get(existingOwnerId);
        if (existingOwner) this.detachParentToolRow(existingOwner);
      }
    }
    const transcriptPath = antigravityTranscriptPath(id, this.options.hostEnv);
    const subagent: TrackedSubagent = {
      id,
      parentToolRowId: toolRowId,
      label: label || 'Subagent',
      kind: kind || 'subagent',
      role,
      prompt,
      status: 'running',
      tail: createTail(transcriptPath ?? ''),
      seenSteps: new Set(),
      pendingTools: [],
      sendMessageCount: 0,
      consumedSendMessages: 0,
      lastStepWasFinal: false,
      authoritativeLink: Boolean(toolRowId && authoritative),
      historicalUnlinked: false,
      hasRows: false
    };
    this.subagents.set(id, subagent);
    if (toolRowId) this.toolRowToSubagent.set(toolRowId, id);
    return subagent;
  }

  private matchUnlinkedInvoke(args: Record<string, unknown>, minScore = 0): PendingInvoke | null {
    if (!this.unlinkedInvokes.length) return null;
    const role = typeof args.Role === 'string' ? args.Role : '';
    const prompt = typeof args.Prompt === 'string' ? args.Prompt : '';
    let bestIndex = -1;
    let bestScore = minScore - 1;
    for (let index = 0; index < this.unlinkedInvokes.length; index++) {
      const score = invokeMatchScore(this.unlinkedInvokes[index]!, { role, prompt });
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) return null;
    return this.unlinkedInvokes.splice(bestIndex, 1)[0] ?? null;
  }

  private reconcileUnlinked(): void {
    // 1. Detach any non-authoritative link whose metadata now contradicts its
    //    latest observed ACP invoke (e.g. an empty initial frame later updated
    //    with a different Role or Prompt).
    for (const subagent of this.subagents.values()) {
      if (!subagent.parentToolRowId || subagent.authoritativeLink) continue;
      const current = this.observedInvokes.get(subagent.parentToolRowId);
      if (current && invokeMatchScore(current, subagent) < 0) {
        this.detachParentToolRow(subagent, true);
      }
    }
    // 2. If a queued ACP invoke is a strictly stronger match for a provisionally
    //    linked child than its current link (e.g. exact Role/Prompt vs empty
    //    initial frame), release the weaker provisional link so both re-pair.
    if (this.unlinkedInvokes.length) {
      for (const subagent of this.subagents.values()) {
        if (!subagent.parentToolRowId || subagent.authoritativeLink) continue;
        const current = this.observedInvokes.get(subagent.parentToolRowId);
        const currentScore = current ? invokeMatchScore(current, subagent) : 0;
        if (this.unlinkedInvokes.some((item) => invokeMatchScore(item, subagent) > currentScore)) {
          this.detachParentToolRow(subagent, true);
        }
      }
    }
    // 3. Pair unlinked children and invokes in descending match specificity.
    if (!this.unlinkedInvokes.length) return;
    for (const minScore of [3, 2, 1, 0]) {
      for (const subagent of this.subagents.values()) {
        if (subagent.parentToolRowId !== null || subagent.historicalUnlinked || !this.unlinkedInvokes.length) continue;
        const matched = this.matchUnlinkedInvoke({ Role: subagent.role, Prompt: subagent.prompt }, minScore);
        if (matched) this.attachParentToolRow(subagent, matched.toolRowId, matched.label, matched.kind);
      }
    }
  }

  private pollParent(): void {
    if (!this.parentTail) return;
    for (let chunk = 0; chunk < MAX_CHUNKS_PER_POLL; chunk++) {
      const lines = readNewLines(this.parentTail);
      for (const line of lines) {
        let row: Row;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
          row = parsed as Row;
        } catch {
          continue;
        }
        if (typeof row.step_index === 'number') {
          if (this.parentSeenSteps.has(row.step_index)) continue;
          this.parentSeenSteps.add(row.step_index);
        }
        if (row.type === 'USER_INPUT' && row.source === 'USER_EXPLICIT') {
          this.parentPendingTools.length = 0;
          continue;
        }
        if (row.type === 'PLANNER_RESPONSE' && row.source === 'MODEL' && Array.isArray(row.tool_calls)) {
          for (const rawCall of row.tool_calls) {
            if (!rawCall || typeof rawCall !== 'object') continue;
            const call = rawCall as Row;
            const name = typeof call.name === 'string' ? call.name : '';
            const args = parseToolArgs(call.args, 0);
            this.parentPendingTools.push({ name, args });
            if (name === 'send_message') {
              const recipient = typeof args.Recipient === 'string' ? args.Recipient : '';
              const subagent = recipient ? this.subagents.get(recipient) : undefined;
              if (subagent) {
                subagent.status = 'running';
                subagent.lastStepWasFinal = false;
              }
            } else if (name === 'manage_subagents') {
              const action = typeof args.Action === 'string' ? args.Action : '';
              if (action === 'kill_all') {
                for (const subagent of this.subagents.values()) {
                  if (subagent.status === 'running' || subagent.status === 'pending') subagent.status = 'stopped';
                }
              } else if (action === 'kill' && Array.isArray(args.ConversationIds)) {
                for (const rawId of args.ConversationIds) {
                  const subagent = typeof rawId === 'string' ? this.subagents.get(rawId) : undefined;
                  if (subagent && (subagent.status === 'running' || subagent.status === 'pending')) subagent.status = 'stopped';
                }
              }
            }
          }
          continue;
        }
        if (row.type === 'GENERIC' && row.source === 'MODEL' && this.parentPendingTools.length) {
          const call = this.parentPendingTools.shift()!;
          if (call.name === 'invoke_subagent') {
            const id = extractAntigravitySubagentId(row.content);
            if (id && id !== this.options.sessionId) {
              const alreadyLinked = Boolean(this.subagents.get(id)?.parentToolRowId);
              const matched = alreadyLinked ? null : this.matchUnlinkedInvoke(call.args);
              const label = matched?.label && matched.label !== 'Subagent' ? matched.label : invokeLabel(call.args);
              const kind = matched?.kind && matched.kind !== 'subagent' ? matched.kind : invokeKind(call.args);
              const role = typeof call.args.Role === 'string' ? call.args.Role : matched?.role ?? '';
              const prompt = typeof call.args.Prompt === 'string' ? call.args.Prompt : matched?.prompt ?? '';
              this.registerSubagent(id, matched?.toolRowId ?? null, label, kind, role, prompt);
            }
          }
          continue;
        }
        if (row.type === 'SYSTEM_MESSAGE' && typeof row.content === 'string') {
          const match = /\[Message\][^\n]*\bsender=([A-Za-z0-9_-]{1,128})\b[^\n]*\bcontent=([\s\S]*?)(?:\n<\/SYSTEM_MESSAGE>|$)/.exec(row.content);
          if (!match?.[1]) continue;
          const subagent = this.subagents.get(match[1]);
          if (!subagent) continue;
          // Tail the child first so we know whether this parent message came
          // from one of the child's own send_message tool calls (progress) or
          // from the harness reporting turn completion.
          this.pollSubagent(subagent, false);
          const replyLine = firstLine(match[2] ?? '');
          if (replyLine && subagent.status !== 'failed') subagent.detail = replyLine;
          if (subagent.sendMessageCount > subagent.consumedSendMessages) {
            subagent.consumedSendMessages++;
          } else if (subagent.pendingTools.length === 0 && (subagent.status === 'running' || subagent.status === 'pending')) {
            subagent.status = 'completed';
          }
        }
      }
      if (!this.parentTail.hasMore) break;
    }
  }

  private pollSubagent(subagent: TrackedSubagent, initialLoad: boolean): void {
    if (!subagent.tail.path) return;
    for (let chunk = 0; chunk < MAX_CHUNKS_PER_POLL; chunk++) {
      const lines = readNewLines(subagent.tail);
      for (const line of lines) {
        let row: Row;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
          row = parsed as Row;
        } catch {
          continue;
        }
        if (typeof row.step_index !== 'number' || subagent.seenSteps.has(row.step_index)) continue;
        subagent.seenSteps.add(row.step_index);
        const createdAt = isoTimestamp(row.created_at);
        const content = typeof row.content === 'string' ? row.content : '';
        const parentId = subagent.parentToolRowId ?? undefined;

        if (row.type === 'PLANNER_RESPONSE' && row.source === 'MODEL') {
          const thinking = typeof row.thinking === 'string' ? row.thinking.trim() : '';
          if (thinking && parentId) {
            subagent.hasRows = true;
            this.options.onMessage({
              id: `sub:${subagent.id}:${row.step_index}:thinking`,
              role: 'assistant',
              kind: 'reasoning',
              text: clip(thinking, MAX_PREVIEW_CHARS),
              parentId,
              ...(createdAt ? { createdAt, completedAt: createdAt } : {})
            });
          }
          const calls = Array.isArray(row.tool_calls) ? row.tool_calls : [];
          if (content.trim()) {
            subagent.hasRows = true;
            const summary = firstLine(content);
            if (summary) subagent.detail = summary;
            if (parentId) {
              this.options.onMessage({
                id: `sub:${subagent.id}:${row.step_index}:text`,
                role: 'assistant',
                kind: 'text',
                text: clip(content, MAX_PREVIEW_CHARS),
                parentId,
                ...(createdAt ? { createdAt, completedAt: createdAt } : {})
              });
            }
          }
          for (const [index, rawCall] of calls.entries()) {
            if (!rawCall || typeof rawCall !== 'object') continue;
            const call = rawCall as Row;
            const name = typeof call.name === 'string' && call.name ? call.name : 'Tool';
            if (name === 'send_message') subagent.sendMessageCount++;
            const input = parseToolArgs(call.args);
            const rowId = `sub:${subagent.id}:${row.step_index}:tool:${index}`;
            subagent.pendingTools.push({ rowId, name, input, ...(createdAt ? { createdAt } : {}) });
            subagent.detail = toolActivityLabel(buildTranscriptTool(name, { input, state: { status: 'running' } }, ''));
            if (subagent.status === 'completed') subagent.status = 'running';
            if (parentId) {
              subagent.hasRows = true;
              this.options.onMessage({
                id: rowId,
                role: 'assistant',
                kind: 'tool',
                text: '',
                parentId,
                ...(createdAt ? { createdAt } : {}),
                tool: { name, input, state: { status: 'running' } }
              });
            }
          }
          subagent.lastStepWasFinal = calls.length === 0 && (Boolean(content.trim()) || row.status === 'DONE');
          if (row.status === 'ERROR') {
            subagent.status = 'failed';
            subagent.detail = firstLine(content) || 'Subagent step failed';
          }
          continue;
        }

        if (row.type === 'GENERIC' && row.source === 'MODEL' && subagent.pendingTools.length) {
          const pending = subagent.pendingTools.shift()!;
          const failed = row.status === 'ERROR';
          const cleaned = stripStepTimestamps(content);
          if (parentId) {
            subagent.hasRows = true;
            this.options.onMessage({
              id: pending.rowId,
              role: 'assistant',
              kind: 'tool',
              text: clip(cleaned, MAX_PREVIEW_CHARS),
              parentId,
              ...(pending.createdAt ? { createdAt: pending.createdAt } : {}),
              ...(createdAt ? { completedAt: createdAt } : {}),
              tool: {
                name: pending.name,
                input: pending.input,
                state: failed ? { status: 'failed', error: firstLine(cleaned) || 'Tool failed' } : { status: 'completed' }
              }
            });
          }
          continue;
        }

        if (row.type === 'ERROR_MESSAGE') {
          subagent.status = 'failed';
          subagent.detail = firstLine(content) || 'Subagent error';
          if (parentId && content.trim()) {
            subagent.hasRows = true;
            this.options.onMessage({
              id: `sub:${subagent.id}:${row.step_index}:error`,
              role: 'assistant',
              kind: 'notice',
              level: 'error',
              text: clip(content, MAX_PREVIEW_CHARS),
              parentId,
              ...(createdAt ? { createdAt, completedAt: createdAt } : {})
            });
          }
        }
      }
      if (!subagent.tail.hasMore) break;
    }

    // A subagent whose transcript ended with a tool-free DONE response and has
    // gone quiet is settled (both live and resumed). Native Antigravity sends
    // all parent [Message] rows via send_message tool calls rather than a
    // separate harness completion message.
    if (subagent.status === 'running' && subagent.lastStepWasFinal
      && subagent.pendingTools.length === 0 && subagent.tail.mtimeMs > 0
      && Date.now() - subagent.tail.mtimeMs > SETTLED_IDLE_MS) {
      subagent.status = 'completed';
    }
  }

  private notifyTasksIfChanged(): void {
    const digest = JSON.stringify(this.tasks());
    if (digest === this.lastTasksDigest) return;
    this.lastTasksDigest = digest;
    this.options.onTasksChanged();
  }
}

function invokeMatchScore(invoke: { role: string; prompt: string }, subagent: { role: string; prompt: string }): number {
  if (invoke.role && subagent.role && invoke.role !== subagent.role) return -1;
  if (invoke.prompt && subagent.prompt && invoke.prompt !== subagent.prompt) return -1;
  if (invoke.role && subagent.role && invoke.prompt && subagent.prompt) return 3;
  if (invoke.prompt && subagent.prompt) return 2;
  if (invoke.role && subagent.role) return 1;
  return 0;
}

function createTail(filePath: string): FileTail {
  return { path: filePath, offset: 0, dev: null, ino: null, skipPartial: false, mtimeMs: 0, hasMore: false };
}

function readNewLines(tail: FileTail): string[] {
  tail.hasMore = false;
  if (!tail.path) return [];
  let fd: number;
  try {
    fd = fs.openSync(tail.path, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  } catch {
    return [];
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return [];
    tail.mtimeMs = stat.mtimeMs;
    if (tail.dev !== null && (stat.dev !== tail.dev || stat.ino !== tail.ino || stat.size < tail.offset)) {
      tail.offset = 0;
      tail.skipPartial = false;
    }
    tail.dev = stat.dev;
    tail.ino = stat.ino;
    if (stat.size <= tail.offset) return [];
    const length = Math.min(stat.size - tail.offset, MAX_READ_BYTES);
    const buffer = Buffer.allocUnsafe(length);
    const read = fs.readSync(fd, buffer, 0, length, tail.offset);
    if (read <= 0) return [];
    const lastNewline = buffer.subarray(0, read).lastIndexOf(10);
    if (lastNewline < 0) {
      if (read < MAX_READ_BYTES) return [];
      // A single JSONL record exceeded MAX_READ_BYTES; scan forward to its
      // newline so the cursor never stalls on an oversized tool output.
      let pos = tail.offset + read;
      const limit = Math.min(stat.size, tail.offset + MAX_OVERSIZE_SCAN_BYTES);
      const scanBuf = Buffer.allocUnsafe(OVERSIZE_SCAN_CHUNK);
      let tailText = '';
      while (pos < limit) {
        const chunkLen = Math.min(limit - pos, OVERSIZE_SCAN_CHUNK);
        const chunkRead = fs.readSync(fd, scanBuf, 0, chunkLen, pos);
        if (chunkRead <= 0) break;
        const nl = scanBuf.subarray(0, chunkRead).indexOf(10);
        if (nl >= 0) {
          tailText = (tailText + scanBuf.toString('utf8', 0, nl)).slice(-16_384);
          tail.offset = pos + nl + 1;
          tail.hasMore = tail.offset < stat.size;
          if (tail.skipPartial) {
            tail.skipPartial = false;
            return [];
          }
          const summary = summarizeOversizedJsonlLine(buffer.toString('utf8', 0, Math.min(read, 64 * 1024)), tailText);
          return summary ? [summary] : [];
        }
        tailText = (tailText + scanBuf.toString('utf8', 0, chunkRead)).slice(-16_384);
        pos += chunkRead;
      }
      // If we hit the scan cap with more data left, advance past the scanned
      // slice and drop the remainder once its newline arrives.
      if (pos >= tail.offset + MAX_OVERSIZE_SCAN_BYTES && pos < stat.size) {
        tail.offset = pos;
        tail.skipPartial = true;
        tail.hasMore = true;
      }
      return [];
    }
    tail.offset += lastNewline + 1;
    tail.hasMore = tail.offset < stat.size;
    const lines = buffer.toString('utf8', 0, lastNewline).split('\n');
    if (tail.skipPartial) {
      lines.shift();
      tail.skipPartial = false;
    }
    return lines.filter((line) => line.trim().length > 0);
  } catch {
    return [];
  } finally {
    fs.closeSync(fd);
  }
}

function summarizeOversizedJsonlLine(head: string, tailText: string): string | null {
  const match = (pattern: RegExp): string | undefined => pattern.exec(head)?.[1] ?? pattern.exec(tailText)?.[1];
  const stepRaw = match(/(?<!\\)"step_index"\s*:\s*(\d+)/);
  const type = match(/(?<!\\)"type"\s*:\s*"([A-Z_]+)"/);
  const source = match(/(?<!\\)"source"\s*:\s*"([A-Z_]+)"/);
  const status = match(/(?<!\\)"status"\s*:\s*"([A-Z_]+)"/);
  const createdAt = match(/(?<!\\)"created_at"\s*:\s*"([^"]+)"/);
  if (!type) return null;
  const row: Row = {
    ...(stepRaw !== undefined ? { step_index: Number(stepRaw) } : {}),
    type,
    ...(source ? { source } : {}),
    ...(status ? { status } : {}),
    ...(createdAt ? { created_at: createdAt } : {})
  };
  const conversationId = extractAntigravitySubagentId(head) ?? extractAntigravitySubagentId(tailText);
  if (conversationId) {
    row.content = JSON.stringify({ conversationId });
  } else {
    row.content = '[Antigravity record output truncated in Patterm]';
  }
  return JSON.stringify(row);
}

function parseToolArgs(value: unknown, maxStringChars = 4_000): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    let parsed: unknown = item;
    if (typeof item === 'string') {
      try { parsed = JSON.parse(item) as unknown; } catch { parsed = item; }
    }
    return [key, typeof parsed === 'string' && maxStringChars > 0 ? clip(parsed, maxStringChars) : parsed];
  }));
}

function invokeLabel(input: Record<string, unknown>): string {
  const role = typeof input.Role === 'string' && input.Role.trim() ? input.Role.trim()
    : typeof input.role === 'string' && input.role.trim() ? input.role.trim() : '';
  if (role) return role;
  const prompt = typeof input.Prompt === 'string' ? input.Prompt : typeof input.prompt === 'string' ? input.prompt : '';
  const line = firstLine(prompt);
  return line ? (line.length > 80 ? `${line.slice(0, 77)}…` : line) : 'Subagent';
}

function invokeKind(input: Record<string, unknown>): string {
  const typeName = typeof input.TypeName === 'string' && input.TypeName.trim() ? input.TypeName.trim()
    : typeof input.typeName === 'string' && input.typeName.trim() ? input.typeName.trim() : '';
  return typeName || 'subagent';
}

function stripStepTimestamps(value: string): string {
  return value.replace(/^(?:(?:Created At|Completed At): [^\n]*\n)+/, '').trimStart();
}

function firstLine(value: string): string {
  const line = value.trim().split(/\r?\n/)[0]?.trim() ?? '';
  return line.length > 140 ? `${line.slice(0, 137)}…` : line;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n…` : value;
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : undefined;
}
