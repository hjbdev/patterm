#!/usr/bin/env node
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('--print --tools --strict-mcp-config --mcp-config --disable-slash-commands --no-session-persistence --setting-sources --settings --system-prompt --output-format --no-chrome');
} else {
  assert.equal(args.includes('--bare'), false);
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.deepEqual(JSON.parse(args[args.indexOf('--mcp-config') + 1]), { mcpServers: {} });
  assert.equal(process.env.PATTERM_PROCESS_ID, undefined);
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
  let input = '';
  process.stdin.on('data', (data) => { input += data; });
  process.stdin.on('end', () => {
    assert.equal(typeof JSON.parse(input).terminal_output, 'string');
    const model = args[args.indexOf('--model') + 1];
    if (model === 'health-check') {
      const prompt = args[args.indexOf('--system-prompt') + 1];
      assert.ok(prompt.includes('Return exactly this JSON object: {"summary":"patterm okay"}'));
      assert.equal(JSON.parse(input).terminal_output, 'patterm okay');
    }
    if (model === 'bad-json') return console.log('invalid provider output');
    if (model === 'error') process.exitCode = 1;
    console.log(JSON.stringify({ type: 'result', subtype: model === 'error' ? 'error' : 'success', is_error: model === 'error',
      usage: { input_tokens: 50, cache_read_input_tokens: 20, cache_creation_input_tokens: 10, output_tokens: 5 },
      modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 50, cacheReadInputTokens: 20, cacheCreationInputTokens: 10, outputTokens: 5, costUSD: 0.0001 } },
      result: JSON.stringify(model === 'bad-schema' ? { command: 'unsafe' } : { summary: 'patterm okay' }) }));
  });
}
