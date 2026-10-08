import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { codexSummaryArgs, codexSummaryCatalog, codexSummaryOutput, codexSummaryEnvironment } from '../dist/tests/app/Services/AutoSummaryRunner.js';

test('native Codex sends no tools or inherited instructions', { skip: !process.env.PATTERM_TEST_CODEX }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'patterm-codex-isolation-'));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    const message = { id: 'msg_test', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '{"summary":"patterm okay"}' }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { type: 'response.created', response: { id: 'resp_test' } },
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.completed', response: { id: 'resp_test', status: 'completed', output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    await fs.writeFile(path.join(directory, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'local-fixture' }));
    const env = await codexSummaryEnvironment(directory, { HOME: directory, CODEX_HOME: directory, PATH: process.env.PATH });
    await fs.writeFile(path.join(directory, 'AGENTS.md'), 'INHERITED_INSTRUCTION_CANARY');
    await fs.mkdir(path.join(directory, 'skills/poison'), { recursive: true });
    await fs.writeFile(path.join(directory, 'skills/poison/SKILL.md'), '---\nname: poison\ndescription: INHERITED_SKILL_CANARY\n---\nINHERITED_SKILL_CANARY');
    await fs.writeFile(path.join(directory, 'config.toml'), 'developer_instructions = "INHERITED_CONFIG_CANARY"\n');
    const executable = process.env.PATTERM_TEST_CODEX;
    const signal = AbortSignal.timeout(30_000);
    const catalog = await nativeCommand(executable, ['debug', 'models', '--bundled'], '', directory, env, signal, 2 * 1024 * 1024);
    await fs.writeFile(path.join(directory, 'models.json'), codexSummaryCatalog(catalog, 'gpt-5.6-luna'));
    await fs.writeFile(path.join(directory, 'instructions.txt'), 'Return only JSON: {"summary":"patterm okay"}.');
    // Only the test transport/auth is overridden. All runner isolation settings stay in place.
    const args = codexSummaryArgs('gpt-5.6-luna', directory, 'low');
    args.splice(-1, 0, '-c', 'forced_login_method="api"', '-c', 'model_provider="fixture"',
      '-c', 'model_providers.fixture.name="Local fixture"', '-c', `model_providers.fixture.base_url="http://127.0.0.1:${server.address().port}"`,
      '-c', 'model_providers.fixture.wire_api="responses"');
    const output = await nativeCommand(executable, args, '{"terminal_output":"synthetic terminal text"}', directory, env, signal, 64 * 1024);
    assert.equal(codexSummaryOutput(output), '{"summary":"patterm okay"}');
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].tools ?? [], []);
    assert.deepEqual(JSON.stringify(requests).match(/INHERITED_(INSTRUCTION|SKILL|CONFIG)_CANARY/g), null);
    assert.deepEqual(requests[0].input.filter((item) => item.type === 'additional_tools').flatMap((item) => item.tools), []);
    assert.match(JSON.stringify(requests), /synthetic terminal text/);
    assert.equal(requests[0].reasoning?.effort, 'low', 'summary reasoning reaches the request');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function nativeCommand(executable, args, input, cwd, env, signal, maxBuffer) {
  return new Promise((resolve, reject) => {
    const child = execFile(executable, args, { cwd, env, signal, maxBuffer }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr)); else resolve(stdout);
    });
    child.stdin.end(input);
  });
}
