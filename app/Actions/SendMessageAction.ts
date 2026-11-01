import type { BotRelay } from '../Services/BotRelay';
import { ASSISTANT_BOT_ID } from '../Bots/BotIdentity';
import type { DatabaseService } from '../Services/DatabaseService';
import type { IntegratedAgentService } from '../Services/IntegratedAgentService';
import type { TerminalService } from '../Services/TerminalService';
import type { TimelineService } from '../Services/TimelineService';
import type { NotificationActions } from './NotificationActions';
import { sendAgentInput } from '../Services/AgentInputService';

type QueuedResult = { ok: true; delivery: 'queued'; event_id: string; detail: string };

export interface MessageSender {
  session_id: string;
  project_id: string;
  process_id: string | null;
  parent_process_id: string | null;
  session_role: string;
}

// Any agent may message the assistant, so those messages are bounded.
const ASSISTANT_MESSAGE_MAX_BYTES = 8 * 1024;
const ASSISTANT_MESSAGE_WINDOW_MS = 60_000;
const ASSISTANT_MESSAGES_PER_WINDOW = 6;
export const ASSISTANT_FOCUS_DETAIL = 'The assistant is in Focus mode. Your message is held and reaches it when focus ends; do not resend it.';
const REPLY_HINT = '\n\n(Reply with send_message target_process_id "assistant".)';

// Delivers send_message. Targets resolve first, aliases included, so every
// message that reaches the assistant gets the same limits, framing, and
// record. Messages to and from the assistant cross projects and are kept as
// timeline events; report timers count a reply to their owner.
export class SendMessageAction {
  private readonly recent = new Map<string, Array<{ at: number; slot: symbol }>>();

  constructor(
    private readonly database: DatabaseService,
    private readonly terminal: TerminalService,
    private readonly timeline: TimelineService,
    private readonly options: {
      integrated?: Pick<IntegratedAgentService, 'prompt'> | undefined;
      assistant?: Pick<BotRelay, 'deliverAgentMessage'> | undefined;
      notifications?: Pick<NotificationActions, 'userInput'> | undefined;
    } = {}
  ) {}

  // `scoped` applies the caller's ordinary process scope to explicit IDs.
  async execute(sender: MessageSender | null, target: string, message: string, scoped: (processId: string) => string): Promise<'ok' | { ok: true; event_id: string } | QueuedResult | { ok: false; delivery: 'uncertain'; event_id: string; detail: string }> {
    const assistantId = this.liveAssistant();
    const senderIsAssistant = sender?.session_role === 'assistant';
    let targetId: string;
    if (target === 'assistant') {
      if (!assistantId) throw new Error('send_message: the assistant is not running');
      targetId = assistantId;
    } else if (target === 'parent') {
      if (!sender?.parent_process_id) throw new Error('send_message: caller has no parent process');
      targetId = sender.parent_process_id;
    } else {
      targetId = target === assistantId && !senderIsAssistant ? target : scoped(target);
    }

    if (targetId === assistantId) {
      if (senderIsAssistant) throw new Error('send_message: the assistant cannot message itself');
      return this.toAssistant(sender, message);
    }

    const hint = senderIsAssistant ? REPLY_HINT : '';
    const result = await sendAgentInput(this.database, this.terminal, { process_id: targetId, kind: 'text', text: `[message from ${sender?.process_id ?? 'unknown'}]\n${message}${hint}`, submit: true }, this.options.integrated);
    // An Integrated agent may or may not have received an ambiguous
    // submission. It is reported as uncertain, never resent, and does not
    // count as answering the agent.
    if ((result as { delivery?: unknown } | null | undefined)?.delivery === 'uncertain') {
      return { ok: false, delivery: 'uncertain', event_id: sender ? this.record(sender, targetId, message, 'uncertain') : '',
        detail: 'The agent may or may not have received this message. Do not resend it blindly; check with get_conversation_output.' };
    }
    // A held message is stored durably and counts as sent; the agent reads it
    // when its current turn, such as a compaction, ends.
    const queued = queuedDetail(result);
    // A parent's reply ends its child's blocked episode, so the next request
    // reaches the parent again. Other senders leave the target's requests open.
    if (!sender || this.parentOf(targetId) === sender.process_id) this.options.notifications?.userInput(targetId);
    if (queued) return { ok: true, delivery: 'queued', event_id: sender ? this.record(sender, targetId, message) : '', detail: queued };
    return senderIsAssistant && sender ? { ok: true, event_id: this.record(sender, targetId, message) } : 'ok';
  }

  private async toAssistant(sender: MessageSender | null, message: string): Promise<{ ok: true; event_id: string } | QueuedResult | { ok: false; delivery: 'uncertain'; event_id: string; detail: string }> {
    if (!this.options.assistant) throw new Error('send_message: the assistant is unavailable');
    if (!sender?.process_id) throw new Error('send_message: only agents can message the assistant');
    if (Buffer.byteLength(message, 'utf8') > ASSISTANT_MESSAGE_MAX_BYTES) throw new Error('send_message: messages to the assistant are limited to 8 KB; put details in a scratchpad and link it');
    // Reserve the slot before delivering, so concurrent calls count each other.
    const slot = Symbol('message');
    const now = Date.now();
    const recent = (this.recent.get(sender.process_id) ?? []).filter((entry) => now - entry.at < ASSISTANT_MESSAGE_WINDOW_MS);
    if (recent.length >= ASSISTANT_MESSAGES_PER_WINDOW) throw new Error('send_message: too many messages to the assistant; wait a minute');
    this.recent.set(sender.process_id, [...recent, { at: now, slot }]);
    let delivered: { process_id: string; delivery: 'delivered' | 'uncertain' | 'queued'; detail?: string };
    try {
      delivered = await this.options.assistant.deliverAgentMessage(ASSISTANT_BOT_ID, sender.process_id, message);
    } catch (error) {
      // An undelivered message does not count against the sender.
      this.recent.set(sender.process_id, (this.recent.get(sender.process_id) ?? []).filter((entry) => entry.slot !== slot));
      throw error;
    }
    // An uncertain delivery keeps its slot and is recorded as uncertain, so
    // report timers do not treat it as a reply.
    if (delivered.delivery === 'uncertain') {
      return { ok: false, delivery: 'uncertain', event_id: this.record(sender, delivered.process_id, message, 'uncertain'),
        detail: 'The assistant may or may not have received this message. Do not resend it unless the assistant asks.' };
    }
    // A held message is stored durably, so it counts as sent; the
    // assistant reads it when Focus mode or its current compaction ends.
    if (delivered.delivery === 'queued') {
      return { ok: true, delivery: 'queued', event_id: this.record(sender, delivered.process_id, message), detail: delivered.detail ?? ASSISTANT_FOCUS_DETAIL };
    }
    return { ok: true, event_id: this.record(sender, delivered.process_id, message) };
  }

  private liveAssistant(): string | null {
    return (this.database.connection.prepare(`select sessions.process_id from sessions join processes on processes.id = sessions.process_id
      where sessions.session_role = 'assistant' and sessions.exited_at is null and processes.status = 'running'
      order by sessions.started_at desc limit 1`).get() as { process_id: string } | undefined)?.process_id ?? null;
  }

  private parentOf(processId: string): string | null {
    return (this.database.connection.prepare(`select parent_process_id from processes where id = ?`).get(processId) as { parent_process_id: string | null } | undefined)?.parent_process_id ?? null;
  }

  private record(sender: MessageSender, toProcessId: string, body: string, delivery: 'delivered' | 'uncertain' = 'delivered'): string {
    return this.timeline.append({
      event_type: 'message.sent',
      project_id: sender.project_id,
      session_id: sender.session_id,
      process_id: sender.process_id,
      actor_type: 'agent',
      actor_id: sender.session_id,
      metadata: { to_process_id: toProcessId, body, ...(delivery === 'uncertain' ? { delivery } : {}) }
    });
  }
}

// The detail of an Integrated prompt Patterm held for later delivery.
export function queuedDetail(result: unknown): string | null {
  const value = result as { delivery?: unknown; detail?: unknown } | null | undefined;
  return value?.delivery === 'queued' && typeof value.detail === 'string' ? value.detail : null;
}
