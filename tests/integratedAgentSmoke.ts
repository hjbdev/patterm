import assert from 'node:assert/strict';
import { mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../app/Services/DatabaseService';
import { TurnBusyError, UncertainDeliveryError } from '../app/Services/IntegratedDelivery';
import type { IntegratedConversationEvent, IntegratedConversationListener } from '../app/Services/IntegratedConversation';
import type { AgentHistoryReadService } from '../app/Services/AgentHistory/AgentHistoryReadService';
import { IntegratedAgentService, type IntegratedProviderService } from '../app/Services/IntegratedAgentService';
import { McpToolRegistry } from '../app/MCP/ToolRegistry';

async function main(): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-integrated-agent-'));
  const database = new DatabaseService(directory);
  try {
    database.initialize();
    const now = new Date().toISOString();
    database.connection.prepare('insert into projects (id,name,path,created_at,updated_at) values (?,?,?,?,?)').run('project_test', 'Test', directory, now, now);
    database.connection.prepare(`insert into processes (id,project_id,kind,name,status,activity,created_at,updated_at) values ('process_test','project_test','agent','Test','running','idle',?,?)`).run(now, now);
    database.connection.prepare(`insert into sessions (id,project_id,process_id,harness,interface_mode,started_at,session_role,resume_status,created_by_actor) values ('session_test','project_test','process_test','codex','integrated',?,'orchestrator','found','user')`).run(now);

    let status = 'working';
    const provider: IntegratedProviderService = {
      prepare: async () => ({ resumeId: 'thread_test', argv: [] }),
      conversation: async () => ({ status }),
      prompt: async () => ({ id: 'message_test' }),
      interrupt: async () => {},
      replyPermission: async () => {},
      replyQuestion: async () => {},
      command: async () => ({ ok: true })
    };
    const changes: string[] = [];
    const service = new IntegratedAgentService(database, { codex: provider }, () => changes.push('changed'));
    const activity = () => (database.connection.prepare(`select activity from processes where id = 'process_test'`).get() as { activity: string }).activity;

    // A send from idle is a genuine transition even when the caller does not
    // broadcast the mutating tool (the browser socket control path).
    await service.prompt('process_test', 'Hello');
    assert.equal(activity(), 'working');
    assert.deepEqual(changes, ['changed'], 'prompt notifies the idle -> working transition');

    // A read that confirms the same activity adds nothing: no read storm.
    await service.conversation('process_test');
    assert.deepEqual(changes, ['changed']);

    // The next genuine transition notifies again.
    status = 'idle';
    await service.conversation('process_test');
    assert.equal(activity(), 'idle');
    assert.deepEqual(changes, ['changed', 'changed']);

    // Commands also notify when they start work. Not every command starts a
    // turn, so the native state decides.
    status = 'working';
    await service.command('process_test', 'compact', '');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(activity(), 'working');
    assert.deepEqual(changes, ['changed', 'changed', 'changed']);

    // A mid-turn send does not repeat the notification.
    await service.prompt('process_test', 'Again');
    assert.deepEqual(changes, ['changed', 'changed', 'changed']);

    // Accepted prompts refresh the native title in the background.
    const titled: IntegratedProviderService = { ...provider, title: async (_processId, prompt) => `Native: ${prompt}` };
    const titleChanges: string[] = [];
    const titledService = new IntegratedAgentService(database, { codex: titled }, () => titleChanges.push('changed'));
    database.connection.prepare(`update processes set activity = 'working' where id = 'process_test'`).run();
    await titledService.prompt('process_test', 'Name me');
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const lastTitle = (database.connection.prepare(`select last_title from sessions where id = 'session_test'`).get() as { last_title: string }).last_title;
    assert.equal(lastTitle, 'Native: Name me');
    assert.deepEqual(titleChanges, ['changed'], 'a new native title notifies once');

    // The browser control path calls the registry without the desktop
    // mutating-tool broadcaster, so the service itself must notify.
    const registry = new McpToolRegistry();
    registry.register(
      { name: 'integrated_send', namespace: 'integrated', description: 'Browser control fixture.', inputSchema: { type: 'object' } },
      async (args) => service.prompt((args as { process_id: string }).process_id, 'Browser send')
    );
    database.connection.prepare(`update processes set activity = 'idle' where id = 'process_test'`).run();
    const before = changes.length;
    await registry.call('integrated_send', { process_id: 'process_test', text: 'Browser send' });
    assert.equal(changes.length, before + 1, 'the browser registry path notifies without a route broadcaster');
    assert.equal(activity(), 'working');

    // Unchanged transcript reads stay silent on the same path.
    const reads = new McpToolRegistry();
    reads.register(
      { name: 'integrated_get', namespace: 'integrated', description: 'Read fixture.', changes: [], inputSchema: { type: 'object' } },
      async () => service.conversation('process_test')
    );
    status = 'working';
    const readCount = changes.length;
    await reads.call('integrated_get', { process_id: 'process_test' });
    assert.equal(changes.length, readCount, 'unchanged transcript reads do not notify');

    // Ambiguous delivery is a visible uncertain result, never a thrown error,
    // and delivery reconciles against native evidence.
    const messageId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const uncertain = new IntegratedAgentService(database, {
      codex: {
        ...provider,
        prompt: async () => { throw new UncertainDeliveryError('connection lost', messageId); },
        reconcile: async () => 'accepted'
      }
    });
    assert.deepEqual(
      await uncertain.prompt('process_test', 'uncertain'),
      { delivery: 'uncertain', message_id: messageId, error: 'connection lost' }
    );
    assert.deepEqual(await uncertain.delivery('process_test', messageId), { state: 'accepted' });
    assert.deepEqual(await service.delivery('process_test', messageId), { state: 'unknown' }, 'no native evidence means unknown');

    // Repeated ids share in-flight work, replay known acceptances, and reject a
    // changed payload under the same identity.
    let nativePrompts = 0;
    const ledgerProvider: IntegratedProviderService = {
      ...provider,
      prompt: async () => { nativePrompts++; return { turnId: `turn_${nativePrompts}` }; },
      reconcile: async () => 'unknown'
    };
    const ledger = new IntegratedAgentService(database, { codex: ledgerProvider });
    const acceptedOnce = await ledger.prompt('process_test', { text: 'same payload', messageId: 'ledger-1' });
    assert.equal(nativePrompts, 1);
    assert.deepEqual(await ledger.prompt('process_test', { text: 'same payload', messageId: 'ledger-1' }), acceptedOnce, 'an accepted id replays without a second native call');
    assert.equal(nativePrompts, 1);
    await assert.rejects(ledger.prompt('process_test', { text: 'changed payload', messageId: 'ledger-1' }), /different payload/);

    // Simultaneous identical calls from separate clients share one native call.
    let slowCalls = 0;
    let releaseSlow: ((value: unknown) => void) | undefined;
    const slow = new IntegratedAgentService(database, {
      codex: {
        ...provider,
        prompt: () => { slowCalls++; return new Promise((resolve) => { releaseSlow = resolve; }); }
      }
    });
    const inflightA = slow.prompt('process_test', { text: 'concurrent', messageId: 'ledger-2' });
    const inflightB = slow.prompt('process_test', { text: 'concurrent', messageId: 'ledger-2' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(slowCalls, 1, 'a repeated in-flight id does not start a second native call');
    releaseSlow?.({ turnId: 'turn_concurrent' });
    assert.deepEqual(await inflightA, { turnId: 'turn_concurrent' });
    assert.deepEqual(await inflightB, { turnId: 'turn_concurrent' });

    // Uncertainty survives a service restart: the id reconciles and is never
    // silently admitted again.
    const uncertainId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const uncertainProvider: IntegratedProviderService = {
      ...provider,
      prompt: async () => { throw new UncertainDeliveryError('reply lost', uncertainId); },
      reconcile: async () => 'unknown'
    };
    const firstRun = new IntegratedAgentService(database, { codex: uncertainProvider });
    assert.equal(((await firstRun.prompt('process_test', { text: 'maybe admitted', messageId: uncertainId })) as { delivery: string }).delivery, 'uncertain');
    const restarted = new IntegratedAgentService(database, {
      codex: { ...uncertainProvider, prompt: async () => { throw new Error('must not be called again'); } }
    });
    const repeated = await restarted.prompt('process_test', { text: 'maybe admitted', messageId: uncertainId }) as { delivery: string; message_id: string };
    assert.equal(repeated.delivery, 'uncertain', 'a restarted backend does not resend an uncertain id');
    assert.equal(repeated.message_id, uncertainId);
    const proven = new IntegratedAgentService(database, {
      codex: { ...uncertainProvider, prompt: async () => { throw new Error('must not be called again'); }, reconcile: async () => 'accepted' }
    });
    assert.deepEqual(await proven.prompt('process_test', { text: 'maybe admitted', messageId: uncertainId }), { delivery: 'accepted', message_id: uncertainId });

    // The ledger is bounded: an id pushed past the window becomes a tombstone
    // that still reconciles instead of being resent as a fresh intent.
    let bulkCalls = 0;
    const bulkProvider: IntegratedProviderService = { ...provider, prompt: async () => { bulkCalls++; return { turnId: 'bulk' }; }, reconcile: async () => 'unknown' };
    const bulk = new IntegratedAgentService(database, { codex: bulkProvider });
    for (let index = 0; index < 501; index++) await bulk.prompt('process_test', { text: `bulk ${index}`, messageId: `bulk-${index}` });
    assert.equal(bulkCalls, 501);
    const forgotten = await bulk.prompt('process_test', { text: 'bulk 0', messageId: 'bulk-0' }) as { delivery: string };
    assert.equal(forgotten.delivery, 'uncertain', 'an evicted-but-remembered id is not resent');
    assert.equal(bulkCalls, 501, 'no native call for the tombstoned id');
    const tombstone = database.connection.prepare(`select state from integrated_submissions where process_id = 'process_test' and message_id = 'bulk-0'`).get() as { state: string };
    assert.equal(tombstone.state, 'forgotten');

    // A definitive rejection clears the id so a deliberate retry may reuse it.
    const retryId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    let attempts = 0;
    const flaky = new IntegratedAgentService(database, {
      codex: { ...provider, prompt: async () => { attempts++; if (attempts === 1) throw new Error('rejected'); return { turnId: 'retry' }; } }
    });
    await assert.rejects(flaky.prompt('process_test', { text: 'retry me', messageId: retryId }), /rejected/);
    assert.deepEqual(await flaky.prompt('process_test', { text: 'retry me', messageId: retryId }), { turnId: 'retry' }, 'a definitive rejection may be retried with the same id');
    assert.equal(attempts, 2);

    // Crash between native admission and acknowledgement: the reservation is
    // written before the provider call, so a restart reconciles instead of
    // resending. The prompt below never resolves, like a lost reply.
    const crashId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    let crashNativeCalls = 0;
    const crash = new IntegratedAgentService(database, {
      codex: {
        ...provider,
        prompt: () => { crashNativeCalls++; return new Promise(() => {}); }
      }
    });
    void crash.prompt('process_test', { text: 'admitted but unacknowledged', messageId: crashId });
    await new Promise((resolve) => setImmediate(resolve));
    const reservation = database.connection.prepare(`select state from integrated_submissions where message_id = ?`).get(crashId) as { state: string } | undefined;
    assert.equal(reservation?.state, 'uncertain', 'the reservation exists before the native acknowledgement');
    const crashRestart = new IntegratedAgentService(database, {
      codex: { ...provider, prompt: async () => { crashNativeCalls++; return { turnId: 'must-not-run' }; }, reconcile: async () => 'unknown' }
    });
    const crashRetry = await crashRestart.prompt('process_test', { text: 'admitted but unacknowledged', messageId: crashId }) as { delivery: string };
    assert.equal(crashRetry.delivery, 'uncertain', 'an interrupted reservation stays uncertain across a restart');
    assert.equal(crashNativeCalls, 1, 'the interrupted id is never sent twice');

    // Payload hashes are cryptographic, and pre-hash rows written with the old
    // canonical payload are still recognised.
    const hashed = database.connection.prepare(`select payload_hash from integrated_submissions where message_id = 'ledger-1'`).get() as { payload_hash: string };
    assert.match(hashed.payload_hash, /^[0-9a-f]{64}$/, 'payload hashes are cryptographic');
    const legacyId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const legacyHash = JSON.stringify(['legacy payload', [], []]);
    database.connection.prepare(`insert into integrated_submissions (process_id, message_id, payload_hash, state, result, error, created_at) values ('process_test', ?, ?, 'accepted', '{"turnId":"legacy"}', null, ?)`)
      .run(legacyId, legacyHash, new Date().toISOString());
    assert.deepEqual(await ledger.prompt('process_test', { text: 'legacy payload', messageId: legacyId }), { turnId: 'legacy' }, 'a pre-hash row still recognises the same payload');
    await assert.rejects(ledger.prompt('process_test', { text: 'different payload', messageId: legacyId }), /different payload/);

    // Process id and session id are aliases for one native process and share a
    // single ledger namespace.
    const aliasId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    const aliasAccepted = await ledger.prompt('process_test', { text: 'alias payload', messageId: aliasId });
    const aliasBefore = nativePrompts;
    assert.deepEqual(await ledger.prompt('session_test', { text: 'alias payload', messageId: aliasId }), aliasAccepted, 'the session id alias replays the same submission');
    assert.equal(nativePrompts, aliasBefore, 'the alias does not reach the native provider again');

    // A bookkeeping failure after admission never deletes the reservation or
    // presents the admitted prompt as a definitive rejection.
    const callbackId = 'dddddddd-eeee-ffff-1111-222222222222';
    const callbackFailure = new IntegratedAgentService(database, {
      codex: { ...provider, prompt: async () => ({ turnId: 'admitted' }) }
    }, () => { throw new Error('workbench broadcast failed'); });
    assert.deepEqual(await callbackFailure.prompt('process_test', { text: 'callback failure', messageId: callbackId }), { turnId: 'admitted' });
    const callbackRow = database.connection.prepare(`select state from integrated_submissions where message_id = ?`).get(callbackId) as { state: string } | undefined;
    assert.equal(callbackRow?.state, 'accepted', 'an admitted prompt keeps its reservation when the activity callback fails');

    // Compacted identities are never deleted: a repeat after far more than the
    // old tombstone window is still reconciled instead of recycled.
    database.connection.prepare(`update integrated_submissions set created_at = '2000-01-01T00:00:00.000Z' where message_id = 'ledger-1'`).run();
    database.connection.exec('begin');
    const bulkInsert = database.connection.prepare("insert into integrated_submissions(process_id,message_id,payload_hash,state,result,error,created_at) values('process_test',?,?,'accepted','{}',null,?)");
    for (let index = 0; index < 5200; index++) bulkInsert.run(`later-${index}`, 'f'.repeat(64), '2026-01-01T00:00:00.000Z');
    database.connection.exec('commit');
    await ledger.prompt('process_test', { text: 'trigger retention', messageId: 'cccccccc-1111-2222-3333-444444444444' });
    const originalRow = database.connection.prepare(`select state from integrated_submissions where message_id = 'ledger-1'`).get() as { state: string } | undefined;
    assert.equal(originalRow?.state, 'forgotten', 'an old accepted id is compacted, not deleted');
    const afterCompaction = nativePrompts;
    const compactedRepeat = await ledger.prompt('process_test', { text: 'same payload', messageId: 'ledger-1' }) as { delivery: string };
    assert.equal(compactedRepeat.delivery, 'uncertain', 'a compacted id is reconciled, never recycled');
    assert.equal(nativePrompts, afterCompaction, 'no native call for the compacted id');

    // Patterm owns /new and /resume. They lead the menu and shadow native
    // commands of the same name, and providers without native commands still offer them.
    const commands = new IntegratedAgentService(database, {
      codex: { ...provider, controls: async () => ({ selectors: [], commands: [{ name: 'new' }, { name: 'resume' }, { name: 'compact' }] }) }
    });
    assert.deepEqual((await commands.controls('process_test')).commands.map((command) => [command.name, command.source ?? 'native']), [['new', 'patterm'], ['resume', 'patterm'], ['restart', 'patterm'], ['compact', 'native']]);
    assert.deepEqual((await service.controls('process_test')).commands.map((command) => command.name), ['new', 'resume', 'restart']);

    // Only a transcript with no messages and nothing older to page in is empty.
    const withConversation = (conversation: unknown) => new IntegratedAgentService(database, { codex: { ...provider, conversation: async () => conversation } });
    assert.equal(await withConversation({ messages: [] }).isEmpty('process_test'), true);
    assert.equal(await withConversation({ messages: { data: [] } }).isEmpty('process_test'), true);
    assert.equal(await withConversation({ messages: [{ id: 'm1' }] }).isEmpty('process_test'), false);
    assert.equal(await withConversation({ messages: { data: [{ id: 'm1' }] } }).isEmpty('process_test'), false);
    assert.equal(await withConversation({ messages: [], history_truncated: true }).isEmpty('process_test'), false);
    assert.equal(await withConversation({ messages: [], history_cursor: 'older' }).isEmpty('process_test'), false);

    // Claude runtimes only hold their own run, so a resumed session pages
    // earlier turns from imported history before the oldest live message.
    // Codex uses the archive only when it cannot list items natively.
    database.connection.prepare(`insert into processes (id,project_id,kind,name,status,activity,created_at,updated_at) values ('process_claude','project_test','agent','Claude','running','idle',?,?)`).run(now, now);
    database.connection.prepare(`insert into sessions (id,project_id,process_id,harness,interface_mode,started_at,session_role,resume_id,resume_status,created_by_actor) values ('session_claude','project_test','process_claude','claude','integrated',?,'orchestrator','claude_native','imported','user')`).run(now);
    database.connection.prepare(`update sessions set resume_id = 'codex_native' where id = 'session_test'`).run();
    const archiveCalls: Array<{ provider: string; resumeId: string; before: string; offset: number; limit: number }> = [];
    const archived = Array.from({ length: 100 }, (_, index) => ({ id: `archived_${index}`, text: `earlier ${index}` }));
    const history = {
      archive: (provider: string, resumeId: string, _projectId: string, before: string, offset: number, limit: number) => {
        archiveCalls.push({ provider, resumeId, before, offset, limit });
        return { count: archived.length, messages: archived.slice(offset, offset + limit) };
      }
    } as unknown as AgentHistoryReadService;
    const liveAt = '2026-09-28T12:00:00.000Z';
    const claudeProvider: IntegratedProviderService = { ...provider, conversation: async () => ({ status: 'idle', messages: { data: [{ id: 'live', created_at: liveAt }] } }) };
    const resumed = new IntegratedAgentService(database, { claude: claudeProvider });
    resumed.setHistoryReadService(history);
    const claudeSnapshot = await resumed.conversation('process_claude') as { history_truncated: boolean; history_cursor: { next: string } };
    assert.equal(claudeSnapshot.history_truncated, true);
    assert.deepEqual(archiveCalls.at(-1), { provider: 'claude', resumeId: 'claude_native', before: liveAt, offset: 0, limit: 0 }, 'the archive stops at the oldest live message');
    const newestArchive = await resumed.olderMessages('process_claude', claudeSnapshot.history_cursor.next) as { archived_messages: Array<{ id: string }>; cursor: string | null };
    assert.deepEqual(newestArchive.archived_messages.map((message) => message.id), archived.slice(20).map((message) => message.id), 'the newest archived page comes first');
    const oldestArchive = await resumed.olderMessages('process_claude', newestArchive.cursor!) as { archived_messages: Array<{ id: string }>; cursor: string | null };
    assert.deepEqual(oldestArchive.archived_messages.map((message) => message.id), archived.slice(0, 20).map((message) => message.id));
    assert.equal(oldestArchive.cursor, null);

    const nativeCodex = new IntegratedAgentService(database, { codex: { ...provider, conversation: async () => ({ status: 'idle', messages: { data: [] }, history_cursor: { next: 'native' }, history_truncated: true }), olderMessages: async (_id, cursor) => ({ native: cursor }) } });
    nativeCodex.setHistoryReadService(history);
    assert.deepEqual((await nativeCodex.conversation('process_test') as { history_cursor: unknown }).history_cursor, { next: 'native' }, 'Codex keeps its native cursor');
    assert.deepEqual(await nativeCodex.olderMessages('process_test', 'native'), { native: 'native' });
    const legacyCodex = new IntegratedAgentService(database, { codex: { ...provider, conversation: async () => ({ status: 'idle', messages: { data: [] }, history_unavailable: true }) } });
    legacyCodex.setHistoryReadService(history);
    const legacySnapshot = await legacyCodex.conversation('process_test') as { history_unavailable: boolean; history_cursor: { next: string } };
    assert.equal(legacySnapshot.history_unavailable, false, 'Codex builds without item listing fall back to imported history');
    assert.equal(archiveCalls.at(-1)?.provider, 'codex');
    assert.ok(legacySnapshot.history_cursor.next.startsWith('archive:'));

    database.connection.prepare("update processes set status = 'failed' where id = 'process_claude'").run();
    database.connection.prepare('update sessions set exited_at = ? where process_id = ?').run(now, 'process_claude');
    let deadNativeReads = 0;
    const savedService = new IntegratedAgentService(database, { claude: { ...provider, conversation: async () => { deadNativeReads++; throw new Error('host gone'); } } });
    savedService.setHistoryReadService(history);
    const saved = await savedService.peekConversation('process_claude') as { archived_messages: Array<{ id: string }>; history_cursor: { next: string } };
    assert.deepEqual(saved.archived_messages.map((row) => row.id), archived.slice(20).map((row) => row.id), 'reopening a dead session reads the saved tail');
    assert.equal(deadNativeReads, 0, 'saved reads never call the dead native host');
    const savedOlder = await savedService.olderMessages('process_claude', saved.history_cursor.next) as { archived_messages: Array<{ id: string }>; cursor: string | null };
    assert.deepEqual(savedOlder.archived_messages.map((row) => row.id), archived.slice(0, 20).map((row) => row.id));
    assert.equal(savedOlder.cursor, null);

    // Stop is best effort on interrupt: a host whose native process already
    // exited has nothing to interrupt, but it still must be stopped.
    const stopCalls: string[] = [];
    const deadHost = new IntegratedAgentService(database, {
      codex: {
        ...provider,
        interrupt: async () => { throw new Error('Claude process is not running'); },
        stop: async () => { stopCalls.push('stop'); }
      }
    });
    await deadHost.stop('process_test');
    assert.deepEqual(stopCalls, ['stop'], 'a dead native process is still stopped after a failed interrupt');

    // A genuine stop failure is never hidden: the caller can tell the host did
    // not stop instead of seeing a false success.
    const stuckHost = new IntegratedAgentService(database, {
      codex: { ...provider, interrupt: async () => {}, stop: async () => { throw new Error('host is still alive'); } }
    });
    await assert.rejects(stuckHost.stop('process_test'), /host is still alive/);

    await observedActivity(database);
    await activityContract(database);
    await heldPrompts(database);
  } finally {
    database.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// Activity follows the native turn without a viewer: the service observes
// every live agent and persists streamed status in order.
async function observedActivity(database: DatabaseService): Promise<void> {
  const now = new Date().toISOString();
  database.connection.prepare(`insert into processes (id,project_id,kind,name,status,activity,created_at,updated_at) values ('process_observed','project_test','agent','Observed','running','idle',?,?)`).run(now, now);
  database.connection.prepare(`insert into sessions (id,project_id,process_id,harness,interface_mode,started_at,session_role,resume_status,created_by_actor) values ('session_observed','project_test','process_observed','codex','integrated',?,'sub-agent','found','user')`).run(now);
  const activity = () => (database.connection.prepare(`select activity from processes where id = 'process_observed'`).get() as { activity: string }).activity;
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  const listeners = new Set<IntegratedConversationListener>();
  let subscriptions = 0;
  let snapshot = 'idle';
  let conversation: (() => Promise<unknown>) = async () => ({ status: snapshot });
  let prompt: () => Promise<unknown> = async () => ({ id: 'message_observed' });
  const emit = (event: Omit<IntegratedConversationEvent, 'processId' | 'revision'>) => {
    for (const listener of listeners) listener({ ...event, processId: 'process_observed', revision: 1 });
  };
  const provider: IntegratedProviderService = {
    prepare: async () => ({ resumeId: 'thread_observed', argv: [] }),
    conversation: () => conversation(),
    prompt: () => prompt(),
    interrupt: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    stop: async () => {},
    subscribe: async (_processId, listener) => {
      subscriptions += 1;
      listeners.add(listener);
      return () => { listeners.delete(listener); subscriptions -= 1; };
    }
  };
  let changes = 0;
  const service = new IntegratedAgentService(database, { codex: provider }, () => { changes += 1; });

  // No viewer: a finished turn still reaches the database, once.
  service.observe('session_observed');
  service.observe('process_observed');
  await settle();
  assert.equal(subscriptions, 1, 'aliases share one observation');
  emit({ kind: 'status', status: 'working' });
  assert.equal(activity(), 'working');
  const before = changes;
  emit({ kind: 'status', status: 'working' });
  assert.equal(changes, before, 'a repeated status does not notify');
  emit({ kind: 'status', status: 'idle' });
  assert.equal(activity(), 'idle', 'an unwatched agent goes idle');

  // Viewers share the observed subscription and leave it open on release.
  const release = await service.subscribeConversation('process_observed', () => { throw new Error('viewer failure'); });
  assert.equal(subscriptions, 1);
  emit({ kind: 'status', status: 'working' });
  assert.equal(activity(), 'working', 'a throwing viewer does not stop persistence');
  release();
  assert.equal(subscriptions, 1);

  // A turn that finishes before the prompt call returns is not overwritten by
  // the post-admission working mark.
  prompt = async () => { emit({ kind: 'status', status: 'working' }); emit({ kind: 'status', status: 'idle' }); return { id: 'fast' }; };
  await service.prompt('process_observed', 'Quick');
  assert.equal(activity(), 'idle', 'a completed fast turn stays idle');

  // A snapshot that started before a newer streamed status does not win.
  let resolveSnapshot!: (value: unknown) => void;
  conversation = () => new Promise((resolve) => { resolveSnapshot = resolve; });
  const read = service.conversation('process_observed');
  emit({ kind: 'status', status: 'working' });
  resolveSnapshot({ status: 'idle' });
  await read;
  assert.equal(activity(), 'working', 'a stale snapshot does not overwrite a newer status');

  // Pending refreshes pick up permission a provider does not stream.
  conversation = async () => ({ status: snapshot });
  snapshot = 'permission';
  emit({ kind: 'pending' });
  await settle();
  assert.equal(activity(), 'permission');

  // A background task, such as a shell the agent waits on, is counted from the
  // snapshot a pending event re-reads. Activity stays as the harness says.
  const backgroundTasks = () => (database.connection.prepare(`select background_tasks from processes where id = 'process_observed'`).get() as { background_tasks: number }).background_tasks;
  const updatedAt = () => (database.connection.prepare(`select updated_at from processes where id = 'process_observed'`).get() as { updated_at: string }).updated_at;
  snapshot = 'idle';
  emit({ kind: 'status', status: 'idle' });
  const idleSince = updatedAt();
  let tasks: unknown[] = [{ id: 'shell', kind: 'shell', status: 'running' }, { id: 'old', kind: 'shell', status: 'completed' }, { id: 'queued', status: 'pending' }];
  conversation = async () => ({ status: snapshot, tasks });
  const beforeTasks = changes;
  emit({ kind: 'pending' });
  await settle();
  assert.equal(backgroundTasks(), 2, 'running and pending tasks are counted');
  assert.equal(activity(), 'idle', 'background tasks leave activity alone');
  assert.equal(updatedAt(), idleSince, 'the count does not look like activity to idle timers');
  assert.equal(changes, beforeTasks + 1, 'a count change refreshes the workbench');
  emit({ kind: 'pending' });
  await settle();
  assert.equal(changes, beforeTasks + 1, 'an unchanged count does not');
  tasks = [{ id: 'shell', kind: 'shell', status: 'completed' }];
  emit({ kind: 'pending' });
  await settle();
  assert.equal(backgroundTasks(), 0, 'finished tasks are not counted');

  // Only the agent's own reads, one at a time, set the count, so a viewer's
  // older read that lands late cannot bring back a finished task.
  tasks = [{ id: 'shell', status: 'running' }];
  emit({ kind: 'pending' });
  await settle();
  assert.equal(backgroundTasks(), 1);
  let releaseOlder!: (value: unknown) => void;
  conversation = () => new Promise((resolve) => { releaseOlder = resolve; });
  const olderRead = service.conversation('process_observed');
  tasks = [];
  conversation = async () => ({ status: snapshot, tasks });
  emit({ kind: 'pending' });
  await settle();
  assert.equal(backgroundTasks(), 0);
  releaseOlder({ status: 'idle', tasks: [{ id: 'shell', status: 'running' }] });
  await olderRead;
  assert.equal(backgroundTasks(), 0, 'a late, older read does not restore a finished task');

  // OpenCode ends a subagent task with a status alone; while tasks are
  // counted, a status re-reads them.
  tasks = [{ id: 'child', kind: 'subagent', status: 'running' }];
  emit({ kind: 'pending' });
  await settle();
  assert.equal(backgroundTasks(), 1);
  tasks = [];
  emit({ kind: 'status', status: 'idle' });
  await settle();
  assert.equal(backgroundTasks(), 0, 'a status alone clears finished tasks');

  // A turn that ends with a new task and no pending event counts it.
  tasks = [{ id: 'shell', kind: 'shell', status: 'running' }];
  emit({ kind: 'status', status: 'working' });
  emit({ kind: 'status', status: 'idle' });
  await settle();
  assert.equal(backgroundTasks(), 1, 'a turn\'s end counts the tasks it started');

  // A read in flight when a task ends may predate the end; the turn's end
  // queues another read behind it.
  tasks = [];
  emit({ kind: 'pending' });
  await settle();
  assert.equal(backgroundTasks(), 0);
  let releaseInFlight!: (value: unknown) => void;
  conversation = () => new Promise((resolve) => { releaseInFlight = resolve; });
  tasks = [{ id: 'child', status: 'running' }];
  emit({ kind: 'pending' });
  await settle();
  conversation = async () => ({ status: snapshot, tasks: [] });
  emit({ kind: 'status', status: 'idle' });
  releaseInFlight({ status: 'idle', tasks: [{ id: 'child', status: 'running' }] });
  await settle();
  await settle();
  assert.equal(backgroundTasks(), 0, 'a read that predates a task\'s end does not leave it counted');
  conversation = async () => ({ status: snapshot });

  // A turn that ended while disconnected is caught by the reconnect handoff.
  snapshot = 'idle';
  emit({ kind: 'reconnecting' });
  emit({ kind: 'replace', message: { id: 'm', role: 'assistant', kind: 'text', text: 'done' } });
  await settle();
  assert.equal(activity(), 'idle', 'reconnect re-reads the snapshot');

  // A provider that gives up reconnecting gets a fresh subscription later, and
  // the agent's activity is re-read once it is back.
  const viewerEvents: string[] = [];
  const releaseViewer = await service.subscribeConversation('process_observed', (event) => viewerEvents.push(event.kind));
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    emit({ kind: 'error', id: 'connection_error', delta: 'gone' });
    assert.equal(subscriptions, 0, 'the dead provider subscription is released');
    snapshot = 'error';
    mock.timers.tick(30_000);
  } finally {
    mock.timers.reset();
  }
  await settle();
  assert.equal(subscriptions, 1, 'a fresh provider subscription replaces the dead one');
  emit({ kind: 'pending' });
  await settle();
  assert.equal(activity(), 'error', 'observation survives the provider giving up');
  assert.equal(viewerEvents.at(-1), 'pending', 'open viewers move to the fresh subscription');
  releaseViewer();

  // Stop releases observation; later events and writes are ignored.
  await service.stop('process_observed');
  assert.equal(subscriptions, 0, 'stop releases the observation');
  database.connection.prepare(`update processes set status = 'stopped' where id = 'process_observed'`).run();
  service.observe('process_observed');
  await settle();
  assert.equal(subscriptions, 0, 'a stopped agent is not observed');

  // Disposal releases observation without stopping the native host.
  database.connection.prepare(`update processes set status = 'running' where id = 'process_observed'`).run();
  service.observe('process_observed');
  await settle();
  assert.equal(subscriptions, 1);
  service.dispose();
  assert.equal(subscriptions, 0, 'dispose releases every observation');
}

// How streamed status, snapshots, prompts and commands combine into the
// activity tabs, timers and notifications read.
async function activityContract(database: DatabaseService): Promise<void> {
  const now = new Date().toISOString();
  database.connection.prepare(`insert into processes (id,project_id,kind,name,status,activity,created_at,updated_at) values ('process_contract','project_test','agent','Contract','running','idle',?,?)`).run(now, now);
  database.connection.prepare(`insert into sessions (id,project_id,process_id,harness,interface_mode,started_at,session_role,resume_status,created_by_actor) values ('session_contract','project_test','process_contract','codex','integrated',?,'sub-agent','found','user')`).run(now);
  const activity = () => (database.connection.prepare(`select activity from processes where id = 'process_contract'`).get() as { activity: string }).activity;
  const settle = async () => { for (let index = 0; index < 5; index++) await new Promise((resolve) => setImmediate(resolve)); };

  const listeners = new Set<IntegratedConversationListener>();
  let subscriptions = 0;
  let snapshot: string | undefined = 'idle';
  let busy = false;
  const sent: string[] = [];
  const emit = (event: Omit<IntegratedConversationEvent, 'processId' | 'revision'>) => {
    for (const listener of listeners) listener({ ...event, processId: 'process_contract', revision: 1 });
  };
  const provider: IntegratedProviderService = {
    prepare: async () => ({ resumeId: 'thread_contract', argv: [] }),
    conversation: async () => ({ status: snapshot }),
    prompt: async (_processId, input) => {
      if (busy) throw new TurnBusyError('failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }', 'compact');
      sent.push(input.text);
      return { id: `message_${sent.length}` };
    },
    command: async () => ({}),
    interrupt: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    stop: async () => {},
    subscribe: async (_processId, listener) => {
      subscriptions += 1;
      listeners.add(listener);
      return () => { listeners.delete(listener); subscriptions -= 1; };
    }
  };
  const logged: Array<{ event: string; data: unknown }> = [];
  const service = new IntegratedAgentService(database, { codex: provider });
  service.setDebugLog({ write: (_source, event, data) => { logged.push({ event, data }); } });
  service.observe('process_contract');
  await settle();

  // Permission streams as its own status.
  emit({ kind: 'status', status: 'working' });
  emit({ kind: 'status', status: 'permission' });
  assert.equal(activity(), 'permission', 'a streamed permission reaches the database');
  assert.deepEqual(logged.filter((entry) => entry.event === 'activity').at(-1)?.data,
    { processId: 'process_contract', previous: 'working', activity: 'permission', snapshot: false }, 'transitions are debug logged');

  // A prompt does not answer the permission the agent waits for.
  snapshot = 'permission';
  await service.prompt('process_contract', 'While you wait');
  assert.equal(activity(), 'permission', 'a prompt keeps a pending permission');

  // A command that starts no turn leaves the agent as the native state says.
  emit({ kind: 'status', status: 'idle' });
  snapshot = 'idle';
  await service.command('process_contract', 'rename', 'New name');
  await settle();
  assert.equal(activity(), 'idle', 'a command without a turn does not mark working');
  snapshot = 'working';
  await service.command('process_contract', 'review', '');
  await settle();
  assert.equal(activity(), 'working', 'a command that started a turn reads as working');

  // A held prompt is retried on any status, even one that does not change
  // activity, such as a compaction ending while background agents run.
  busy = true;
  const held = await service.prompt('process_contract', 'After compaction') as { delivery: string };
  assert.equal(held.delivery, 'queued');
  busy = false;
  emit({ kind: 'status', status: 'working' });
  await settle();
  assert.ok(sent.includes('After compaction'), 'an unchanged status retries held prompts');

  // A provider that gave up reconnecting is retried quickly at first.
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    emit({ kind: 'error', id: 'connection_error', delta: 'gone' });
    assert.equal(subscriptions, 0);
    mock.timers.tick(2_000);
  } finally {
    mock.timers.reset();
  }
  await settle();
  assert.equal(subscriptions, 1, 'the first resubscribe comes after two seconds');
  service.dispose();
}

// Prompts a compacting Codex agent rejects wait in order and are sent when the
// compaction turn ends.
async function heldPrompts(database: DatabaseService): Promise<void> {
  const now = new Date().toISOString();
  database.connection.prepare(`insert into processes (id,project_id,kind,name,status,activity,created_at,updated_at) values ('process_held','project_test','agent','Held','running','working',?,?)`).run(now, now);
  database.connection.prepare(`insert into sessions (id,project_id,process_id,harness,interface_mode,started_at,session_role,resume_status,created_by_actor) values ('session_held','project_test','process_held','codex','integrated',?,'sub-agent','found','user')`).run(now);
  const settle = async () => { for (let index = 0; index < 5; index++) await new Promise((resolve) => setImmediate(resolve)); };
  const activity = () => (database.connection.prepare(`select activity from processes where id = 'process_held'`).get() as { activity: string }).activity;

  let busy = true;
  let busyOnce = false;
  let failWith: Error | null = null;
  let gate: Promise<void> | null = null;
  let attempts = 0;
  let snapshot = 'working';
  let messages: unknown[] = [];
  const sent: string[] = [];
  const listeners = new Set<IntegratedConversationListener>();
  const provider: IntegratedProviderService = {
    prepare: async () => ({ resumeId: 'thread_held', argv: [] }),
    conversation: async () => ({ status: snapshot, messages }),
    prompt: async (_processId, input) => {
      attempts++;
      if (busy || busyOnce) {
        busyOnce = false;
        throw new TurnBusyError('failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }', 'compact');
      }
      if (gate) await gate;
      if (failWith) throw failWith;
      sent.push(input.text);
      return { turnId: `turn_${sent.length}` };
    },
    interrupt: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    subscribe: async (_processId, listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }
  };
  const service = new IntegratedAgentService(database, { codex: provider });
  const viewerEvents: IntegratedConversationEvent[] = [];
  const releaseViewer = await service.subscribeConversation('process_held', (event) => viewerEvents.push(event));
  const queue = async () => (await service.conversation('process_held') as { queue?: Array<{ id: string; text: string; delivery: string; reason?: string; error?: string }> }).queue ?? [];

  const first = await service.prompt('process_held', { text: 'Recap please', messageId: 'held-1' }) as { delivery: string; message_id: string; reason: string; detail: string };
  assert.equal(first.delivery, 'queued', 'a busy rejection is held, not failed');
  assert.equal(first.message_id, 'held-1');
  assert.equal(first.reason, 'compact');
  assert.match(first.detail, /compaction/);
  assert.ok(viewerEvents.some((event) => event.kind === 'pending' && event.id === 'patterm_held_queue'), 'viewers learn the queue changed');

  // A retry of the same id joins the held prompt instead of sending again.
  assert.equal((await service.prompt('process_held', { text: 'Recap please', messageId: 'held-1' }) as { delivery: string }).delivery, 'queued');
  await assert.rejects(service.prompt('process_held', { text: 'Different', messageId: 'held-1' }), /different payload/);

  // Later prompts, with or without an id, wait behind it in order.
  const report = await service.prompt('process_held', '[report from process_child: completed]') as { delivery: string; message_id: string };
  assert.equal(report.delivery, 'queued');
  assert.match(report.message_id, /^held_/);
  await service.prompt('process_held', { text: 'Cancel me', messageId: 'held-3' });
  await settle();
  assert.deepEqual((await queue()).map((item) => [item.id, item.delivery, item.reason]),
    [['held-1', 'held', 'compact'], [report.message_id, 'held', 'compact'], ['held-3', 'held', 'compact']]);
  assert.equal(await service.isEmpty('process_held'), false, 'held prompts count as conversation');

  await service.updateQueued('process_held', 'held-3', 'cancel');
  const attemptsAtCancel = attempts;
  const attemptsBeforePeek = () => attemptsAtCancel;
  assert.deepEqual((await queue()).map((item) => item.id), ['held-1', report.message_id], 'cancel drops a held prompt');

  // Reading ahead sees the idle snapshot and the held prompts, but changes
  // nothing: no activity change, no delivery.
  busy = false;
  snapshot = 'idle';
  const activityBefore = activity();
  const peeked = await service.peekConversation('process_held') as { queue?: Array<{ id: string }> };
  await settle();
  assert.deepEqual(peeked.queue?.map((item) => item.id), ['held-1', report.message_id], 'a peek shows held prompts');
  assert.deepEqual(sent, [], 'a peek delivers nothing');
  assert.equal(activity(), activityBefore, 'a peek leaves activity alone');
  assert.equal(attempts, attemptsBeforePeek(), 'a peek tries no prompt');

  // The compaction ends: the prompts go out oldest first and leave the queue.
  await service.conversation('process_held');
  await settle();
  assert.deepEqual(sent, ['Recap please', '[report from process_child: completed]']);
  assert.equal(activity(), 'working', 'a sent held prompt starts work');
  snapshot = 'working';
  assert.deepEqual(await queue(), []);
  assert.deepEqual(await service.prompt('process_held', { text: 'Recap please', messageId: 'held-1' }), { turnId: 'turn_1' }, 'the id is now an accepted submission');

  // A definitive failure keeps the prompt queued with its reason, and the
  // next idle transition tries again.
  busy = true;
  await service.prompt('process_held', { text: 'Retry me', messageId: 'held-4' });
  busy = false;
  failWith = new Error('app-server unavailable');
  snapshot = 'idle';
  database.connection.prepare(`update processes set activity = 'working' where id = 'process_held'`).run();
  await service.conversation('process_held');
  await settle();
  assert.deepEqual((await queue()).map((item) => [item.id, item.error]), [['held-4', 'app-server unavailable']]);
  failWith = null;
  await service.updateQueued('process_held', 'held-4', 'steer');
  await settle();
  assert.equal(sent.at(-1), 'Retry me', 'send now retries a failed held prompt');
  assert.deepEqual(await queue(), []);

  // Held prompts survive a restart and go out once the agent is seen idle.
  busy = true;
  database.connection.prepare(`update processes set activity = 'working' where id = 'process_held'`).run();
  await service.prompt('process_held', { text: 'After restart', messageId: 'held-5' });
  releaseViewer();
  busy = false;
  const restarted = new IntegratedAgentService(database, { codex: provider });
  restarted.observe('process_held');
  await settle();
  assert.equal(sent.at(-1), 'After restart');

  // A rejection is retried on the next idle transition, not on Patterm's own
  // queue notices, which the observer also receives.
  const emit = (event: IntegratedConversationEvent) => { for (const listener of listeners) listener(event); };
  busy = true;
  await restarted.prompt('process_held', { text: 'Rejected', messageId: 'held-6' });
  busy = false;
  failWith = new Error('app-server unavailable');
  attempts = 0;
  emit({ processId: 'process_held', revision: 1, kind: 'status', status: 'working' });
  emit({ processId: 'process_held', revision: 2, kind: 'status', status: 'idle' });
  for (let index = 0; index < 5; index++) await settle();
  assert.equal(attempts, 1, 'a rejected held prompt is not retried in a loop');
  failWith = null;
  await restarted.updateQueued('process_held', 'held-6', 'cancel');

  // Once sending starts the prompt is claimed: cancel fails, a retry joins
  // it, and the ledger already holds an uncertain reservation, so a restart
  // mid-call never sends it twice.
  busy = true;
  await restarted.prompt('process_held', { text: 'In flight', messageId: 'held-7' });
  busy = false;
  let open = () => {};
  gate = new Promise((resolve) => { open = resolve; });
  attempts = 0;
  void restarted.updateQueued('process_held', 'held-7', 'steer');
  await settle();
  await assert.rejects(restarted.updateQueued('process_held', 'held-7', 'cancel'), /already being sent/);
  assert.equal((await restarted.prompt('process_held', { text: 'In flight', messageId: 'held-7' }) as { delivery: string }).delivery, 'queued');
  assert.equal(attempts, 1);
  assert.equal((database.connection.prepare(`select state from integrated_submissions where process_id = 'process_held' and message_id = 'held-7'`).get() as { state: string }).state, 'uncertain');
  assert.equal(database.connection.prepare(`select 1 from integrated_held_prompts where message_id = 'held-7'`).get(), undefined);
  gate = null;
  open();
  await settle();
  assert.equal(sent.at(-1), 'In flight');

  // A prompt sent while a busy one is being held still reaches the agent
  // after it.
  busyOnce = true;
  await Promise.all([
    restarted.prompt('process_held', { text: 'First', messageId: 'held-8' }),
    restarted.prompt('process_held', { text: 'Second', messageId: 'held-9' })
  ]);
  await settle();
  assert.deepEqual(sent.slice(-2), ['First', 'Second']);

  // A prompt arriving while held prompts are being sent is stored and
  // acknowledged at once, not kept in memory until their calls settle.
  busy = true;
  await restarted.prompt('process_held', { text: 'Slow send', messageId: 'held-11' });
  busy = false;
  let release = () => {};
  gate = new Promise((resolve) => { release = resolve; });
  void restarted.updateQueued('process_held', 'held-11', 'steer');
  await settle();
  let timeout: NodeJS.Timeout | undefined;
  const meanwhile = await Promise.race([
    restarted.prompt('process_held', { text: 'Meanwhile', messageId: 'held-12' }),
    new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('the prompt waited for the held send')), 1_000); })
  ]) as { delivery: string };
  clearTimeout(timeout);
  assert.equal(meanwhile.delivery, 'queued');
  assert.ok(database.connection.prepare(`select 1 from integrated_held_prompts where message_id = 'held-12'`).get(), 'the later prompt is stored durably');
  gate = null;
  release();
  await settle();
  assert.deepEqual(sent.slice(-2), ['Slow send', 'Meanwhile']);
  restarted.dispose();

  // Arrival order is kept even when an earlier prompt's references take
  // longer to resolve than a later prompt's text.
  const ordered = new IntegratedAgentService(database, { codex: provider }, undefined, {
    resolve: async (_processId, request) => {
      if (request.text === 'With reference') await new Promise((resolve) => setTimeout(resolve, 20));
      return { ...request, references: [], attachments: [] };
    },
    search: async () => []
  });
  await Promise.all([
    ordered.prompt('process_held', { text: 'With reference', messageId: 'held-13' }),
    ordered.prompt('process_held', { text: 'Plain text', messageId: 'held-14' })
  ]);
  assert.deepEqual(sent.slice(-2), ['With reference', 'Plain text']);

  // A held send that may have reached the agent stays visible as unconfirmed.
  // It is never sent again, and the transcript or a dismissal settles it.
  const unconfirmedQueue = async () => ((await ordered.conversation('process_held')) as { queue?: Array<{ id: string; delivery: string; error?: string }> }).queue ?? [];
  for (const id of ['held-15', 'held-16']) {
    busy = true;
    await ordered.prompt('process_held', { text: `Lost reply ${id}`, messageId: id });
    busy = false;
    failWith = new UncertainDeliveryError('reply lost');
    await ordered.updateQueued('process_held', id, 'steer');
    await settle();
  }
  failWith = null;
  assert.deepEqual((await unconfirmedQueue()).map((item) => [item.id, item.delivery, item.error]),
    [['held-15', 'unconfirmed', 'reply lost'], ['held-16', 'unconfirmed', 'reply lost']]);
  attempts = 0;
  database.connection.prepare(`update processes set activity = 'working' where id = 'process_held'`).run();
  snapshot = 'idle';
  await ordered.conversation('process_held');
  await settle();
  assert.equal(attempts, 0, 'an unconfirmed message is never sent again');
  assert.equal((await ordered.prompt('process_held', { text: 'Lost reply held-15', messageId: 'held-15' }) as { delivery: string }).delivery, 'uncertain');
  await assert.rejects(ordered.updateQueued('process_held', 'held-15', 'steer'), /may already have reached/);
  assert.equal((await ordered.prompt('process_held', { text: 'Not blocked', messageId: 'held-17' }) as { delivery?: string }).delivery, undefined, 'unconfirmed messages do not hold later ones');
  messages = [{ id: 'item_15', role: 'user', kind: 'text', text: 'Lost reply held-15', clientMessageId: 'held-15' }];
  assert.deepEqual((await unconfirmedQueue()).map((item) => item.id), ['held-16'], 'the transcript confirms an unconfirmed message');
  assert.equal((database.connection.prepare(`select state from integrated_submissions where process_id = 'process_held' and message_id = 'held-15'`).get() as { state: string }).state, 'accepted');
  await ordered.updateQueued('process_held', 'held-16', 'cancel');
  assert.deepEqual(await unconfirmedQueue(), [], 'dismissing removes it');
  messages = [];

  // Two more unconfirmed sends, for the resumed conversation below.
  for (const id of ['held-18', 'held-19']) {
    busy = true;
    await ordered.prompt('process_held', { text: `Resumed ${id}`, messageId: id });
    busy = false;
    failWith = new UncertainDeliveryError('reply lost');
    await ordered.updateQueued('process_held', id, 'steer');
    await settle();
  }
  failWith = null;

  // A resumed conversation takes over prompts held for its earlier process.
  database.connection.prepare(`update sessions set resume_id = 'thread_held', exited_at = ? where id = 'session_held'`).run(now);
  database.connection.prepare(`update processes set status = 'exited' where id = 'process_held'`).run();
  database.connection.prepare(`insert into integrated_held_prompts (process_id, message_id, payload, payload_hash, turn_kind, created_at) values ('process_held', 'held-10', ?, null, 'compact', ?)`)
    .run(JSON.stringify({ text: 'Left behind', references: [], attachments: [] }), now);
  database.connection.prepare(`insert into processes (id,project_id,kind,name,status,activity,created_at,updated_at) values ('process_resumed','project_test','agent','Held','running','idle',?,?)`).run(now, now);
  database.connection.prepare(`insert into sessions (id,project_id,process_id,harness,interface_mode,started_at,session_role,resume_status,created_by_actor,resume_id) values ('session_resumed','project_test','process_resumed','codex','integrated',?,'sub-agent','found','user','thread_held')`).run(now);
  const resumed = new IntegratedAgentService(database, { codex: provider });
  snapshot = 'idle';
  resumed.observe('process_resumed');
  await settle();
  assert.equal(sent.at(-1), 'Left behind');
  // Unconfirmed messages keep their reservation after the move, so neither
  // confirming nor dismissing one lets a retry send it again.
  messages = [{ id: 'item_18', role: 'user', kind: 'text', text: 'Resumed held-18', clientMessageId: 'held-18' }];
  await resumed.conversation('process_resumed');
  await resumed.updateQueued('process_resumed', 'held-19', 'cancel');
  messages = [];
  attempts = 0;
  await resumed.prompt('process_resumed', { text: 'Resumed held-18', messageId: 'held-18' });
  assert.equal((await resumed.prompt('process_resumed', { text: 'Resumed held-19', messageId: 'held-19' }) as { delivery: string }).delivery, 'uncertain');
  assert.equal(attempts, 0, 'a resumed conversation never resends an unconfirmed message');
  resumed.dispose();
}

void main().then(() => console.log('integrated agent smoke ok'));
