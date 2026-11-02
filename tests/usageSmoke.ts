import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { AgentHistoryImportService } from '../app/Services/AgentHistory/AgentHistoryImportService';
import { ClaudeHistoryAdapter } from '../app/Services/AgentHistory/ClaudeHistoryAdapter';
import { CodexHistoryAdapter } from '../app/Services/AgentHistory/CodexHistoryAdapter';
import { ProviderHistoryDiscoveryService } from '../app/Services/AgentHistory/ProviderHistoryDiscoveryService';
import { DatabaseService } from '../app/Services/DatabaseService';
import { HistoryDatabaseService } from '../app/Services/HistoryDatabaseService';
import { modelPrice } from '../app/Services/ModelPrices';
import { AutoSummaryUsageService } from '../app/Services/AutoSummaryUsageService';
import { UsageService, usagePace } from '../app/Services/UsageService';

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

function paceSmoke(): void {
  const hours = (count: number) => new Date(now.getTime() + count * 3_600_000).toISOString();
  const weekly = (usedPercent: number, extra: Partial<{ resetsAt: string; observedAt: string; label: string }> = {}) => ({ label: 'Weekly limit', usedPercent, resetsAt: hours(72), observedAt: hours(-0.2), ...extra });
  // 30% two days ago, 40% now: ten points a day for the three days left.
  const steady = usagePace(weekly(40), [{ usedPercent: 30, observedAt: hours(-48) }], now);
  assert.ok(steady && Math.abs(steady.projectedPercent - 70) < 1e-9 && steady.exhaustsAt === null, 'the last day sets the pace');
  // Thirty points a day runs out the remaining forty in 32 hours.
  const fast = usagePace(weekly(60), [{ usedPercent: 30, observedAt: hours(-48) }], now);
  assert.equal(fast?.projectedPercent, 100);
  assert.equal(fast?.exhaustsAt, hours(32), 'a fast pace runs out before the reset');
  assert.equal(usagePace(weekly(60), [{ usedPercent: 30, observedAt: hours(-48) }, { usedPercent: 60, observedAt: hours(-30) }], now)?.projectedPercent, 60, 'no change over the lookback is no pace');
  assert.equal(usagePace(weekly(20, { resetsAt: hours(150) }), [{ usedPercent: 0, observedAt: hours(-17) }], now), null, 'the first quarter of a window is too early');
  assert.equal(usagePace(weekly(40, { observedAt: hours(-30) }), [{ usedPercent: 30, observedAt: hours(-48) }], now), null, 'a stale reading has no pace');
  assert.equal(usagePace(weekly(40), [{ usedPercent: 30, observedAt: hours(-6) }], now), null, 'a few hours of readings is not enough');
  assert.ok(usagePace(weekly(40), [{ usedPercent: 30, observedAt: hours(-14) }], now), 'readings over half the lookback are enough');
  assert.equal(usagePace(weekly(40, { label: 'Overage' }), [{ usedPercent: 30, observedAt: hours(-48) }], now), null, 'a window of unknown length has no pace');
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
    assert.deepEqual(codex.rateLimitReadings?.map((reading) => [reading.label, reading.usedPercent]), [['5h limit', 40], ['Weekly limit', 12], ['5h limit', 41], ['5h limit', 42]], 'each change in a window is a reading');
    // The same figure in a new window is that window's first reading.
    const resetFile = path.join(directory, 'rollout-reset.jsonl');
    const quota = (minutesAgo: number, resetsInMinutes: number) => JSON.stringify({ timestamp: at(minutesAgo), type: 'event_msg', payload: { type: 'token_count', rate_limits: { limit_id: 'codex', primary: { used_percent: 5, window_minutes: 300, resets_at: Math.floor(now.getTime() / 1000) + resetsInMinutes * 60 } } } });
    fs.writeFileSync(resetFile, [JSON.stringify({ timestamp: at(400), type: 'session_meta', payload: { id: 'codex_reset', cwd: projectPath } }), quota(360, -180), quota(150, 120), quota(6, 120)].join('\n') + '\n');
    const reset = new CodexHistoryAdapter().parseFile(resetFile).conversations[0];
    assert.deepEqual(reset?.rateLimitReadings?.map((reading) => reading.observedAt), [at(360), at(150)], 'a reset starts a new reading at the same figure');

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

    const imported = historyDatabase.connection.prepare(`select label, used_percent as usedPercent from provider_rate_limit_readings order by observed_at, label`).all() as Array<{ label: string; usedPercent: number }>;
    assert.deepEqual(imported.map((row) => [row.label, row.usedPercent]), [['5h limit', 40], ['Weekly limit', 12], ['5h limit', 41], ['5h limit', 42]], 'imports keep quota readings');

    const usage = new UsageService(appDatabase, historyDatabase);
    usage.recordLimits('claude', [{ label: '5h limit', usedPercent: 63, resetsAt: at(-90), observedAt: at(0) }, { label: 'bad' }]);
    // An idle session's snapshot repeats its older reading; it must not replace the newer one.
    usage.recordLimits('claude', [{ label: '5h limit', usedPercent: 5, resetsAt: at(-90), observedAt: at(120) }]);
    // A host without observation times cannot date its windows.
    usage.recordLimits('claude', [{ label: 'Weekly limit', usedPercent: 50 }]);
    usage.recordLimits('codex', [{ label: '5h limit', usedPercent: 10, observedAt: at(60) }]);
    usage.recordLimits('codex', [{ label: '5h limit', usedPercent: 10, observedAt: at(50) }]);
    const readings = appDatabase.connection.prepare(`select harness, used_percent as usedPercent from harness_rate_limit_readings order by harness, observed_at`).all() as Array<{ harness: string; usedPercent: number }>;
    assert.deepEqual(readings.map((row) => [row.harness, row.usedPercent]), [['claude', 5], ['claude', 63], ['codex', 10], ['codex', 10]], 'live readings keep every observation, including a late older one');

    const summary = usage.summary(7, now);
    assert.equal(summary.dayKeys.length, 7);
    assert.equal(summary.dayKeys.at(-1), localDay(now), 'the chart days end today on the server calendar');
    assert.ok(summary.daily.every((row) => summary.dayKeys.includes(row.day)), 'every daily row has a chart column');
    assert.equal(summary.historyAvailable, true);
    assert.equal(summary.totals.responses, 4);
    assert.deepEqual(summary.limits.filter((limit) => limit.harness === 'claude').map((limit) => [limit.label, limit.usedPercent]), [['5h limit', 63]], 'an older reading and an undated one are ignored');
    assert.equal(summary.totals.inputTokens, 10 + 7 + 100 + 100);
    assert.equal(summary.totals.outputTokens, 50 + 3 + 40 + 60);
    const expectedDays = [
      `${localDay(new Date(at(30)))}:claude`,
      `${localDay(new Date(at(18)))}:codex`,
      `${localDay(new Date(at(16)))}:codex`
    ];
    assert.deepEqual(summary.daily.map((row) => `${row.day}:${row.provider}`), [...new Set(expectedDays)].sort(), 'daily rows group each provider by its local day');
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
    const summaries = new AutoSummaryUsageService(appDatabase);
    const conversationCount = historyDatabase.connection.prepare('select count(*) as count from conversations').get();
    summaries.record('codex', 'gpt-6-sol', [
      { type: 'item.completed', item: { text: 'private summary' } },
      { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, reasoning_output_tokens: 4 } }
    ].map(row => JSON.stringify(row)).join('\n'), 'usage_project');
    summaries.record('claude', 'haiku', JSON.stringify({
      usage: { cache_creation: { ephemeral_1h_input_tokens: 5 } },
      modelUsage: { 'claude-haiku-4-5': { inputTokens: 30, cacheReadInputTokens: 10, cacheCreationInputTokens: 5, outputTokens: 7 } }
    }), 'usage_project');
    summaries.record('claude', 'unknown-model', JSON.stringify({
      usage: { input_tokens: 40, cache_read_input_tokens: 10, output_tokens: 8, output_tokens_details: { thinking_tokens: 3 } }, total_cost_usd: 0.02
    }));
    // Missing or malformed metadata must not invent usage or retain provider text.
    summaries.record('claude', 'haiku', 'invalid JSON');
    summaries.record('codex', 'gpt-6-sol', JSON.stringify({ type: 'turn.completed' }));
    summaries.record('opencode', 'unknown-model', JSON.stringify({ data: { usage: { inputTokens: -1, outputTokens: '5' } } }));
    appDatabase.connection.prepare("insert into auto_summary_usage (provider, model, occurred_at, input_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, output_tokens, reasoning_tokens) values ('codex', 'gpt-6-sol', '2000-01-01T00:00:00.000Z', 9999, 0, 0, 0, 0, 0)").run();
    const combined = usage.summary(7, now);
    assert.equal(combined.totals.responses, summary.totals.responses + 3);
    assert.equal(combined.autoSummaries.responses, 3);
    assert.equal(combined.autoSummaries.inputTokens, 80 + 30 + 40);
    assert.equal(combined.autoSummaries.outputTokens, 10 + 7 + 8);
    assert.equal(combined.autoSummaries.cacheReadTokens, 20 + 10 + 10);
    assert.equal(combined.autoSummaries.reasoningTokens, 4 + 3);
    const summaryCost = (80 * 2 + 20 * 0.2 + 10 * 10 + 30 + 10 * 0.1 + 5 * 2 + 7 * 5) / 1_000_000 + 0.02;
    assert.ok(Math.abs(combined.autoSummaries.costUsd - summaryCost) < 1e-12);
    assert.ok(Math.abs(combined.totals.costUsd - summary.totals.costUsd - summaryCost) < 1e-12);
    assert.equal(combined.projects.find(row => row.projectId === 'usage_project')!.inputTokens,
      summary.projects[0]!.inputTokens + 80 + 30);
    assert.equal(combined.daily.reduce((sum, row) => sum + row.responses, 0), combined.totals.responses);
    assert.equal(combined.models.reduce((sum, row) => sum + row.responses, 0), combined.totals.responses);
    assert.deepEqual(historyDatabase.connection.prepare('select count(*) as count from conversations').get(), conversationCount,
      'summary accounting creates no conversations');
    const withoutHistory = new UsageService(appDatabase, null).summary(7, now);
    assert.equal(withoutHistory.historyAvailable, false);
    assert.deepEqual(withoutHistory.totals, combined.autoSummaries, 'summary usage works without history imports');
    const saved = appDatabase.connection.prepare('select * from auto_summary_usage').all();
    assert.ok(!JSON.stringify(saved).includes('private summary'));
    appDatabase.dispose();
    appDatabase.initialize();
    assert.deepEqual(new UsageService(appDatabase, null).summary(7, now).totals, combined.autoSummaries, 'usage survives restart');
    // A late, older observation at the same figure still shows usage had already plateaued.
    const hours = (count: number) => new Date(now.getTime() + count * 3_600_000).toISOString();
    for (const [usedPercent, observedAt] of [[30, hours(-48)], [40, hours(-1)], [40, hours(-26)]] as const) {
      usage.recordLimits('claude', [{ label: 'Weekly Opus', usedPercent, resetsAt: hours(72), observedAt }]);
    }
    const plateau = usage.summary(1, now).limits.find((limit) => limit.label === 'Weekly Opus');
    assert.equal(plateau?.projectedPercent, 40, 'a late observation sets the start of a plateau');

    // OpenCode's claude-agent runs the Claude session imported above: its turns
    // count once, from Claude's transcript, as OpenCode usage in its project.
    appDatabase.connection.prepare('insert into projects (id, name, path, created_at, updated_at) values (?, ?, ?, ?, ?)').run('opencode_project', 'OpenCode project', path.join(directory, 'other'), stamp, stamp);
    const openCodePath = path.join(directory, 'opencode.db');
    const openCode = new DatabaseSync(openCodePath);
    openCode.exec(`
      create table session_v2 (id text primary key, directory text, title text, version text, time_created integer, time_updated integer, time_archived integer, parent_id text, agent text, model text, metadata text);
      create table session_message (id text primary key, session_id text, type text, seq integer, time_created integer, time_updated integer, data text);
    `);
    const created = Date.parse(at(30));
    openCode.prepare('insert into session_v2 values (?, ?, ?, ?, ?, ?, null, null, null, null, null)').run('ses_claude_agent', projectPath, 'Claude through OpenCode', '2', created, created);
    const reply = (model: Record<string, unknown>, content: unknown[], tokens: Record<string, unknown>) => JSON.stringify({ time: { created, completed: created }, model, content, tokens, cost: 0 });
    const insertMessage = openCode.prepare('insert into session_message values (?, ?, ?, ?, ?, ?, ?)');
    insertMessage.run('msg_claude', 'ses_claude_agent', 'assistant', 1, created, created, reply({ id: 'opus', providerID: 'claude-agent' },
      [{ type: 'text', text: 'reply a2', native: { sessionID: 'claude_usage', messageID: 'a2' }, time: { created, completed: created } }], { input: 10, output: 50, reasoning: 0, cache: { read: 1000, write: 100 } }));
    insertMessage.run('msg_openai', 'ses_claude_agent', 'assistant', 2, created, created, reply({ id: 'gpt-6-sol', providerID: 'openai' },
      [{ type: 'text', text: 'other reply', time: { created, completed: created } }], { input: 3, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }));
    // A Claude session whose transcript was never imported keeps OpenCode's usage.
    insertMessage.run('msg_unmatched', 'ses_claude_agent', 'assistant', 3, created, created, reply({ id: 'opus', providerID: 'claude-agent' },
      [{ type: 'text', text: 'unmatched', native: { sessionID: 'claude_missing', messageID: 'm1' }, time: { created, completed: created } }], { input: 4, output: 6, reasoning: 0, cache: { read: 0, write: 0 } }));
    // So does a newer reply in the imported session that Claude has not written yet.
    const later = Date.parse(at(5));
    insertMessage.run('msg_newer', 'ses_claude_agent', 'assistant', 4, later, later, JSON.stringify({ time: { created: later, completed: later }, model: { id: 'opus', providerID: 'claude-agent' },
      content: [{ type: 'text', text: 'newer', native: { sessionID: 'claude_usage', messageID: 'a9' }, time: { created: later, completed: later } }], tokens: { input: 2, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 }));
    openCode.close();
    imports.import({ provider: 'opencode', path: openCodePath, project_id: 'opencode_project', trigger: 'manual' });
    const checkThroughOpenCode = (label: string) => {
      const summary = usage.summary(7, now);
      assert.equal(summary.totals.responses, combined.totals.responses + 3, `${label}: the matched claude-agent reply is not counted again`);
      assert.deepEqual(summary.models.filter((row) => row.provider === 'opencode').map((row) => [row.model, row.responses]).sort(), [
        ['claude-haiku-4-5', 1],
        ['claude-opus-5-5', 1],
        ['gpt-6-sol', 1],
        ['opus', 2]
      ], `${label}: Claude transcript usage counts as OpenCode, and replies it lacks keep their own`);
      assert.ok(!summary.models.some((row) => row.provider === 'claude' && row.model === 'claude-opus-5-5'), `${label}: no Claude copy remains`);
      assert.equal(summary.projects.find((row) => row.projectId === 'opencode_project')?.inputTokens, 10 + 7 + 3 + 4 + 2, `${label}: it counts in the OpenCode conversation's project`);
      assert.ok(Math.abs(summary.totals.costUsd - combined.totals.costUsd - (3 * 2 + 2 * 10) / 1_000_000) < 1e-12, `${label}: Claude pricing is kept`);
    };
    checkThroughOpenCode('imported');
    // An archived session imported by an older parser is re-read by a new one.
    historyDatabase.connection.prepare(`update conversation_import_files set parser_version = 'opencode-sqlite-old' where provider = 'opencode'`).run();
    historyDatabase.connection.prepare(`update conversation_usage set claude_session_id = null where provider = 'opencode'`).run();
    const archive = new DatabaseSync(openCodePath);
    archive.prepare('update session_v2 set time_archived = ?').run(created);
    archive.close();
    imports.import({ provider: 'opencode', path: openCodePath, project_id: 'opencode_project', trigger: 'manual' });
    checkThroughOpenCode('archived');
    // A failed upgrade has already recorded the new parser; its retry re-reads them too.
    historyDatabase.connection.prepare(`update conversation_import_files set status = 'error' where provider = 'opencode'`).run();
    historyDatabase.connection.prepare(`update conversation_usage set claude_session_id = null where provider = 'opencode'`).run();
    imports.import({ provider: 'opencode', path: openCodePath, project_id: 'opencode_project', trigger: 'manual' });
    checkThroughOpenCode('retried');
    // A newer subagent response does not cover the parent's missing reply.
    fs.appendFileSync(subagentFile, `${JSON.stringify({ type: 'assistant', uuid: 's_late', sessionId: 'claude_usage', cwd: projectPath, timestamp: at(1), isSidechain: true, message: { id: 'msg_sub_late', role: 'assistant', model: 'claude-haiku-4-5', content: [], usage: { input_tokens: 4, output_tokens: 2 } } })}\n`);
    imports.import({ provider: 'claude', trigger: 'manual' });
    assert.equal(usage.summary(7, now).models.find((row) => row.provider === 'opencode' && row.model === 'opus')?.responses, 2, 'subagent activity does not hide the parent\'s newer reply');
    paceSmoke();
    console.log('usage smoke ok');
  } finally {
    historyDatabase.dispose();
    appDatabase.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main();
