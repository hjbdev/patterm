import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../app/Services/DatabaseService';
import { IDLE_COMPACTION_AFTER_MS, IdleCompactionService, thirtyMinuteCacheModel, type IdleCompactionSource } from '../app/Services/IdleCompactionService';
import type { IntegratedConversationEvent } from '../app/Services/IntegratedConversation';
import { IntegratedAgentService, type CompactionSignal, type IntegratedActivityChange, type IntegratedProviderService } from '../app/Services/IntegratedAgentService';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const AFTER = 40;
const SETTLE = AFTER * 3;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-idle-compaction-test-'));
  const database = new DatabaseService(directory);
  database.initialize();
  const db = database.connection;
  IDLE_COMPACTION_AFTER_MS.claude = AFTER;
  IDLE_COMPACTION_AFTER_MS.codex = AFTER;
  IDLE_COMPACTION_AFTER_MS.opencode = AFTER;

  // Fake integrated source. compact() mirrors IntegratedAgentService: it
  // signals before admission and signals a rejection.
  let activityListener: ((change: IntegratedActivityChange) => void) | undefined;
  let signalListener: ((processId: string, signal: CompactionSignal) => void) | undefined;
  let eventListener: ((processId: string, event: IntegratedConversationEvent) => void) | undefined;
  const compacted: string[] = [];
  let fail = false;
  let uncertain = false;
  const models: Record<string, string | null> = { codex: 'gpt-6-astra', old: 'gpt-5.5', openai: 'openai/gpt-5.6', go: 'opencode-go/deepseek-v4.1-flash' };
  let modelGate: Promise<void> | null = null;
  const source: IdleCompactionSource = {
    onActivityChange(listener) { activityListener = listener; return () => { activityListener = undefined; }; },
    onCompactionSignal(listener) { signalListener = listener; return () => { signalListener = undefined; }; },
    onConversationEvent(listener) { eventListener = listener; return () => { eventListener = undefined; }; },
    async compact(processId) {
      signalListener?.(processId, 'compact');
      compacted.push(processId);
      if (fail) {
        signalListener?.(processId, 'compact_rejected');
        throw new Error('host unavailable');
      }
      if (uncertain) {
        signalListener?.(processId, 'compact_rejected');
        throw Object.assign(new Error('timed out'), { definitive: false });
      }
    },
    async model(processId) {
      await modelGate;
      return models[processId] ?? null;
    }
  };
  const add = (id: string, harness: string) => {
    db.prepare(`insert into processes (id,project_id,kind,name,status,activity,created_at,updated_at)
      values (?, 'project', 'agent', ?, 'running', 'idle', 'now', 'now')`).run(id, id);
    db.prepare(`insert into sessions (id,project_id,process_id,harness,interface_mode,session_role,started_at)
      values (?, 'project', ?, ?, 'integrated', 'orchestrator', 'now')`).run(`session_${id}`, id, harness);
  };
  // Mirrors IntegratedAgentService: the activity column changes, then listeners run.
  const activity = (processId: string, value: string, snapshot = false) => {
    db.prepare('update processes set activity = ? where id = ?').run(value, processId);
    activityListener?.({ processId, previous: '', activity: value, snapshot });
  };
  // A user turn: an admitted prompt, then the native turn. `native` is a turn
  // without a prompt, such as a compaction or a turn Codex aborted.
  const native = (processId: string) => { activity(processId, 'working'); activity(processId, 'idle'); };
  const turn = (processId: string) => { signalListener?.(processId, 'turn'); native(processId); };
  const state = (id: string) => db.prepare('select cache_compaction as state, cache_idle_since as since from processes where id = ?').get(id) as { state: string | null; since: string | null };
  const cleared = { state: null, since: null };
  const enabled: Record<string, boolean> = { claude: true, codex: true, opencode: true };
  const service = new IdleCompactionService(database, source, (harness) => enabled[harness] === true);
  const count = (id: string) => compacted.filter((item) => item === id).length;
  try {
    db.exec("insert into projects(id,name,path,created_at,updated_at) values('project','Test','/tmp','now','now')");
    for (const [id, harness] of [['claude', 'claude'], ['codex', 'codex'], ['old', 'codex'], ['openai', 'opencode'], ['go', 'opencode'], ['assistant', 'codex'], ['second', 'claude']]) add(id!, harness!);
    db.prepare("update sessions set session_role = 'assistant' where process_id = 'assistant'").run();
    service.start();

    // Only GPT-5.6 and later have OpenAI's documented 30-minute cache.
    for (const model of ['gpt-5.6', 'gpt-5.6-luna', 'gpt-6-astra', 'gpt-7']) assert.equal(thirtyMinuteCacheModel(model), true, model);
    for (const model of ['gpt-5.5', 'gpt-5', 'o3', 'gpt-4.1', 'deepseek']) assert.equal(thirtyMinuteCacheModel(model), false, model);

    // An admitted prompt arms compaction; idling past the deadline compacts once.
    signalListener?.('claude', 'turn');
    activity('claude', 'working');
    assert.deepEqual(state('claude'), { state: 'armed', since: null });
    activity('claude', 'idle');
    assert.ok(state('claude').since);
    await wait(SETTLE);
    assert.equal(count('claude'), 1);
    assert.equal(service.compacting('claude'), true);

    // The compaction's own turn does not re-arm it, and activity alone never arms.
    native('claude');
    assert.deepEqual(state('claude'), cleared);
    native('claude');
    await wait(SETTLE);
    assert.equal(count('claude'), 1);
    assert.deepEqual(state('claude'), cleared);

    // A turn that ends before the deadline cancels the pending compaction.
    turn('claude');
    signalListener?.('claude', 'turn');
    activity('claude', 'working');
    await wait(SETTLE);
    assert.equal(count('claude'), 1);
    activity('claude', 'idle');
    await wait(SETTLE);
    assert.equal(count('claude'), 2);
    native('claude');

    // A background permission prompt between turns does not re-arm a
    // compacted agent, and only holds a pending deadline.
    activity('claude', 'permission');
    activity('claude', 'idle');
    await wait(SETTLE);
    assert.equal(count('claude'), 2);
    turn('claude');
    const since = state('claude').since;
    activity('claude', 'permission');
    assert.equal(state('claude').since, since);
    activity('claude', 'idle');
    await wait(SETTLE);
    assert.equal(count('claude'), 3);
    native('claude');

    // A prompt admitted while a compaction runs arms the agent again. The
    // compaction's end stays quiet; the prompt's turn after it is announced.
    turn('claude');
    await wait(SETTLE);
    assert.equal(count('claude'), 4);
    signalListener?.('claude', 'turn');
    assert.equal(service.compacting('claude'), true, 'arming does not hide the running compaction');
    activity('claude', 'working');
    activity('claude', 'idle');
    assert.equal(service.compacting('claude'), false);
    activity('claude', 'working');
    activity('claude', 'idle');
    await wait(SETTLE);
    assert.equal(count('claude'), 5);
    native('claude');

    // A model change or /rename during an automatic compaction changes arming
    // only; the compaction's end is still not announced.
    turn('second');
    await wait(SETTLE);
    assert.equal(count('second'), 1);
    activity('second', 'working');
    signalListener?.('second', 'model');
    assert.equal(service.compacting('second'), true, 'a model change does not hide the running compaction');
    signalListener?.('second', 'turn');
    assert.equal(service.compacting('second'), true, 'a command does not hide the running compaction');
    activity('second', 'idle', true);
    assert.equal(service.compacting('second'), false, 'a reconnect snapshot ends it too');

    // A typed /compact counts as the idle period's compaction, and is
    // announced as before.
    turn('claude');
    signalListener?.('claude', 'compact');
    assert.equal(service.compacting('claude'), false);
    native('claude');
    await wait(SETTLE);
    assert.equal(count('claude'), 5);

    // A typed /compact during a turn: Codex aborts the turn, whose end comes
    // first, then compacts. Neither turn re-arms the agent.
    turn('claude');
    activity('claude', 'working');
    signalListener?.('claude', 'compact');
    activity('claude', 'idle');
    native('claude');
    assert.deepEqual(state('claude'), cleared);
    await wait(SETTLE);
    assert.equal(count('claude'), 5, 'a typed /compact mid-turn is not followed by another compaction');

    // A rejected compaction does not block the next turn.
    signalListener?.('claude', 'compact');
    signalListener?.('claude', 'compact_rejected');
    assert.deepEqual(state('claude'), cleared);
    turn('claude');
    await wait(SETTLE);
    assert.equal(count('claude'), 6);
    native('claude');

    // A failed compaction is not retried until the next turn.
    fail = true;
    turn('claude');
    await wait(SETTLE);
    assert.equal(count('claude'), 7);
    assert.deepEqual(state('claude'), cleared);
    assert.equal(service.compacting('claude'), false, 'a rejected attempt clears its own notice');
    await wait(SETTLE);
    assert.equal(count('claude'), 7);
    fail = false;

    // An uncertain failure may have started the compaction, so its notice
    // stays until the turn ends.
    uncertain = true;
    turn('claude');
    await wait(SETTLE);
    uncertain = false;
    assert.equal(count('claude'), 8);
    assert.equal(service.compacting('claude'), true, 'an uncertain failure keeps the notice');
    native('claude');
    assert.equal(service.compacting('claude'), false);

    // A lost native connection disarms the agent: work can start unseen while
    // activity stays idle. The next prompt arms it again.
    turn('claude');
    eventListener?.('claude', { kind: 'reconnecting' } as IntegratedConversationEvent);
    assert.deepEqual(state('claude'), cleared);
    await wait(SETTLE);
    assert.equal(count('claude'), 8, 'no compaction after the connection was lost');
    turn('claude');
    eventListener?.('claude', { kind: 'error', id: 'connection_error' } as IntegratedConversationEvent);
    await wait(SETTLE);
    assert.equal(count('claude'), 8);

    // A harness turned off in settings is skipped when its deadline arrives.
    enabled.claude = false;
    turn('claude');
    await wait(SETTLE);
    assert.equal(count('claude'), 8);
    assert.deepEqual(state('claude'), cleared);
    enabled.claude = true;

    // A model change disarms the agent: its cache belongs to the old model.
    turn('claude');
    signalListener?.('claude', 'model');
    await wait(SETTLE);
    assert.equal(count('claude'), 8);
    assert.deepEqual(state('claude'), cleared);

    // Harnesses without a known cache lifetime are left alone.


    // Codex and OpenCode compact only on models with a 30-minute cache.
    for (const id of ['codex', 'old', 'openai', 'go']) turn(id);
    await wait(SETTLE);
    assert.deepEqual(['codex', 'old', 'openai', 'go'].map(count), [1, 0, 1, 0]);
    assert.deepEqual(state('old'), cleared);
    assert.deepEqual(state('go'), cleared);
    native('codex');
    native('openai');

    // The assistant is never compacted: Codex drops voice input steered into
    // a compaction.
    turn('assistant');
    await wait(SETTLE);
    assert.equal(count('assistant'), 0);
    assert.deepEqual(state('assistant'), cleared);

    // A model lookup that resolves after a newer turn leaves that turn's state.
    const gate = deferred<void>();
    modelGate = gate.promise;
    turn('go');
    await wait(SETTLE);
    signalListener?.('go', 'turn');
    activity('go', 'working');
    gate.resolve();
    await wait(1);
    modelGate = null;
    assert.deepEqual(state('go'), { state: 'armed', since: null });
    models.go = 'openai/gpt-6-astra';
    activity('go', 'idle');
    await wait(SETTLE);
    assert.equal(count('go'), 1);
    native('go');

    // A turn that ended while Patterm was not watching has no known idle time.
    signalListener?.('claude', 'turn');
    activity('claude', 'working');
    activity('claude', 'idle', true);
    assert.deepEqual(state('claude'), cleared);
    await wait(SETTLE);
    assert.equal(count('claude'), 8);

    // Nothing carries over a restart: native agents run on while Patterm is
    // down, so saved deadlines and notices are cleared before any event.
    service.dispose();
    db.prepare("update processes set activity = 'idle', cache_compaction = 'armed', cache_idle_since = ?, cache_compaction_notice = 'old-attempt' where id = 'claude'").run(new Date(Date.now() - AFTER).toISOString());
    const restarted = new IdleCompactionService(database, source, () => true);
    restarted.start();
    assert.deepEqual(state('claude'), cleared);
    assert.equal(restarted.compacting('claude'), false, 'a stale notice cannot quiet the next turn');
    activity('claude', 'idle', true);
    await wait(SETTLE);
    assert.equal(count('claude'), 8, 'a saved deadline does not fire after a restart');
    turn('claude');
    await wait(SETTLE);
    assert.equal(count('claude'), 9, 'the next prompt arms the agent again');
    restarted.dispose();

    await integratedSignals(database);
  } finally {
    service.dispose();
    database.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log('idle compaction smoke passed');
}

// IntegratedAgentService's side: native compaction, admission, and signals.
async function integratedSignals(database: DatabaseService): Promise<void> {
  const db = database.connection;
  db.prepare(`insert into processes (id,project_id,kind,name,status,activity,created_at,updated_at)
    values ('oc', 'project', 'agent', 'oc', 'running', 'idle', 'now', 'now')`).run();
  db.prepare(`insert into sessions (id,project_id,process_id,harness,interface_mode,session_role,started_at)
    values ('session_oc', 'project', 'oc', 'opencode', 'integrated', 'orchestrator', 'now')`).run();
  const calls: string[] = [];
  let reject = false;
  let prompt = deferred<void>();
  const provider: IntegratedProviderService = {
    prepare: async () => ({ resumeId: 'session', argv: [] }),
    conversation: async () => ({ status: 'idle' }),
    prompt: async () => { await prompt.promise; calls.push('prompt'); return {}; },
    interrupt: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    configure: async () => { calls.push('configure'); },
    controls: async () => ({ selectors: [{ id: 'model', label: 'Model', value: 'openai/gpt-5.6', options: [] }], commands: [] }),
    // A custom command named compact must never run for idle compaction.
    command: async (_processId, name) => {
      calls.push(`command:${name}`);
      if (reject) throw new Error('host unavailable');
      return {};
    },
    compact: async () => { calls.push('compact'); return {}; },
    currentModel: async () => 'opencode-go/deepseek-v4.1-flash'
  };
  const integrated = new IntegratedAgentService(database, { opencode: provider });
  const signals: string[] = [];
  integrated.onCompactionSignal((processId, signal) => signals.push(`${processId}:${signal}`));
  const activity = (value: string) => db.prepare("update processes set activity = ? where id = 'oc'").run(value);

  await integrated.compact('oc');
  assert.deepEqual(calls, ['compact']);
  assert.deepEqual(signals, ['oc:compact']);

  // Never admitted while a turn runs or a prompt is on its way, with or
  // without a message ID (forwarded notifications and MCP messages have none).
  activity('working');
  await assert.rejects(integrated.compact('oc'), /busy/);
  activity('idle');
  const forwarded = integrated.prompt('oc', '[Patterm notifications] child reported');
  await assert.rejects(integrated.compact('oc'), /busy/);
  prompt.resolve();
  await forwarded;
  prompt = deferred<void>();
  const sending = integrated.prompt('oc', { text: 'Hello', messageId: 'message_1' });
  await assert.rejects(integrated.compact('oc'), /busy/);
  prompt.resolve();
  await sending;
  assert.deepEqual(signals, ['oc:compact', 'oc:turn', 'oc:turn']);
  activity('idle');
  await integrated.compact('oc');
  assert.equal(calls.filter((call) => call === 'compact').length, 2);
  signals.splice(1, 2);

  // A rejected typed /compact signals the rejection; other commands are turns.
  activity('idle');
  reject = true;
  await assert.rejects(integrated.command('oc', 'compact', ''), /host unavailable/);
  reject = false;
  await integrated.command('oc', 'review', '');
  assert.deepEqual(signals.slice(2), ['oc:compact', 'oc:compact_rejected', 'oc:turn']);

  // A model change signals, and the native model wins over a stale selector.
  await integrated.configure('oc', 'model', 'openai/gpt-5.6');
  assert.equal(signals.at(-1), 'oc:model');
  assert.equal(await integrated.model('oc'), 'opencode-go/deepseek-v4.1-flash');
  // A restart keeps the live settings and leaves those the agent does not report.
  assert.deepEqual(await integrated.liveSettings('oc'), { model: 'openai/gpt-5.6' });
  // A default model or effort is the harness default; a default speed is an
  // explicit Standard tier.
  provider.controls = async () => ({ selectors: [
    { id: 'model', label: 'Model', value: 'default', options: [] },
    { id: 'effort', label: 'Effort', value: 'high', options: [] },
    { id: 'speed', label: 'Speed', value: 'default', options: [] }
  ], commands: [] });
  assert.deepEqual(await integrated.liveSettings('oc'), { model: null, reasoning: 'high', service_tier: 'default' });
  // Native settings win over selectors that can be stale after a Patterm restart.
  provider.nativeSettings = async () => ({ model: 'opencode-go/deepseek-v4.1-flash', reasoning: 'low' });
  assert.deepEqual(await integrated.liveSettings('oc'), { model: 'opencode-go/deepseek-v4.1-flash', reasoning: 'low' });

  await lateRejection(database);
  await reconnectDisarms(database);
}

// A reconnect reported through IntegratedAgentService's own observation of a
// live agent disarms it before its channel is reseeded.
async function reconnectDisarms(database: DatabaseService): Promise<void> {
  const db = database.connection;
  db.prepare(`insert into processes (id,project_id,kind,name,status,activity,created_at,updated_at)
    values ('rc', 'project', 'agent', 'rc', 'running', 'idle', 'now', 'now')`).run();
  db.prepare(`insert into sessions (id,project_id,process_id,harness,interface_mode,session_role,started_at)
    values ('session_rc', 'project', 'rc', 'claude', 'integrated', 'orchestrator', 'now')`).run();
  let stream: ((event: IntegratedConversationEvent) => void) | undefined;
  const compacts: string[] = [];
  const provider: IntegratedProviderService = {
    prepare: async () => ({ resumeId: 'session', argv: [] }),
    conversation: async () => ({ status: 'idle' }),
    prompt: async () => ({}),
    interrupt: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    subscribe: async (_processId, listener) => { stream = listener; return () => { stream = undefined; }; },
    compact: async () => { compacts.push('rc'); return {}; }
  };
  const integrated = new IntegratedAgentService(database, { claude: provider });
  const service = new IdleCompactionService(database, integrated, () => true);
  try {
    service.start();
    integrated.observe('rc');
    await wait(5);
    await integrated.prompt('rc', 'Work');
    stream?.({ kind: 'status', status: 'working' } as IntegratedConversationEvent);
    stream?.({ kind: 'status', status: 'idle' } as IntegratedConversationEvent);
    const armed = db.prepare("select cache_compaction as state from processes where id = 'rc'").get() as { state: string | null };
    assert.equal(armed.state, 'armed');
    stream?.({ kind: 'reconnecting' } as IntegratedConversationEvent);
    const after = db.prepare("select cache_compaction as state from processes where id = 'rc'").get() as { state: string | null };
    assert.equal(after.state, null, 'a reconnect disarms the agent');
    await wait(SETTLE);
    assert.deepEqual(compacts, [], 'no compaction while the channel is reseeded');
  } finally {
    service.dispose();
    integrated.dispose();
  }
}

// A compaction rejected after a newer turn has idled keeps that turn's deadline.
async function lateRejection(database: DatabaseService): Promise<void> {
  const db = database.connection;
  db.prepare(`insert into processes (id,project_id,kind,name,status,activity,created_at,updated_at)
    values ('cl', 'project', 'agent', 'cl', 'running', 'idle', 'now', 'now')`).run();
  db.prepare(`insert into sessions (id,project_id,process_id,harness,interface_mode,session_role,started_at)
    values ('session_cl', 'project', 'cl', 'claude', 'integrated', 'orchestrator', 'now')`).run();
  const pending: Array<ReturnType<typeof deferred<void>>> = [];
  const provider: IntegratedProviderService = {
    prepare: async () => ({ resumeId: 'session', argv: [] }),
    conversation: async () => ({ status: 'idle' }),
    prompt: async () => ({}),
    interrupt: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    compact: async () => {
      const call = deferred<void>();
      pending.push(call);
      await call.promise;
      throw new Error('compaction rejected');
    }
  };
  const integrated = new IntegratedAgentService(database, { claude: provider });
  let activityListener: ((change: IntegratedActivityChange) => void) | undefined;
  const service = new IdleCompactionService(database, {
    onActivityChange(listener) { activityListener = listener; return () => { activityListener = undefined; }; },
    onCompactionSignal: (listener) => integrated.onCompactionSignal(listener),
    onConversationEvent: (listener) => integrated.onConversationEvent(listener),
    compact: (processId) => integrated.compact(processId),
    model: (processId) => integrated.model(processId)
  }, () => true);
  const activity = (value: string) => {
    db.prepare("update processes set activity = ? where id = 'cl'").run(value);
    activityListener?.({ processId: 'cl', previous: '', activity: value, snapshot: false });
  };
  try {
    service.start();
    await integrated.prompt('cl', 'First step');
    activity('working');
    activity('idle');
    await wait(SETTLE);
    assert.equal(pending.length, 1);
    assert.equal(service.compacting('cl'), true);
    await integrated.prompt('cl', 'Next step');
    activity('working');
    activity('idle');
    pending[0]!.resolve();
    await wait(SETTLE);
    assert.equal(pending.length, 2, 'the newer turn still compacts');
    pending[1]!.resolve();
    await wait(1);
  } finally {
    service.dispose();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
