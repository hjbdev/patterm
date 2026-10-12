import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../app/Services/DatabaseService';
import { SettingsService } from '../app/Services/SettingsService';
import { AssistantMemoryService } from '../app/Services/AssistantMemoryService';
import { AgentContextService } from '../app/Services/AgentContextService';
import { voiceBrief } from '../app/Services/AssistantVoiceBrief';
import { WorkbenchRepository } from '../app/Repositories/WorkbenchRepository';
import { TimelineService } from '../app/Services/TimelineService';
import type { TerminalService } from '../app/Services/TerminalService';
import { createTestMcpRegistry } from './fixtures/McpRegistryFixture';
import { LaunchingMcpIdentities } from '../app/MCP/McpHelperAccess';
import { removeTree } from './fixtures/TempTree';

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-memory-'));
  const database = new DatabaseService(dir);
  try {
    database.initialize();
    const db = database.connection;
    let time = new Date('2026-09-01T12:00:00Z');
    const now = time.toISOString();
    db.prepare('insert into projects(id,name,path,created_at,updated_at) values(?,?,?,?,?)').run('p', 'Project', dir, now, now);
    const settings = new SettingsService(database);
    const memory = new AssistantMemoryService(database, settings, () => time);
    assert.equal(memory.snapshot(), '');
    assert.throws(() => memory.write({ lines: [{ text: 'disabled', importance: 'high' }] }), /disabled/);
    settings.updateAssistantSettings({ ...settings.assistantSettings(), memoryEnabled: true, memoryBudgetTokens: 2000 });
    const write = (text: string, importance: 'low' | 'medium' | 'high' = 'high', project_id: string | null = null) => memory.write({ lines: [{ text, importance, project_id }] }).ids[0]!;
    const row = (id: string) => database.connection.prepare('select * from assistant_memory where id = ?').get(id) as { text: string; fact_at: string; importance: 'low' | 'medium' | 'high'; project_id: string | null; status: string; replaced_by: string | null };
    const a = write('Prefers short answers.');
    const b = write('Prefers direct answers.');
    time = new Date('2026-09-10T12:00:00Z');
    assert.equal(write('Prefers short answers.'), a);
    assert.equal(row(a).fact_at, now, 'restating does not rejuvenate');
    const revision = memory.read({}).revision;
    const merged = memory.write({ mode: 'compress', replaces: [a, b], lines: [{ text: 'Prefers short, direct answers.', importance: 'high' }] }).ids[0]!;
    assert.equal(row(merged).fact_at, now);
    assert.equal(row(a).replaced_by, merged);
    assert.equal(row(a).status, 'replaced');
    assert.equal(memory.search({ query: 'Prefers short answers.' }).text.includes(a), false);
    assert.match(memory.search({ query: 'Prefers short answers.', history: true }).text, /\[replaced\]/);
    const delta = memory.read({ since_revision: revision });
    assert.equal(delta.requiresRefresh, false);
    assert.ok(delta.text.includes(`${a}: replaced by ${merged}`));
    assert.ok(delta.text.includes(merged));
    assert.throws(() => memory.write({ mode: 'compress', replaces: [a, merged], lines: [] }), /stale/);
    assert.equal(row(merged).status, 'active', 'stale write is atomic');
    const c = write('Prefers plain language.');
    const again = memory.write({ mode: 'compress', replaces: [merged, c], lines: [{ text: 'Short, direct, plain replies.', importance: 'high' }] }).ids[0]!;
    assert.equal(row(again).fact_at, now, 'recompression inherits the oldest fact');
    assert.equal(row(merged).replaced_by, again);
    assert.throws(() => memory.write({ mode: 'compress', replaces: [again, write('low', 'low')], lines: [] }), /same scope and importance/);
    const projectNote = write('Project uses SQLite.', 'high', 'p');
    assert.throws(() => memory.write({ mode: 'compress', replaces: [again, projectNote], lines: [] }), /same scope/);
    assert.throws(() => memory.write({ lines: [{ text: 'not a project', importance: 'medium', project_id: 'missing' }] }), /workspace project/);
    assert.ok(memory.search({ query: 'SQLite', project_id: 'p' }).text.includes(projectNote));
    assert.ok(!memory.search({ query: 'SQLite', project_id: null }).text.includes(projectNote));
    const replacedRevision = memory.read({}).revision;
    const corrected = memory.write({ mode: 'supersede', replaces: [again], lines: [{ text: 'Detailed replies on request.', importance: 'high' }] }).ids[0]!;
    assert.equal(row(corrected).fact_at, now, 'corrections cannot refresh unchanged facts in a summary');
    const remove = memory.write({ mode: 'supersede', replaces: [corrected], lines: [] });
    assert.equal(row(corrected).status, 'forgotten');
    assert.equal(row(corrected).replaced_by, null);
    assert.equal(row(a).status, 'replaced', 'forgetting never resurrects ancestors');
    assert.match(memory.read({ since_revision: replacedRevision }).text, /forgotten/);
    assert.ok(!memory.snapshot().includes(corrected));
    assert.throws(() => memory.read({ since_revision: remove.revision + 1 }), /future/);
    assert.throws(() => write('x'.repeat(301)), /300/);
    assert.throws(() => memory.write({ mode: 'compress', replaces: [projectNote, projectNote], lines: [] }), /unique/);
    const short1 = write('one');
    const short2 = write('two');
    assert.throws(() => memory.write({ mode: 'compress', replaces: [short1, short2], lines: [{ text: 'x'.repeat(300), importance: 'high' }] }), /reduce/);
    assert.equal(row(short1).status, 'active');

    // Comparable-age notes load in importance order. Continued all-high
    // ingestion still omits old detail, regardless of successful compression.
    const low = write('low ordering sentinel', 'low');
    const medium = write('medium ordering sentinel', 'medium');
    const high = write('high ordering sentinel', 'high');
    const ordered = memory.snapshot();
    assert.ok(ordered.indexOf(high) < ordered.indexOf(medium));
    assert.ok(ordered.indexOf(medium) < ordered.indexOf(low));
    const oldHigh = write('Old high fact sentinel ' + 'x'.repeat(260));
    const beforeBulk = memory.read({}).revision;
    time = new Date('2026-10-01T12:00:00Z');
    const scripts = ['plain prose ', '漢字の記憶 ', '👩🏽‍💻🔥 ', '\\"\ncode {} '];
    for (let batch = 0; batch < 15; batch++) {
      memory.write({ lines: Array.from({ length: 20 }, (_, i) => ({ text: `${batch}/${i} ${scripts[i % scripts.length]!.repeat(14)}`, importance: 'high' })) });
    }
    assert.equal(memory.read({ since_revision: beforeBulk }).requiresRefresh, true, 'oversized delta explicitly requests refresh');
    for (const budget of [2000, 4000, 8000]) {
      settings.updateAssistantSettings({ ...settings.assistantSettings(), memoryBudgetTokens: budget });
      const snapshot = memory.snapshot();
      assert.ok(Buffer.byteLength(snapshot) <= budget * 3, 'whole rendered snapshot obeys byte cap, including escaping and Unicode');
      assert.match(snapshot, /not loaded/);
      assert.ok(!snapshot.includes(oldHigh), 'even high importance eventually loses detail');
      assert.ok(Buffer.byteLength(memory.read({}).text) <= budget * 3);
      assert.ok(Buffer.byteLength(memory.search({ query: 'code', limit: 20 }).text) <= budget * 3);
    }
    assert.ok(memory.read({}).pressure?.candidates.length);
    const snapshot = memory.snapshot(2400);
    const voice = voiceBrief(Array.from({ length: 20 }, (_, i) => ({ id: String(i), role: 'user' as const, kind: 'text' as const, text: 'long input '.repeat(40) })), Array.from({ length: 12 }, () => ({ name: 'agent '.repeat(40), project: 'p', activity: 'working' })), snapshot)!;
    assert.ok(voice.length <= 6000);
    assert.ok(voice.includes(snapshot));
    const context = new AgentContextService();
    assert.ok(context.buildAssistant(snapshot).includes(snapshot));
    assert.ok(!context.build('p').includes('Saved assistant memory'));
    assert.ok(!context.buildRoutine().includes('Saved assistant memory'));

    // Real caller resolution: workspace routines, ordinary agents, owners,
    // expired identities and paired-host reads do not gain memory access.
    for (const role of ['assistant', 'routine', 'orchestrator']) {
      db.prepare("insert into processes(id,project_id,kind,name,status,created_at,updated_at) values(?,?,'agent',?,'running',?,?)").run(`proc-${role}`, 'p', role, now, now);
      db.prepare('insert into sessions(id,project_id,process_id,harness,session_role,started_at,cwd,mcp_identity) values(?,?,?,?,?,?,?,?)').run(role, 'p', `proc-${role}`, 'codex', role, now, dir, `mcp-${role}`);
    }
    const launchingIdentities = new LaunchingMcpIdentities();
    const registry = createTestMcpRegistry({ tempDir: dir, database, timeline: new TimelineService(database), terminal: { request: async () => ({}) } as unknown as TerminalService, workbench: new WorkbenchRepository(database, settings), assistantMemory: memory, launchingIdentities });
    const tool = 'assistant_memory_read';
    const assistantCaller = { identity: 'mcp-assistant' };
    const releaseWorker = launchingIdentities.reserve('mcp-starting-worker', 'codex', 'orchestrator');
    const releaseAssistant = launchingIdentities.reserve('mcp-starting-assistant', 'codex', 'assistant');
    for (const memoryEnabled of [false, true]) {
      settings.updateAssistantSettings({ ...settings.assistantSettings(), memoryEnabled });
      const ordinaryCatalog = registry.publicTools({ identity: 'mcp-starting-worker' });
      assert.ok(ordinaryCatalog.length > 0, 'pre-registration catalogue discovery remains available');
      assert.ok(!ordinaryCatalog.some((item) => item.name === tool));
      assert.equal(registry.publicTools({ identity: 'mcp-starting-assistant' }).some((item) => item.name === tool), memoryEnabled, 'launching assistants discover enabled memory tools before registration');
      assert.ok(registry.publicTools({ identity: 'unregistered' }).length > 0);
    }
    await assert.rejects(registry.callPublic(tool, {}, { identity: 'mcp-starting-assistant' }), /identity/);
    await assert.rejects(registry.call(tool, {}, { identity: 'mcp-starting-assistant' }), /identity/, 'discovery does not authorize tool calls');
    releaseWorker(); releaseAssistant();
    assert.ok(!registry.publicTools({ identity: 'mcp-starting-assistant' }).some((item) => item.name === tool));

    // Reproduce omitted candidates, then compress using only public operations.
    // A fresh/compacted assistant has no direct database access to these facts.
    settings.updateAssistantSettings({ ...settings.assistantSettings(), memoryBudgetTokens: 2000 });
    time = new Date('2026-08-01T12:00:00Z');
    memory.write({ lines: Array.from({ length: 20 }, (_, i) => ({ text: `Old related candidate ${i} ${'x'.repeat(270)}`, importance: 'high' })) });
    time = new Date('2026-10-01T12:00:00Z');
    // The oldest low group goes first; after forgetting it, the older high
    // candidates are omitted but must still be accessible by their IDs.
    const lowPressure = await registry.callPublic(tool, {}, assistantCaller) as ReturnType<AssistantMemoryService['read']>;
    await registry.callPublic('assistant_memory_write', { mode: 'compress', replaces: lowPressure.pressure!.candidates.slice(0, 2), lines: [] }, assistantCaller);
    const omittedCandidates = await registry.callPublic(tool, {}, assistantCaller) as ReturnType<AssistantMemoryService['read']>;
    assert.ok(omittedCandidates.pressure!.candidates.every((id) => !omittedCandidates.text.includes(id)), 'pressure candidates can all be absent from the loaded snapshot');
    for (let cycle = 0; cycle < 4; cycle++) {
      const current = await registry.callPublic(tool, {}, assistantCaller) as ReturnType<AssistantMemoryService['read']>;
      const ids = current.pressure!.candidates.slice(0, 2);
      const fetched = await registry.callPublic('assistant_memory_search', { ids }, assistantCaller) as ReturnType<AssistantMemoryService['search']>;
      assert.ok(ids.every((id) => fetched.text.includes(id)), 'omitted candidate content is retrievable');
      assert.match(fetched.text, /\[high; workspace;/);
      assert.ok(Buffer.byteLength(fetched.text) <= 6000);
      await registry.callPublic('assistant_memory_write', { mode: 'compress', replaces: ids, lines: [{ text: `Concise related facts ${cycle}.`, importance: 'high' }] }, assistantCaller);
    }
    const forget = await registry.callPublic(tool, {}, assistantCaller) as ReturnType<AssistantMemoryService['read']>;
    const pressureIds = forget.pressure!.candidates.slice(0, 2);
    await registry.callPublic('assistant_memory_write', { mode: 'compress', replaces: pressureIds, lines: [] }, assistantCaller);
    const retired = await registry.callPublic('assistant_memory_search', { ids: pressureIds, history: true }, assistantCaller) as ReturnType<AssistantMemoryService['search']>;
    assert.match(retired.text, /\[forgotten\]/);
    assert.ok(!memory.search({ ids: pressureIds }).text.includes(pressureIds[0]!));
    assert.throws(() => memory.search({ ids: [] }));
    assert.throws(() => memory.search({ ids: Array(7).fill('id') }));
    assert.throws(() => memory.search({ ids: ['id'], query: 'also query' }));
    assert.throws(() => memory.search({}));
    assert.ok(registry.publicTools({ identity: 'mcp-assistant' }).some((item) => item.name === tool));
    for (const identity of ['mcp-routine', 'mcp-orchestrator', null]) {
      assert.ok(!registry.publicTools({ identity }).some((item) => item.name === tool));
      await assert.rejects(registry.callPublic(tool, {}, { identity }), /Only the assistant/);
    }
    await assert.rejects(registry.callPublic(tool, {}, { identity: 'expired' }), /Only the assistant|identity/);
    await assert.rejects(registry.call(tool, {}, { remote: { host_id: 'remote', host_name: 'remote', project_id: 'p' } }), /Only the assistant/);
    settings.updateAssistantSettings({ ...settings.assistantSettings(), memoryEnabled: false });
    assert.equal(memory.snapshot(), '');
    assert.ok(!registry.publicTools({ identity: 'mcp-assistant' }).some((item) => item.name === tool));
    await assert.rejects(registry.callPublic(tool, {}, { identity: 'mcp-assistant' }), /disabled/);
    const latest = remove.revision;
    database.dispose();
    database.initialize();
    settings.updateAssistantSettings({ ...settings.assistantSettings(), memoryEnabled: true });
    assert.ok(memory.read({}).revision > latest, 'revision and facts survive restart');
    assert.equal(row(corrected).status, 'forgotten');
  } finally {
    database.dispose();
    removeTree(dir);
  }
}

void main().then(() => console.log('assistant memory smoke passed'));
