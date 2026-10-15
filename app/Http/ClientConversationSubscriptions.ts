import { z } from 'zod';

// One client's conversation subscriptions, shared by the browser WebSocket and
// Electron IPC transports. Intents are reserved synchronously so an unsubscribe
// that races an in-flight subscribe can never leave a stale native listener
// installed, and every release path is idempotent.

export class ClientConversationSubscriptions {
  private readonly desired = new Set<string>();
  private readonly releases = new Map<string, () => void>();
  private readonly pending = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(
    private readonly subscribe: (processId: string, listener: (payload: unknown) => void) => Promise<() => void>,
    private readonly forward: (payload: unknown) => void,
    private readonly limit = 16
  ) {}

  add(processId: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.desired.has(processId) && this.desired.size >= this.limit) {
      return Promise.reject(new Error('Too many conversation subscriptions'));
    }
    this.desired.add(processId);
    const existing = this.pending.get(processId) ?? (this.releases.has(processId) ? Promise.resolve() : undefined);
    if (existing) return existing;
    const promise = this.subscribe(processId, (payload) => {
      if (this.desired.has(processId)) this.forward(payload);
    }).then((release) => {
      if (this.disposed || !this.desired.has(processId)) release();
      else this.releases.set(processId, release);
    }).finally(() => {
      if (this.pending.get(processId) === promise) this.pending.delete(processId);
    });
    this.pending.set(processId, promise);
    return promise;
  }

  remove(processId: string): void {
    this.desired.delete(processId);
    this.releases.get(processId)?.();
    this.releases.delete(processId);
  }

  // Losing a client releases native listeners only; agents keep running.
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const processId of this.desired) this.releases.get(processId)?.();
    this.desired.clear();
    this.releases.clear();
  }
}

const subscriptionInput = z.object({ process_id: z.string().min(1), subscribed: z.boolean(), snapshot: z.boolean().optional() });

// Applies one subscribe or unsubscribe request from either transport. With
// `snapshot`, the reply also carries the conversation, read after the
// subscription started, so opening a pane takes one round trip. Events that
// raced the read carry newer revisions and are applied after it.
export async function updateConversationSubscription(
  subscriptions: ClientConversationSubscriptions,
  raw: unknown,
  read: (processId: string) => Promise<unknown>
): Promise<ConversationSubscriptionReply> {
  return (await beginConversationSubscription(subscriptions, raw, read))();
}

export type ConversationSubscriptionReply = { ok: true; snapshot?: unknown; snapshot_error?: string };

// Applies the subscription change and returns how to finish the reply. The
// change must keep its place among the client's requests; the snapshot read
// that follows need not, so a transport can answer it without holding later
// requests, such as terminal input, behind a large conversation.
export async function beginConversationSubscription(
  subscriptions: ClientConversationSubscriptions,
  raw: unknown,
  read: (processId: string) => Promise<unknown>
): Promise<() => Promise<ConversationSubscriptionReply>> {
  const input = subscriptionInput.parse(raw);
  if (!input.subscribed) {
    subscriptions.remove(input.process_id);
    return async () => ({ ok: true });
  }
  await subscriptions.add(input.process_id);
  if (!input.snapshot) return async () => ({ ok: true });
  return async () => ({ ok: true, ...await readSnapshot(input.process_id, read) });
}

// The conversation for a reply, or the reason it could not be read.
async function readSnapshot(processId: string, read: (processId: string) => Promise<unknown>): Promise<{ snapshot: unknown } | { snapshot_error: string }> {
  try {
    return { snapshot: await read(processId) };
  } catch (error) {
    return { snapshot_error: error instanceof Error ? error.message : String(error) };
  }
}
