// Opt-in acceptance test: uses the installed Codex CLI and its native login.
// All Patterm records and MCP calls belong to a temporary database/socket.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { McpSocketServer } from '../app/MCP/McpSocketServer';
import { McpToolRegistry } from '../app/MCP/ToolRegistry';
import { registerAssistantMemoryTools } from '../app/MCP/registerAssistantMemoryTools';
import { AgentContextService } from '../app/Services/AgentContextService';
import { AssistantMemoryService } from '../app/Services/AssistantMemoryService';
import { CodexAppServerService } from '../app/Services/CodexAppServerService';
import type { IntegratedLaunchInput } from '../app/Services/IntegratedAgentService';
import { DatabaseService } from '../app/Services/DatabaseService';
import { SettingsService } from '../app/Services/SettingsService';
import type { IntegratedConversationMessage } from '../app/Services/IntegratedConversation';
import { removeTree } from './fixtures/TempTree';

async function main(): Promise<void> {
  assert.equal(process.env.PATTERM_LIVE_MEMORY, '1', 'Set PATTERM_LIVE_MEMORY=1 to spend native Codex usage on this acceptance test.');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-memory-live-'));
  const database = new DatabaseService(directory);
  database.initialize();
  const settings = new SettingsService(database);
  const memory = new AssistantMemoryService(database, settings);
  const identities = new Set<string>();
  const registry = new McpToolRegistry();
  const isAssistant = (context: { identity?: string | null }) => Boolean(context.identity && identities.has(context.identity));
  registerAssistantMemoryTools(registry, memory, (context) => isAssistant(context) ? null : undefined, isAssistant);
  const calls: string[] = [];
  registry.setRouter((name) => { calls.push(name); return null; });
  const socket = new McpSocketServer(path.join(directory, 'mcp.sock'), registry);
  const codex = new CodexAppServerService(database, path.join(directory, 'runtime'));
  const processes: string[] = [];
  const count = () => (database.connection.prepare('select count(*) as n from assistant_memory').get() as { n: number }).n;
  try {
    await socket.start();
    const now = new Date().toISOString();
    database.connection.prepare('insert into projects(id,name,path,created_at,updated_at) values(?,?,?,?,?)')
      .run('memory-test', 'Memory acceptance test', directory, now, now);
    const launch = async (): Promise<string> => {
      const identity = `memory-test-${randomUUID()}`;
      identities.add(identity);
      const input: IntegratedLaunchInput = {
        executable: process.env.PATTERM_CODEX_EXECUTABLE ?? 'codex', cwd: directory, name: 'Memory acceptance test',
        context: `${new AgentContextService().buildAssistant(memory.snapshot())}\n\nThis is an isolated conversational acceptance test. No projects or agents need management. Only assistant_memory_* tools may be used; do not use shell commands, web, or subagents.`,
        mcp: { command: process.execPath, args: [path.resolve('dist/mcp/patterm-mcp.js')], env: { PATTERM_MCP_SOCKET: socket.address, PATTERM_MCP_IDENTITY: identity } },
        resumeId: null
      };
      const prepared = await codex.prepare(input);
      const processId = `memory-test-${processes.length}`;
      try {
        database.connection.prepare("insert into processes(id,project_id,kind,name,status,cwd,argv,created_at,updated_at) values(?,'memory-test','agent','Memory acceptance test','running',?,?,?,?)")
          .run(processId, directory, JSON.stringify(prepared.argv), now, now);
        database.connection.prepare("insert into sessions(id,project_id,process_id,harness,interface_mode,session_role,started_at,cwd,mcp_identity,resume_id) values(?,'memory-test',?,'codex','integrated','assistant',?,?,?,?)")
          .run(processId, processId, now, directory, identity, prepared.resumeId);
        processes.push(processId);
        return processId;
      } catch (error) {
        await codex.cleanupLaunch(input, prepared);
        throw error;
      }
    };
    const ask = async (processId: string, text: string): Promise<string> => {
      calls.length = 0;
      let began = false;
      let finish!: () => void;
      let fail!: (error: Error) => void;
      const done = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
      void done.catch(() => {});
      const unsubscribe = await codex.subscribe(processId, (event) => {
        if (event.kind === 'error') fail(new Error(event.delta ?? event.detail ?? 'Native turn failed.'));
        if (event.kind !== 'status') return;
        if (event.status === 'working') began = true;
        if (event.status === 'permission' || event.status === 'question') fail(new Error(`Native test needs ${event.status}.`));
        if (began && event.status === 'idle') finish();
      });
      const timer = setTimeout(() => fail(new Error('Native memory turn timed out after 180 seconds.')), 180_000);
      try {
        await codex.prompt(processId, { text, references: [], attachments: [] });
        await done;
        assert.equal(calls[0], 'assistant_memory_read', 'every request checks memory, including a disabled or unchanged store');
        const view = await codex.conversation(processId) as { messages: { data: IntegratedConversationMessage[] } };
        return view.messages.data.filter((message) => message.role === 'assistant' && message.kind === 'text').at(-1)?.text ?? '';
      } finally {
        clearTimeout(timer);
        unsubscribe();
      }
    };
    const processId = await launch();
    await ask(processId, 'Hello. Are you there?');
    assert.equal(count(), 0, 'disabled memory records nothing');
    console.log('live memory: disabled check passed');
    settings.updateAssistantSettings({ ...settings.assistantSettings(), memoryEnabled: true });
    const name = `Raven${randomUUID().slice(0, 8)}`;
    await ask(processId, `Hi, I go by ${name}. How is it going?`);
    assert.ok(calls.includes('assistant_memory_write'), 'a durable preference is saved without a remember request');
    assert.match(memory.search({ query: name }).text, new RegExp(name), 'the native tool call persisted the preference before the reply finished');
    console.log('live memory: enabled in the same conversation and preference saved');
    const freshProcessId = await launch();
    assert.match(await ask(freshProcessId, 'What name should you use for me?'), new RegExp(name), 'a fresh conversation recalls the persisted preference');
    console.log('live memory: fresh conversation recalled the preference');
    const savedCount = count();
    settings.updateAssistantSettings({ ...settings.assistantSettings(), memoryEnabled: false });
    await ask(freshProcessId, 'I prefer bullet points for status updates. Is that clear?');
    assert.equal(count(), savedCount, 'turning memory off preserves existing notes without adding more');
    assert.ok(!calls.includes('assistant_memory_write') && !calls.includes('assistant_memory_search'));
    console.log('assistant memory live acceptance passed: disabled → enabled → preference saved → fresh conversation recalled → disabled');
  } finally {
    try {
      await Promise.all(processes.map((processId) => codex.stop(processId)));
    } finally {
      codex.disconnect();
      socket.stop();
      database.dispose();
      removeTree(directory);
    }
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
