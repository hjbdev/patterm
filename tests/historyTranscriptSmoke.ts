import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ClaudeHistoryAdapter } from '../app/Services/AgentHistory/ClaudeHistoryAdapter';
import { CodexHistoryAdapter } from '../app/Services/AgentHistory/CodexHistoryAdapter';
import { OpenCodeHistoryAdapter } from '../app/Services/AgentHistory/OpenCodeHistoryAdapter';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-transcript-'));
function jsonl(name: string, rows: unknown[]): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n'));
  return file;
}
try {
  const claude = new ClaudeHistoryAdapter();
  const guidance = { type: 'system', subtype: 'informational', content: 'Auto mode lets Claude handle permission prompts automatically', sessionId: 'claude', cwd: root };
  const parsed = claude.parseFile(jsonl('claude.jsonl', [guidance,
    { type: 'user', sessionId: 'claude', message: { role: 'user', content: 'Explain auto mode' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Here is the explanation.' }] } }
  ]));
  assert.deepEqual(parsed.conversations[0]!.messages.map(m => m.text), ['Explain auto mode', 'Here is the explanation.']);
  assert.equal(claude.parseFile(jsonl('empty.jsonl', [guidance])).conversations.flatMap(c => c.messages).length, 0);

  const response = (role: string, text: string, kinds?: string[]) => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: 'input_text', text }], ...(kinds ? { internal_chat_message_metadata_passthrough: { content_item_kinds: kinds } } : {}) } });
  const codex = new CodexHistoryAdapter().parseFile(jsonl('codex.jsonl', [
    { type: 'session_meta', payload: { id: 'codex', cwd: root } },
    response('developer', 'System instructions'),
    response('user', '# AGENTS.md instructions for /example\n<INSTRUCTIONS>Rules</INSTRUCTIONS>', ['agents_md.instructions']),
    response('user', '<environment_context>cwd</environment_context>'),
    { type: 'turn_context', payload: { summary: 'internal summary' } },
    response('user', 'Find the bug', ['user_input']),
    { type: 'event_msg', payload: { type: 'user_message', message: 'Find the bug' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Fixed the bug' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed ' }, { type: 'output_text', text: 'the bug' }] } },
    // A user discussing AGENTS.md must still be retained.
    response('user', '# AGENTS.md instructions for /example\nPlease explain this heading.', ['user_input']),
  ]));
  assert.equal(codex.conversations[0]!.title, 'Find the bug');
  assert.deepEqual(codex.conversations[0]!.messages.map(m => m.role), ['user', 'assistant', 'user']);
  assert.equal(codex.conversations[0]!.messages.filter(m => m.text === 'Find the bug').length, 1);

  const legacy = new CodexHistoryAdapter().parseFile(jsonl('legacy.jsonl', [
    { type: 'event_msg', payload: { type: 'user_message', message: 'Legacy prompt' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Legacy answer' } }
  ]));
  assert.deepEqual(legacy.conversations[0]!.messages.map(m => m.role), ['user', 'assistant']);

  const dbPath = path.join(root, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`create table session_v2 (id text primary key, directory text, title text, version text, time_created integer, time_updated integer, parent_id text, agent text, model text, metadata text, time_archived integer);
    create table session_message (id text primary key, session_id text, type text, seq integer, time_created integer, time_updated integer, data text);
    insert into session_v2 values ('open', '/example', 'Native fixture', '2', 1, 2, null, null, null, '{}', null);`);
  const insert = db.prepare('insert into session_message values (?, ?, ?, ?, 1, 2, ?)');
  insert.run('u', 'open', 'user', 1, JSON.stringify({ text: 'The initial user prompt', files: [], time: {} }));
  insert.run('a', 'open', 'assistant', 2, JSON.stringify({ content: [{ type: 'text', text: 'The answer' }, { type: 'tool', id: 'call', name: 'bash', state: { status: 'error', input: { command: 'false' }, error: 'Command failed' } }] }));
  insert.run('s', 'open', 'synthetic', 3, JSON.stringify({ text: 'Injected runtime context' }));
  insert.run('c', 'open', 'compaction', 4, JSON.stringify({ summary: 'Compacted conversation summary' }));
  insert.run('image', 'open', 'user', 5, JSON.stringify({ text: '', files: [{ name: 'screenshot.png', mime: 'image/png', data: 'binary-do-not-import' }] }));
  insert.run('shell', 'open', 'shell', 6, JSON.stringify({ command: 'git status', status: 'exited', output: 'clean' }));
  db.exec("insert into session_v2 values ('empty', '/example', 'Empty', '2', 1, 2, null, null, null, '{}', null); insert into session_v2 values ('corrupt', '/example', 'Corrupt', '2', 1, 2, null, null, null, '{}', null);");
  insert.run('broken', 'corrupt', 'user', 1, '{');
  db.close();
  const open = new OpenCodeHistoryAdapter().parseFile(dbPath, { providerConversationIds: ['open'] }).conversations[0]!;
  assert.equal(open.messages[0]!.text, 'The initial user prompt');
  assert.deepEqual(open.messages.map(m => m.role), ['user', 'assistant', 'tool', 'system', 'user', 'tool']);
  assert.equal(open.messages[2]!.toolOutputSummary, 'Command failed');
  assert.equal(open.messages[3]!.kind, 'summary');
  assert.equal(open.messages[4]!.text, 'Attachment: screenshot.png');
  assert.equal(open.messages[5]!.toolName, 'shell');
  assert.equal(open.messages[5]!.toolOutputSummary, 'clean');
  assert.equal(JSON.stringify(open).includes('binary-do-not-import'), false);
  assert.equal(new OpenCodeHistoryAdapter().parseFile(dbPath, { providerConversationIds: ['empty'] }).conversations[0]!.messages.length, 0);
  assert.equal(new OpenCodeHistoryAdapter().parseFile(dbPath, { providerConversationIds: ['corrupt'] }).conversations.length, 0, 'corrupt input cannot clear an existing import');
  console.log('Native history transcript smoke tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
