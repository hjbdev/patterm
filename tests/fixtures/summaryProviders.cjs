#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
assert.equal(process.env.OPENAI_API_KEY, undefined);
assert.equal(process.env.PATTERM_PROCESS_ID, undefined);
assert.equal(process.env.NODE_OPTIONS, undefined);
if (args.includes('--help')) {
  console.log('--ignore-user-config --ignore-rules --strict-config --ephemeral');
} else if (args[0] === 'debug') {
  // Only the refreshed catalogue knows newer-model.
  const slugs = ['gpt-5.6-luna', 'bad-json', 'bad-schema', 'error', ...(args.includes('--bundled') ? [] : ['newer-model'])];
  console.log(JSON.stringify({ models: slugs.map(slug => ({ slug, shell_type: 'unified_exec', apply_patch_tool_type: 'freeform' })) }));
} else if (args[0] === 'exec') {
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.includes('--ignore-rules'));
  assert.ok(args.includes('--ephemeral'));
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(fs.lstatSync(path.join(process.env.CODEX_HOME, 'auth.json')).isSymbolicLink());
  assert.equal(fs.existsSync(path.join(process.env.CODEX_HOME, 'AGENTS.md')), false);
  const config = Object.fromEntries(args.flatMap((value, index) => value === '-c' ? [args[index + 1].split(/=(.*)/s).slice(0, 2)] : []));
  assert.equal(config.forced_login_method, '"chatgpt"');
  assert.equal(config['skills.include_instructions'], 'false');
  assert.equal(config.model_reasoning_effort, '"low"', 'default Codex summary reasoning');
  const catalog = JSON.parse(fs.readFileSync(JSON.parse(config.model_catalog_json)));
  assert.equal(catalog.models[0].shell_type, 'disabled');
  assert.equal(catalog.models[0].apply_patch_tool_type, null);
  assert.equal(catalog.models[0].multi_agent_version, 'disabled');
  const prompt = fs.readFileSync(JSON.parse(config.model_instructions_file), 'utf8');
  let input = '';
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    assert.equal(typeof JSON.parse(input).terminal_output, 'string');
    if (JSON.parse(input).terminal_output === 'patterm okay') assert.match(prompt, /Return exactly this JSON object/);
    const model = args[args.indexOf('--model') + 1];
    if (model === 'bad-json') return console.log('bad output');
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(model === 'bad-schema' ? { command: 'unsafe' } : { summary: 'patterm okay' }) } }));
    console.log(JSON.stringify({ type: model === 'error' ? 'turn.failed' : 'turn.completed' }));
  });
} else {
  assert.deepEqual(args.slice(0, 4), ['api', 'POST', '/api/generate', '--data']);
  const body = JSON.parse(args[4]);
  assert.equal(body.model.providerID, 'openai');
  assert.ok(body.prompt.includes('terminal_output'));
  assert.equal(body.tools, undefined);
  assert.equal(body.sessionID, undefined);
  if (body.model.id === 'bad-json') return console.log('bad output');
  if (body.model.id === 'error') return console.log(JSON.stringify({ error: 'sensitive provider diagnostic' }));
  console.log(JSON.stringify({ data: { text: JSON.stringify(body.model.id === 'bad-schema' ? { command: 'unsafe' } : { summary: 'patterm okay' }) } }));
}
