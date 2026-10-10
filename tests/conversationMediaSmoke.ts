import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { AgentHistoryImportService } from '../app/Services/AgentHistory/AgentHistoryImportService';
import { ConversationMediaService } from '../app/Services/AgentHistory/ConversationMediaService';
import { ProviderHistoryDiscoveryService } from '../app/Services/AgentHistory/ProviderHistoryDiscoveryService';
import { DatabaseService } from '../app/Services/DatabaseService';
import { HistoryDatabaseService } from '../app/Services/HistoryDatabaseService';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const OTHER = Buffer.from('a second image, not decoded by the index').toString('base64');
const THIRD = Buffer.from('a third image').toString('base64');
const sha = (base64: string) => crypto.createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');

// Images pasted into or viewed in a conversation are indexed without copying
// them, listed once per conversation, and read back from the transcript.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-media-'));
const appDatabase = new DatabaseService(directory);
const historyDatabase = new HistoryDatabaseService(directory);
try {
  appDatabase.initialize();
  historyDatabase.initialize();
  const now = '2026-10-10T10:00:00.000Z';
  const projectPath = path.join(directory, 'project');
  appDatabase.connection.prepare('insert into projects (id, name, path, created_at, updated_at) values (?, ?, ?, ?, ?)').run('media_project', 'Media', projectPath, now, now);

  // Multi-byte text before the images checks that offsets count bytes.
  const claudeDir = path.join(directory, 'claude');
  fs.mkdirSync(claudeDir);
  const claude = (uuid: string, role: string, content: unknown, at: string) => JSON.stringify({ type: role, uuid, sessionId: 'claude_media', cwd: projectPath, timestamp: at, message: { role, content } });
  fs.writeFileSync(path.join(claudeDir, 'claude_media.jsonl'), [
    claude('c1', 'user', 'Héllo ✓ — look at this', '2026-10-10T10:00:01.000Z'),
    claude('c2', 'user', [{ type: 'text', text: 'Here is a screenshot' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }], '2026-10-10T10:00:02.000Z'),
    claude('c3', 'assistant', [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/shot.png' } }], '2026-10-10T10:00:03.000Z'),
    claude('c4', 'user', [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: OTHER } }] }], '2026-10-10T10:00:04.000Z'),
    // Viewing the pasted image again lists it once.
    claude('c5', 'assistant', [{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: '/tmp/again.png' } }], '2026-10-10T10:00:05.000Z'),
    claude('c6', 'user', [{ type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] }], '2026-10-10T10:00:06.000Z')
  ].join('\r\n') + '\r\n');

  const codexDir = path.join(directory, 'codex');
  fs.mkdirSync(codexDir);
  const codex = (at: string, payload: unknown) => JSON.stringify({ timestamp: at, type: 'response_item', payload });
  fs.writeFileSync(path.join(codexDir, 'rollout.jsonl'), [
    JSON.stringify({ timestamp: now, type: 'session_meta', payload: { id: 'codex_media', cwd: projectPath } }),
    codex('2026-10-10T11:00:01.000Z', { type: 'message', role: 'user', content: [
      { type: 'input_text', text: 'What is wrong here?' },
      { type: 'input_text', text: '<image name=[Image #1] path="/uploads/pasted.png">' },
      { type: 'input_image', image_url: `data:image/png;base64,${THIRD}` },
      { type: 'input_text', text: '</image>' }
    ] }),
    codex('2026-10-10T11:00:02.000Z', { type: 'custom_tool_call', call_id: 'call_1', name: 'exec', input: 'await view_image({path:"/tmp/view.png"})' }),
    codex('2026-10-10T11:00:03.000Z', { type: 'custom_tool_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: 'Script completed' }, { type: 'input_image', image_url: `data:image/png;base64,${PNG}` }] })
  ].join('\n') + '\n');

  const imports = new AgentHistoryImportService(historyDatabase, new ProviderHistoryDiscoveryService(), null, undefined, appDatabase);
  imports.configure({ provider: 'claude', path: claudeDir, enabled: true, watch_enabled: false });
  imports.configure({ provider: 'codex', path: codexDir, enabled: true, watch_enabled: false });
  imports.import({ provider: 'claude', trigger: 'manual' });
  imports.import({ provider: 'codex', trigger: 'manual' });

  const output = historyDatabase.connection.prepare(`select tool_output_summary from conversation_messages where kind = 'tool_result' and tool_name = 'Read' order by seq limit 1`).get() as { tool_output_summary: string };
  assert.equal(output.tool_output_summary, '[Image]', 'an image tool result is not stored as base64 text');

  const media = new ConversationMediaService(historyDatabase);
  const all = media.list({ project_id: 'media_project' });
  assert.equal(all.total, 4, 'each image is listed once per conversation');
  assert.deepEqual(all.items.map((item) => [item.kind, item.name, item.mime]), [
    ['viewed', '/tmp/view.png', 'image/png'],
    ['pasted', '/uploads/pasted.png', 'image/png'],
    ['viewed', '/tmp/shot.png', 'image/jpeg'],
    ['pasted', null, 'image/png']
  ], 'newest first, named by the file read or uploaded');
  const pasted = all.items.find((item) => item.kind === 'pasted' && item.conversationTitle === 'Héllo ✓ — look at this');
  assert.ok(pasted?.messageId, 'an image links to its message');
  const message = historyDatabase.connection.prepare('select text from conversation_messages where id = ?').get(pasted!.messageId) as { text: string };
  assert.equal(message.text, 'Here is a screenshot');

  assert.deepEqual(media.list({ project_id: 'media_project', kind: 'pasted' }).items.map((item) => item.name), ['/uploads/pasted.png', null]);
  assert.equal(media.list({ project_id: 'other_project' }).total, 0, 'another project sees no images');

  for (const data of [PNG, OTHER, THIRD]) {
    assert.equal(media.read({ project_id: 'media_project', sha256: sha(data) }).data, data, 'an image is read back from its transcript');
  }
  assert.throws(() => media.read({ project_id: 'other_project', sha256: sha(PNG) }), /no longer stored/);

  // A rewritten transcript no longer matches the indexed hash.
  const codexFile = path.join(codexDir, 'rollout.jsonl');
  fs.writeFileSync(codexFile, fs.readFileSync(codexFile, 'utf8').replace(THIRD, Buffer.from('changed').toString('base64')));
  assert.throws(() => media.read({ project_id: 'media_project', sha256: sha(THIRD) }), /no longer stored/);

  // OpenCode keeps pasted files in the message and viewed images in tool state.
  const openCodePath = path.join(directory, 'opencode.db');
  const openCode = new DatabaseSync(openCodePath);
  openCode.exec(`
    create table session_v2 (id text primary key, directory text, title text, version text, time_created integer, time_updated integer, time_archived integer, parent_id text, agent text, model text, metadata text);
    create table session_message (id text primary key, session_id text, type text, seq integer, time_created integer, time_updated integer, data text);
  `);
  const created = Date.parse('2026-10-10T12:00:00.000Z');
  openCode.prepare('insert into session_v2 values (?, ?, ?, ?, ?, ?, null, null, null, null, null)').run('ses_media', projectPath, 'OpenCode media', '1', created, created + 2000);
  const insertMessage = openCode.prepare('insert into session_message values (?, ?, ?, ?, ?, ?, ?)');
  insertMessage.run('msg_user', 'ses_media', 'user', 1, created + 1000, created + 1000, JSON.stringify({ text: 'See [Image 1]', files: [{ data: PNG, mime: 'image/png', source: { type: 'inline' }, name: 'pasted-image.png' }] }));
  insertMessage.run('msg_tool', 'ses_media', 'assistant', 2, created + 2000, created + 2000, JSON.stringify({ content: [{ type: 'tool', name: 'read', state: { status: 'completed', input: {}, content: [{ type: 'text', text: 'read' }, { type: 'file', uri: `data:image/png;base64,${OTHER}`, mime: 'image/png', name: '/tmp/opencode.png' }] } }] }));
  openCode.close();
  imports.import({ provider: 'opencode', path: openCodePath, project_id: 'media_project', trigger: 'manual' });
  const openCodeItems = media.list({ project_id: 'media_project' }).items.filter((item) => item.conversationTitle === 'OpenCode media');
  assert.deepEqual(openCodeItems.map((item) => [item.kind, item.name]), [['viewed', '/tmp/opencode.png'], ['pasted', 'pasted-image.png']]);
  assert.equal(media.read({ project_id: 'media_project', sha256: sha(OTHER) }).data, OTHER);
  console.log('conversation media smoke passed');
} finally {
  historyDatabase.dispose();
  appDatabase.dispose();
  fs.rmSync(directory, { recursive: true, force: true });
}
