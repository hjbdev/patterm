import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AgentHistoryImportService } from '../app/Services/AgentHistory/AgentHistoryImportService';
import { ClaudeHistoryAdapter } from '../app/Services/AgentHistory/ClaudeHistoryAdapter';
import { CodexHistoryAdapter } from '../app/Services/AgentHistory/CodexHistoryAdapter';
import { ProviderHistoryDiscoveryService } from '../app/Services/AgentHistory/ProviderHistoryDiscoveryService';
import { DatabaseService } from '../app/Services/DatabaseService';
import { HistoryDatabaseService } from '../app/Services/HistoryDatabaseService';
import { modelPrice } from '../app/Services/ModelPrices';
import { UsageService } from '../app/Services/UsageService';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-usage-'));
const now = new Date();
const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
const projectPath = path.join(directory, 'project');
const localDay = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

function writeClaude(root: string): void {
  const session = 'claude_usage';
  const assistant = (uuid: string, id: string, model: string, usage: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify({
    type: 'assistant', uuid, sessionId: session, cwd: projectPath, timestamp: at(30), requestId: `req_${id}`,
    message: { id, role: 'assistant', model, content: [{ type: 'text', text: `reply ${uuid}` }], usage }, ...extra
  });
  fs.mkdirSync(path.join(root, session, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(root, `${session}.jsonl`), [
    JSON.stringify({ type: 'user', uuid: 'u1', sessionId: session, cwd: projectPath, timestamp: at(31), message: { role: 'user', content: 'Count my tokens' } }),
    // One response written as two rows repeats its usage; the last copy wins.
    assistant('a1', 'msg_1', 'claude-opus-5-5', { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 5 }),
    assistant('a2', 'msg_1', 'claude-opus-5-5', { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50, output_tokens_details: { thinking_tokens: 20 }, cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 0 } }),
    assistant('a3', 'msg_err', '<synthetic>', { input_tokens: 0, output_tokens: 0 }),
    // Skills load as meta rows: one from the Skill tool, one from a slash command.
    skillRow('k1', 'ship', { sourceToolUseID: 'toolu_1' }),
    skillRow('k2', 'bro')
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(root, session, 'subagents', 'agent-1.jsonl'), `${assistant('s1', 'msg_sub', 'claude-haiku-4-5', { input_tokens: 7, output_tokens: 3 }, { isSidechain: true })}\n${skillRow('k3', 'ship', { sourceToolUseID: 'toolu_2', isSidechain: true })}\n`);
}

function skillRow(uuid: string, name: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'user', isMeta: true, uuid, sessionId: 'claude_usage', cwd: projectPath, timestamp: at(30), message: { role: 'user', content: [{ type: 'text', text: `Base directory for this skill: /home/me/.claude/skills/${name}\n\n# ${name}` }] }, ...extra });
}

function writeCodex(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  const tokenCount = (minutesAgo: number, total: Record<string, number>, last: Record<string, number>, usedPercent: number) => JSON.stringify({
    timestamp: at(minutesAgo), type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last }, rate_limits: { limit_id: 'codex', primary: { used_percent: usedPercent, window_minutes: 300, resets_at: Math.floor(now.getTime() / 1000) + 3600 }, secondary: { used_percent: 12, window_minutes: 10080, resets_at: Math.floor(now.getTime() / 1000) - 60 } } }
  });
  fs.writeFileSync(path.join(root, 'rollout-usage.jsonl'), [
    JSON.stringify({ timestamp: at(20), type: 'session_meta', payload: { id: 'codex_usage', cwd: projectPath, cli_version: '1.0.0' } }),
    JSON.stringify({ timestamp: at(20), type: 'turn_context', payload: { turn_id: 'turn_1', model: 'gpt-6-sol', cwd: projectPath } }),
    JSON.stringify({ timestamp: at(19), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] } }),
    JSON.stringify({ timestamp: at(19), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<skill>\n<name>bro</name>\n<path>/home/me/.agents/skills/bro/SKILL.md</path>\n</skill>' }] } }),
    JSON.stringify({ timestamp: at(19), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call_1', arguments: JSON.stringify({ cmd: "sed -n '1,200p' /home/me/.agents/skills/ship/SKILL.md" }) } }),
    // A glob over every skill names none.
    JSON.stringify({ timestamp: at(19), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call_2', arguments: JSON.stringify({ cmd: 'ls /home/me/.agents/skills/*/SKILL.md' }) } }),
    // Paging through the same file in one turn is one use.
    JSON.stringify({ timestamp: at(19), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call_3', arguments: JSON.stringify({ cmd: "sed -n '201,400p' /home/me/.agents/skills/ship/SKILL.md" }) } }),
    // Listing, writing, or mentioning a skill file loads nothing.
    JSON.stringify({ timestamp: at(19), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call_4', arguments: JSON.stringify({ cmd: 'ls /home/me/.agents/skills/unused/SKILL.md' }) } }),
    JSON.stringify({ timestamp: at(19), type: 'response_item', payload: { type: 'function_call', name: 'apply_patch', call_id: 'call_5', arguments: JSON.stringify({ input: '*** Add File: /home/me/.agents/skills/unused/SKILL.md' }) } }),
    JSON.stringify({ timestamp: at(19), type: 'response_item', payload: { type: 'function_call', name: 'mcp__patterm__report_to_parent', call_id: 'call_6', arguments: JSON.stringify({ body: 'Ran cat /home/me/.agents/skills/unused/SKILL.md' }) } }),
    // One command can read several skills, and a later line that only lists one loads nothing.
    JSON.stringify({ timestamp: at(19), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call_8', arguments: JSON.stringify({ cmd: 'cat /home/me/.agents/skills/one/SKILL.md /home/me/.agents/skills/two/SKILL.md\nls /home/me/.agents/skills/unused/SKILL.md' }) } }),
    // Writing a skill with a heredoc loads nothing; a quoted sed script stays one command.
    JSON.stringify({ timestamp: at(19), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call_9', arguments: JSON.stringify({ cmd: "cat > /home/me/.agents/skills/new-skill/SKILL.md <<'EOF'\n# New\nEOF" }) } }),
    JSON.stringify({ timestamp: at(19), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call_10', arguments: JSON.stringify({ cmd: "sed -n '1,200p;201q' /home/me/.agents/skills/three/SKILL.md" }) } }),
    // A later turn reading it again is another use.
    JSON.stringify({ timestamp: at(18), type: 'turn_context', payload: { turn_id: 'turn_2', model: 'gpt-6-sol', cwd: projectPath } }),
    JSON.stringify({ timestamp: at(18), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call_7', arguments: JSON.stringify({ cmd: "cat /home/me/.agents/skills/ship/SKILL.md" }) } }),
    // A forked rollout starts with the parent's running total, so the first event counts only its own response.
    tokenCount(18, { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 500, reasoning_output_tokens: 100 }, { input_tokens: 300, cached_input_tokens: 200, output_tokens: 40, reasoning_output_tokens: 10 }, 40),
    // A repeated total only refreshes the quota.
    tokenCount(17, { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 500, reasoning_output_tokens: 100 }, { input_tokens: 300, cached_input_tokens: 200, output_tokens: 40, reasoning_output_tokens: 10 }, 41),
    tokenCount(16, { input_tokens: 5600, cached_input_tokens: 4500, output_tokens: 560, reasoning_output_tokens: 110 }, { input_tokens: 600, cached_input_tokens: 500, output_tokens: 60, reasoning_output_tokens: 10 }, 42)
  ].join('\n') + '\n');
}

function main(): void {
  const appDatabase = new DatabaseService(directory);
  const historyDatabase = new HistoryDatabaseService(directory);
  try {
    appDatabase.initialize();
    historyDatabase.initialize();
    const stamp = now.toISOString();
    appDatabase.connection.prepare('insert into projects (id, name, path, created_at, updated_at) values (?, ?, ?, ?, ?)').run('usage_project', 'Usage project', projectPath, stamp, stamp);

    const claudeRoot = path.join(directory, 'claude');
    const codexRoot = path.join(directory, 'codex');
    writeClaude(claudeRoot);
    writeCodex(codexRoot);

    const claude = new ClaudeHistoryAdapter().parseFile(path.join(claudeRoot, 'claude_usage.jsonl')).conversations[0]!;
    assert.deepEqual(claude.usage?.map((entry) => [entry.model, entry.inputTokens, entry.cacheWriteTokens, entry.cacheReadTokens, entry.outputTokens, entry.reasoningTokens, entry.subagent]), [
      ['claude-opus-5-5', 10, 100, 1000, 50, 20, false],
      ['claude-haiku-4-5', 7, 0, 0, 3, 0, true]
    ], 'Claude usage is deduplicated per response, skips synthetic rows, and includes subagents');

    assert.deepEqual(claude.skills?.map((entry) => [entry.name, entry.invokedBy, entry.subagent]), [
      ['ship', 'agent', false],
      ['bro', 'user', false],
      ['ship', 'agent', true]
    ], 'Claude skills come from the Skill tool, slash commands, and subagents');

    const codex = new CodexHistoryAdapter().parseFile(path.join(codexRoot, 'rollout-usage.jsonl')).conversations[0]!;
    assert.deepEqual(codex.usage?.map((entry) => [entry.model, entry.inputTokens, entry.cacheReadTokens, entry.outputTokens]), [
      ['gpt-6-sol', 100, 200, 40],
      ['gpt-6-sol', 100, 500, 60]
    ], 'Codex usage counts each new running total once and separates cached input');
    assert.deepEqual(codex.skills?.map((entry) => [entry.name, entry.invokedBy]), [['bro', 'user'], ['ship', 'agent'], ['one', 'agent'], ['two', 'agent'], ['three', 'agent'], ['ship', 'agent']], 'Codex skills come from $skill mentions and SKILL.md reads, once per turn');
    assert.deepEqual(codex.rateLimits?.map((limit) => [limit.label, limit.usedPercent]), [['5h limit', 42], ['Weekly limit', 12]], 'the newest quota windows are kept');

    const imports = new AgentHistoryImportService(historyDatabase, new ProviderHistoryDiscoveryService(), null, undefined, appDatabase);
    imports.configure({ provider: 'claude', path: claudeRoot, enabled: true, watch_enabled: false });
    imports.configure({ provider: 'codex', path: codexRoot, enabled: true, watch_enabled: false });
    imports.import({ provider: 'claude', trigger: 'manual' });
    imports.import({ provider: 'codex', trigger: 'manual' });
    // Reimporting unchanged files keeps one copy of each row.
    imports.import({ provider: 'claude', trigger: 'manual' });
    const count = historyDatabase.connection.prepare('select count(*) as count from conversation_usage').get() as { count: number };
    assert.equal(count.count, 4, 'imports store each response once');

    // A subagent writing on its own still refreshes the session's usage.
    const subagentFile = path.join(claudeRoot, 'claude_usage', 'subagents', 'agent-1.jsonl');
    const subagentRow = (id: string, model: string) => JSON.stringify({ type: 'assistant', uuid: `s_${id}`, sessionId: 'claude_usage', cwd: projectPath, timestamp: at(29), isSidechain: true, message: { id, role: 'assistant', model, content: [], usage: { input_tokens: 4, output_tokens: 2 } } });
    fs.appendFileSync(subagentFile, `${subagentRow('msg_sub2', 'claude-haiku-4-5')}\n`);
    imports.import({ provider: 'claude', trigger: 'manual' });
    const models = () => (historyDatabase.connection.prepare(`select model from conversation_usage where subagent = 1 order by id`).all() as Array<{ model: string }>).map((row) => row.model);
    assert.deepEqual(models(), ['claude-haiku-4-5', 'claude-haiku-4-5'], 'a subagent-only write is imported');
    // Changing a priced field without changing counts or totals is still stored.
    fs.writeFileSync(subagentFile, fs.readFileSync(subagentFile, 'utf8').replaceAll('claude-haiku-4-5', 'claude-sonnet-5-5'));
    imports.import({ provider: 'claude', trigger: 'manual' });
    assert.deepEqual(models(), ['claude-sonnet-5-5', 'claude-sonnet-5-5'], 'a corrected model replaces the stored rows');
    fs.writeFileSync(subagentFile, `${fs.readFileSync(subagentFile, 'utf8').split('\n')[0]!.replace('claude-sonnet-5-5', 'claude-haiku-4-5')}\n`);
    imports.import({ provider: 'claude', trigger: 'manual' });

    const usage = new UsageService(appDatabase, historyDatabase);
    usage.recordLimits('claude', [{ label: '5h limit', usedPercent: 63, resetsAt: at(-90), observedAt: at(0) }, { label: 'bad' }]);
    // An idle session's snapshot repeats its older reading; it must not replace the newer one.
    usage.recordLimits('claude', [{ label: '5h limit', usedPercent: 5, resetsAt: at(-90), observedAt: at(120) }]);
    // A host without observation times cannot date its windows.
    usage.recordLimits('claude', [{ label: 'Weekly limit', usedPercent: 50 }]);
    usage.recordLimits('codex', [{ label: '5h limit', usedPercent: 10, observedAt: at(60) }]);
    const summary = usage.summary(7, now);
    assert.equal(summary.dayKeys.length, 7);
    assert.equal(summary.dayKeys.at(-1), localDay(now), 'the chart days end today on the server calendar');
    assert.ok(summary.daily.every((row) => summary.dayKeys.includes(row.day)), 'every daily row has a chart column');
    assert.equal(summary.historyAvailable, true);
    assert.equal(summary.totals.responses, 4);
    assert.deepEqual(summary.limits.filter((limit) => limit.harness === 'claude').map((limit) => [limit.label, limit.usedPercent]), [['5h limit', 63]], 'an older reading and an undated one are ignored');
    assert.equal(summary.totals.inputTokens, 10 + 7 + 100 + 100);
    assert.equal(summary.totals.outputTokens, 50 + 3 + 40 + 60);
    assert.deepEqual(summary.daily.map((row) => row.provider).sort(), ['claude', 'codex']);
    assert.equal(summary.models[0]?.model, 'gpt-6-sol', 'models are ordered by processed tokens');
    // Opus 5.5: 10 in, 50 out, 1,000 cache reads, 100 one-hour writes; Haiku: 7 in, 3 out; GPT-6-Sol: 200 in, 700 cached, 100 out.
    const expected = (10 * 4 + 50 * 20 + 1000 * 0.2 + 100 * 8 + 7 * 1 + 3 * 5 + 200 * 2 + 700 * 0.2 + 100 * 10) / 1_000_000;
    assert.ok(Math.abs(summary.totals.costUsd - expected) < 1e-12, `API cost is ${summary.totals.costUsd}, expected ${expected}`);
    assert.equal(summary.totals.unpricedTokens, 0);
    assert.ok(modelPrice('claude-haiku-4-5-20251001'), 'dated snapshots share their alias price');
    assert.equal(modelPrice('codex-auto-review'), null, 'unpublished models have no price');
    assert.deepEqual(summary.projects.map((row) => row.name), ['Usage project'], 'linked conversations are named after their project');
    assert.deepEqual(summary.limits.map((limit) => [limit.harness, limit.label, limit.usedPercent, limit.expired]), [
      ['claude', '5h limit', 63, false],
      ['codex', '5h limit', 42, false],
      ['codex', 'Weekly limit', 12, true]
    ], 'the newest observation of each window wins, and passed resets are marked');

    assert.deepEqual(summary.skills.map((skill) => [skill.name, skill.agentUses, skill.userUses, skill.providers]), [
      // The subagent file was rewritten above without its skill row.
      ['ship', 3, 0, ['claude', 'codex']],
      ['bro', 0, 2, ['claude', 'codex']],
      ['one', 1, 0, ['codex']],
      ['three', 1, 0, ['codex']],
      ['two', 1, 0, ['codex']]
    ], 'skills are counted across harnesses, split by who invoked them');

    const empty = new UsageService(appDatabase, null).summary(1, now);
    assert.equal(empty.historyAvailable, false, 'the dashboard works without history');
    assert.equal(empty.limits.length, 2, 'live quota windows still show');
    console.log('usage smoke ok');
  } finally {
    historyDatabase.dispose();
    appDatabase.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main();
