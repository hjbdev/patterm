import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readClaudeTaskOutput } from '../app/Services/ClaudeTaskOutput';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-task-output-'));
try {
  const cwd = '/home/example/Dev/project';
  const sessionId = '11111111-2222-3333-4444-555555555555';
  const env = { CLAUDE_CONFIG_DIR: path.join(root, 'config'), CLAUDE_CODE_TMPDIR: path.join(root, 'tmp') };
  const location = { cwd, sessionId, env };
  const project = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  // Claude Code appends claude-<uid> on POSIX and plain claude on Windows.
  const tasks = path.join(root, 'tmp', process.platform === 'win32' ? 'claude' : `claude-${os.userInfo().uid}`, project, sessionId, 'tasks');
  const subagents = path.join(root, 'config', 'projects', project, sessionId, 'subagents');
  fs.mkdirSync(tasks, { recursive: true });
  fs.mkdirSync(subagents, { recursive: true });

  // A background agent's output links to its transcript.
  const transcript = path.join(subagents, 'agent-a1b2c3.jsonl');
  fs.writeFileSync(transcript, [
    { type: 'user', sessionId, isSidechain: true, agentId: 'a1b2c3', message: { role: 'user', content: 'Review the diff' } },
    { type: 'assistant', sessionId, isSidechain: true, agentId: 'a1b2c3', message: { role: 'assistant', content: [{ type: 'text', text: 'No findings.' }] } }
  ].map((row) => JSON.stringify(row)).join('\n'));
  // Without symlink rights, as on a default Windows account, Claude Code leaves
  // the output file empty instead; the transcript is found beside it.
  if (process.platform === 'win32') fs.writeFileSync(path.join(tasks, 'a1b2c3.output'), '');
  else fs.symlinkSync(transcript, path.join(tasks, 'a1b2c3.output'));
  const agent = readClaudeTaskOutput(location, 'a1b2c3');
  assert.equal(agent.format, 'transcript');
  assert.ok(agent.format === 'transcript' && agent.version);
  assert.deepEqual(agent.archived_messages.map((message) => (message as { text: string }).text), ['Review the diff', 'No findings.']);
  assert.equal(agent.cursor, null, 'a short transcript has no earlier page');
  assert.equal(readClaudeTaskOutput(location, 'a1b2c3', agent.version).format, 'unchanged');

  // A long transcript pages backwards by message index.
  const longTranscript = path.join(subagents, 'agent-longagent.jsonl');
  fs.writeFileSync(longTranscript, Array.from({ length: 450 }, (_, index) => JSON.stringify({ type: 'assistant', sessionId, message: { role: 'assistant', content: [{ type: 'text', text: `step ${index}` }] } })).join('\n'));
  const texts = (output: ReturnType<typeof readClaudeTaskOutput>) => output.format === 'transcript' ? output.archived_messages.map((message) => (message as { text: string }).text) : [];
  const newest = readClaudeTaskOutput(location, 'longagent');
  assert.ok(newest.format === 'transcript' && newest.cursor === '250');
  assert.deepEqual([texts(newest).length, texts(newest)[0], texts(newest).at(-1)], [200, 'step 250', 'step 449']);
  // New messages do not move a cursor already handed out.
  fs.appendFileSync(longTranscript, `\n${JSON.stringify({ type: 'assistant', sessionId, message: { role: 'assistant', content: [{ type: 'text', text: 'step 450' }] } })}`);
  const middle = readClaudeTaskOutput(location, 'longagent', newest.version, newest.cursor);
  assert.ok(middle.format === 'transcript' && middle.cursor === '50');
  assert.deepEqual([texts(middle)[0], texts(middle).at(-1)], ['step 50', 'step 249']);
  const oldest = readClaudeTaskOutput(location, 'longagent', null, middle.cursor);
  assert.ok(oldest.format === 'transcript' && oldest.cursor === null);
  assert.deepEqual([texts(oldest).length, texts(oldest)[0]], [50, 'step 0']);
  assert.throws(() => readClaudeTaskOutput(location, 'longagent', null, 'x'), /Invalid task output cursor/);

  // After a reboot clears the temporary directory, the transcript remains.
  fs.rmSync(path.join(tasks, 'a1b2c3.output'));
  assert.equal(readClaudeTaskOutput(location, 'a1b2c3').format, 'transcript');

  // A background shell that has not printed yet is an empty file, not a missing one.
  fs.writeFileSync(path.join(tasks, 'bquiet1.output'), '');
  assert.deepEqual(readClaudeTaskOutput(location, 'bquiet1').format, 'text');

  // A background shell writes plain text.
  fs.writeFileSync(path.join(tasks, 'bshell1.output'), 'building\ndone\n');
  const shell = readClaudeTaskOutput(location, 'bshell1');
  assert.ok(shell.format === 'text');
  assert.equal(shell.text, 'building\ndone\n');
  assert.equal(shell.truncated, false);

  // Long output keeps its tail.
  fs.writeFileSync(path.join(tasks, 'blong.output'), `${'x'.repeat(300 * 1024)}END`);
  const long = readClaudeTaskOutput(location, 'blong');
  assert.ok(long.format === 'text' && long.truncated && long.text.endsWith('END'));

  // A project directory Claude shortened is found by the session id.
  const moved = { ...location, cwd: '/somewhere/else' };
  assert.equal(readClaudeTaskOutput(moved, 'bshell1').format, 'text');

  assert.equal(readClaudeTaskOutput(location, 'unknown').format, 'missing');
  assert.throws(() => readClaudeTaskOutput(location, '../agent-a1b2c3'), /Invalid background task id/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('claude task output smoke passed');
