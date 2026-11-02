import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ASSISTANT_BOT_ID, type Bot } from '../app/Bots/BotSettings';
import { AgentContextService } from '../app/Services/AgentContextService';
import { AssistantMemoryService } from '../app/Services/AssistantMemoryService';
import { memoryHookSettings } from '../app/Services/ClaudeStreamService';
import { DatabaseService } from '../app/Services/DatabaseService';
import { MemoryPushService, memoryPushSupported, type MemoryUpdate } from '../app/Services/MemoryPushService';
import { SettingsService } from '../app/Services/SettingsService';
import { groupTranscriptMessages, isQuietMemoryRead, type TranscriptMessage } from '../app/Services/TranscriptProjection';
import { randomLook } from '../resources/js/lib/faces';
import { removeTree } from './fixtures/TempTree';

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-memory-push-'));
  const database = new DatabaseService(dir);
  try {
    database.initialize();
    const db = database.connection;
    const now = new Date().toISOString();
    db.prepare('insert into projects(id,name,path,created_at,updated_at) values(?,?,?,?,?)').run('p', 'Project', dir, now, now);
    const settings = new SettingsService(database);
    const bot = (id: string, memoryOn: boolean) => ({ id, name: id, harness: 'codex', avatar: { kind: 'face', look: randomLook(1), emoji: null, picture: null }, purview: { kind: 'none' }, instructions: '', memory: memoryOn });
    settings.updateBots({ bots: [bot('fable', true)] });
    const setBot = (id: string, change: Partial<Bot>) => settings.updateBots({ ...settings.bots(), bots: settings.bots().bots.map((item) => item.id === id ? { ...item, ...change } : item) });
    const memory = new AssistantMemoryService(database, settings);
    const sessions: Array<[string, string, string | null]> = [['fable', 'bot', 'fable'], ['assistant', 'assistant', null], ['worker', 'orchestrator', null]];
    for (const [id, role, botId] of sessions) {
      db.prepare("insert into processes(id,project_id,kind,name,status,created_at,updated_at) values(?,?,'agent',?,'running',?,?)").run(`proc-${id}`, 'p', id, now, now);
      db.prepare('insert into sessions(id,project_id,process_id,harness,session_role,bot_id,started_at,cwd,mcp_identity) values(?,?,?,?,?,?,?,?,?)').run(id, 'p', `proc-${id}`, 'codex', role, botId, now, dir, `mcp-${id}`);
    }
    const write = (text: string) => memory.write({ lines: [{ text, importance: 'high' }] }, 'fable');
    write('Prefers metric units.');

    // The service renders what a pushed conversation needs: the whole memory,
    // then only changes, and nothing while nothing changed.
    const fableCaller = { role: 'bot' as const, bot: 'fable' };
    const first = memory.pushed(fableCaller, null);
    assert.equal(first.full, true);
    assert.match(first.text, /Prefers metric units/);
    assert.match(first.text, /do not need to call assistant_memory_read/, 'a pushed snapshot asks for no reads');
    assert.doesNotMatch(first.text, /since_revision=/);
    assert.equal(memory.pushed(fableCaller, first.revision).text, '', 'an unchanged memory pushes nothing');
    write('Lives in Leeds.');
    const delta = memory.pushed(fableCaller, first.revision);
    assert.equal(delta.full, false);
    assert.match(delta.text, /Memory changes .*Lives in Leeds/s);
    assert.doesNotMatch(delta.text, /Prefers metric units/, 'a change sends only the change');
    assert.equal(memory.pushed(fableCaller, delta.revision + 5).full, true, 'a revision from the future gets the whole memory');

    // Per process: the first prompt gets everything, an unchanged one nothing,
    // a switch change the new state. Task agents get no pushes.
    const log: Array<{ event: string }> = [];
    const push = new MemoryPushService(database, memory, (event) => log.push({ event }));
    const sent: Array<{ process: string; update: MemoryUpdate }> = [];
    const deliver = (process: string, fail = false) => push.deliver(process, async (update) => {
      if (fail) throw new Error('native refused');
      sent.push({ process, update });
    });
    await deliver('proc-fable');
    assert.equal(sent.at(-1)!.update.full, true);
    assert.match(sent.at(-1)!.update.changes!, /Lives in Leeds/);
    await deliver('proc-fable');
    assert.equal(sent.at(-1)!.update.changes, null, 'an unchanged memory sends no changes');
    assert.match(sent.at(-1)!.update.snapshot(), /Prefers metric units/, 'the whole memory stays available after compaction');
    write('Drinks tea.');
    await deliver('proc-fable', true);
    assert.equal(log.at(-1)?.event, 'memory.push_failed', 'a refused update is logged, not thrown');
    await deliver('proc-fable');
    assert.match(sent.at(-1)!.update.changes!, /Drinks tea/, 'a refused update is sent again with the next prompt');
    assert.equal(sent.at(-1)!.update.full, false);
    setBot('fable', { memory: false });
    await deliver('proc-fable');
    assert.match(sent.at(-1)!.update.changes!, /Saved memory is off/, 'turning memory off is pushed once');
    assert.doesNotMatch(sent.at(-1)!.update.changes!, /Drinks tea/);
    await deliver('proc-fable');
    assert.equal(sent.at(-1)!.update.changes, null, 'memory that stays off is not repeated');
    setBot('fable', { memory: true });
    await deliver('proc-fable');
    assert.equal(sent.at(-1)!.update.full, true, 'turning memory on pushes the whole memory');
    assert.match(sent.at(-1)!.update.changes!, /Drinks tea/);
    const before = sent.length;
    await deliver('proc-worker');
    assert.equal(sent.length, before, 'task agents read memory themselves');
    await deliver('proc-assistant');
    assert.equal(sent.at(-1)!.process, 'proc-assistant');
    assert.match(sent.at(-1)!.update.changes!, /Drinks tea/, 'the assistant follows the shared switch');
    setBot(ASSISTANT_BOT_ID, { memory: false });
    await deliver('proc-assistant');
    assert.match(sent.at(-1)!.update.changes!, /Saved memory is off/);

    // Instructions follow the push: bots and the assistant stop reading memory
    // before every message where Patterm keeps it current.
    const context = new AgentContextService();
    assert.match(context.buildBot({ name: 'Fable', instructions: '' }, 'none'), /Before handling each new message from the user, call assistant_memory_read/);
    const pushedBot = context.buildBot({ name: 'Fable', instructions: '' }, 'none', { memoryPush: true });
    assert.match(pushedBot, /Patterm keeps your saved memory current/);
    assert.doesNotMatch(pushedBot, /Before handling each new message from the user, call assistant_memory_read/);
    assert.ok(Buffer.byteLength(JSON.stringify(pushedBot)) <= 7900);
    assert.match(context.buildAssistant('', undefined, { memoryPush: true }), /Patterm keeps your saved memory current/);
    assert.doesNotMatch(context.buildAssistant('', undefined, { memoryPush: true }), /Before handling each new user request/);
    assert.equal(memoryPushSupported('opencode'), true);
    assert.equal(memoryPushSupported('codex'), true);
    assert.equal(memoryPushSupported('claude', 'linux'), true);
    assert.equal(memoryPushSupported('claude', 'win32'), false, 'Claude\'s hook needs a POSIX shell');
    assert.equal(memoryPushSupported('rawpty'), false);

    // Claude's hook prints what the host left exactly once, from a path with
    // spaces and quotes.
    const hookDir = path.join(dir, "it's a dir");
    fs.mkdirSync(hookDir);
    const hookPath = path.join(hookDir, 'memory.json');
    const command = ((memoryHookSettings(hookPath).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>).UserPromptSubmit![0]!.hooks[0]!.command);
    const runHook = () => execFileSync('sh', ['-c', command], { input: '{"prompt":"hi"}', encoding: 'utf8' });
    assert.equal(runHook(), '', 'nothing waiting prints nothing');
    fs.writeFileSync(hookPath, '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"notes"}}');
    assert.match(runHook(), /"additionalContext":"notes"/);
    assert.equal(runHook(), '', 'a taken update is not repeated');
    assert.equal(fs.readdirSync(hookDir).length, 0, 'the hook leaves no files behind');

    // A memory check that found nothing new is not shown; one that found
    // changes, failed, or loaded the memory still is.
    const read = (id: string, output: string, status: 'completed' | 'failed' = 'completed'): TranscriptMessage => ({
      id, role: 'assistant', kind: 'tool', text: '',
      tool: { name: 'mcp__patterm__assistant_memory_read', family: 'mcp', status, title: 'assistant_memory_read', target: 'patterm: assistant_memory_read', output }
    });
    const quiet = read('quiet', '{\n  "enabled": true,\n  "revision": 7,\n  "text": "[Memory changes 7 → 7. Retire every replaced/forgotten ID below.]\\n"\n}');
    const off = read('off', '{"enabled": false, "revision": 0, "text": "Saved bot memory is disabled."}');
    const changed = read('changed', '{"enabled": true, "text": "[Memory changes 6 → 7. Retire every replaced/forgotten ID below.]\\n- memory_1 ..."}');
    assert.equal(isQuietMemoryRead(quiet.tool), true);
    assert.equal(isQuietMemoryRead(off.tool), true);
    assert.equal(isQuietMemoryRead(changed.tool), false);
    assert.equal(isQuietMemoryRead(read('failed', '{"enabled": false}', 'failed').tool), false);
    const reply: TranscriptMessage = { id: 'reply', role: 'assistant', kind: 'text', text: 'Hello' };
    assert.deepEqual(groupTranscriptMessages([quiet, off, reply]).map((row) => row.id), ['reply'], 'quiet memory checks leave no tool row');
    assert.deepEqual(groupTranscriptMessages([quiet, changed, reply]).map((row) => row.id), ['tools:changed', 'reply']);
  } finally {
    database.dispose();
    removeTree(dir);
  }
}

void main().then(() => console.log('memory push smoke passed'));
