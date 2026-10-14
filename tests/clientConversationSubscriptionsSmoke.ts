import assert from 'node:assert/strict';
import { BrowserTerminalSessions } from '../app/Http/BrowserTerminalSessions';
import { ClientConversationSubscriptions, updateConversationSubscription } from '../app/Http/ClientConversationSubscriptions';
import type { PattermApplication } from '../app/App';

async function main(): Promise<void> {
  const releases: string[] = [];
  const listeners = new Map<string, (payload: unknown) => void>();
  const pending: Array<{ processId: string; resolve: (release: () => void) => void }> = [];
  const forwarded: unknown[] = [];
  const subscriptions = new ClientConversationSubscriptions(
    (processId, listener) => new Promise((resolve) => {
      listeners.set(processId, listener);
      pending.push({ processId, resolve });
    }),
    (payload) => forwarded.push(payload)
  );

  // A subscribe that resolves after its unsubscribe must release itself instead
  // of leaving a native listener installed.
  const stale = subscriptions.add('A');
  subscriptions.remove('A');
  pending.shift()!.resolve(() => releases.push('A'));
  await stale;
  assert.deepEqual(releases, ['A'], 'a stale subscribe releases after unsubscribe');

  // Concurrent intent shares one native subscription and forwards once.
  const first = subscriptions.add('B');
  const second = subscriptions.add('B');
  assert.equal(pending.filter((entry) => entry.processId === 'B').length, 1, 'one native subscription for concurrent intent');
  pending.filter((entry) => entry.processId === 'B')[0]!.resolve(() => releases.push('B'));
  await Promise.all([first, second]);
  listeners.get('B')!({ processId: 'B', value: 1 });
  assert.equal(forwarded.length, 1);
  subscriptions.remove('B');
  assert.deepEqual(releases, ['A', 'B']);
  listeners.get('B')!({ processId: 'B', value: 2 });
  assert.equal(forwarded.length, 1, 'nothing forwards after unsubscribe');

  // Unsubscribe then re-subscribe while the first request is pending keeps the
  // newest intent without releasing it.
  const third = subscriptions.add('C');
  subscriptions.remove('C');
  const fourth = subscriptions.add('C');
  pending.filter((entry) => entry.processId === 'C')[0]!.resolve(() => releases.push('C'));
  await Promise.all([third, fourth]);
  assert.deepEqual(releases, ['A', 'B'], 'the re-subscribed intent stays installed');
  listeners.get('C')!({ processId: 'C', value: 3 });
  assert.equal(forwarded.length, 2);
  subscriptions.remove('C');
  assert.deepEqual(releases, ['A', 'B', 'C']);

  // A disconnected client releases every native listener, and the agents keep
  // running because only the listener is released.
  const attached = new ClientConversationSubscriptions(
    async () => () => releases.push('disposed'),
    (payload) => forwarded.push(payload)
  );
  await attached.add('D');
  attached.dispose();
  assert.deepEqual(releases, ['A', 'B', 'C', 'disposed']);
  await attached.add('E');
  assert.equal(pending.filter((entry) => entry.processId === 'E').length, 0, 'a disposed client never subscribes again');

  // BrowserTerminalSessions.disconnect is the WebSocket close path.
  // The relay service learns who controls this host's terminals.
  const remote = { trackLocalControl: () => undefined, onControlLost: () => () => undefined };
  const sessions = new BrowserTerminalSessions({ remote } as unknown as PattermApplication);
  const disposed: string[] = [];
  const client = {
    subscriptions: new Set<string>(),
    sendEvent: () => {},
    conversations: new ClientConversationSubscriptions(
      async () => () => disposed.push('conversation'),
      () => {}
    )
  };
  await client.conversations.add('F');
  await sessions.disconnect(client);
  assert.deepEqual(disposed, ['conversation'], 'a closed browser releases conversation listeners');

  // A stale UI may believe it controls the conversation. A denied write must
  // publish the authoritative state so the composer can show Take control.
  const controlEvents: unknown[] = [];
  const controlSessions = new BrowserTerminalSessions({ remote: {
    ...remote, target: () => 'paired-host'
  } } as unknown as PattermApplication);
  const staleClient = { subscriptions: new Set<string>(), sendEvent: (event: string, payload: unknown) => controlEvents.push({ event, payload }) };
  assert.throws(() => controlSessions.guard(staleClient, { process_id: 'host:assistant' }), /Take control/);
  assert.deepEqual(controlEvents, [{ event: 'terminal-control', payload: { processId: 'host:assistant', controlling: false } }], 'a denied write restores the takeover prompt even if the subscription was lost');

  // The per-client cap is enforced synchronously.
  const capped = new ClientConversationSubscriptions(async () => () => {}, () => {}, 1);
  await capped.add('G');
  await assert.rejects(capped.add('H'), /Too many conversation subscriptions/);

  // A subscribe can carry the conversation, read once the subscription is in
  // place, so a pane opens with one round trip.
  const order: string[] = [];
  const replying = new ClientConversationSubscriptions(async (processId) => { order.push(`subscribe ${processId}`); return () => order.push(`release ${processId}`); }, () => {});
  const read = async (processId: string) => { order.push(`read ${processId}`); return { messages: [processId] }; };
  assert.deepEqual(await updateConversationSubscription(replying, { process_id: 'J', subscribed: true }, read), { ok: true });
  assert.deepEqual(await updateConversationSubscription(replying, { process_id: 'K', subscribed: true, snapshot: true }, read), { ok: true, snapshot: { messages: ['K'] } });
  assert.deepEqual(order, ['subscribe J', 'subscribe K', 'read K'], 'the snapshot is read after the subscription starts');
  assert.deepEqual(await updateConversationSubscription(replying, { process_id: 'K', subscribed: false, snapshot: true }, read), { ok: true }, 'an unsubscribe reads nothing');
  assert.equal(order.at(-1), 'release K');
  const failing = async () => { throw new Error('Integrated session is not active'); };
  assert.deepEqual(await updateConversationSubscription(replying, { process_id: 'L', subscribed: true, snapshot: true }, failing), { ok: true, snapshot_error: 'Integrated session is not active' }, 'a failed read is reported, not thrown');
  await assert.rejects(updateConversationSubscription(replying, { process_id: '', subscribed: true }, read));

  console.log('client conversation subscriptions smoke ok');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
