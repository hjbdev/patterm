import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { builtinClaudeCatalog, parseClaudeCatalog, parseCodexCatalog, parseOpenCodeCatalog } from '../app/Harness/ModelCatalog';
import { DatabaseService } from '../app/Services/DatabaseService';
import { HarnessModelCatalogService } from '../app/Services/HarnessModelCatalogService';
import { SettingsService } from '../app/Services/SettingsService';

const CODEX_CATALOG = {
  models: [
    {
      slug: 'gpt-visible',
      display_name: 'GPT Visible',
      visibility: 'list',
      default_reasoning_level: 'high',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
      service_tiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed' }, { name: 'missing id' }]
    },
    { slug: 'gpt-hidden', display_name: 'GPT Hidden', visibility: 'hide' }
  ]
};

const CLAUDE_INITIALIZE = {
  models: [
    { value: 'default', displayName: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks', supportedEffortLevels: ['low', 'max'] },
    { value: 'opus', displayName: 'Opus 5.5', supportedEffortLevels: ['low', 'xhigh', 'max'] },
    { value: 'claude-fable-5-1', displayName: 'Fable 5.1', supportedEffortLevels: ['high'] },
    { value: 'haiku', displayName: 'Haiku 4.5' }
  ]
};

async function main(): Promise<void> {
  // Pure parser coverage: hidden Codex entries are dropped, reasoning levels are kept.
  assert.deepEqual(parseCodexCatalog(CODEX_CATALOG), [
    { id: 'gpt-visible', label: 'GPT Visible', reasoning: ['low', 'high'], defaultReasoning: 'high', serviceTiers: [{ id: 'priority', label: 'Fast' }] }
  ]);
  assert.throws(() => parseCodexCatalog({}), /valid JSON/);
  assert.throws(() => parseCodexCatalog({ models: [] }), /no selectable models/);

  const openCodeModels = parseOpenCodeCatalog({
    data: [
      { id: 'gpt-x', modelID: 'gpt-x', providerID: 'openai', name: 'GPT X', enabled: true, variants: [{ id: 'low' }, { id: 'max' }] },
      { id: 'disabled', providerID: 'openai', enabled: false },
      { modelID: 'bare', providerID: 'opencode-go', enabled: true }
    ]
  });
  assert.deepEqual(openCodeModels, [
    { id: 'openai/gpt-x', label: 'GPT X', reasoning: ['low', 'max'], defaultReasoning: null },
    { id: 'opencode-go/bare', label: 'bare', reasoning: [], defaultReasoning: null }
  ]);
  assert.throws(() => parseOpenCodeCatalog({}), /valid JSON/);

  // Claude's `initialize` reply keeps versioned names and drops the implicit default.
  assert.deepEqual(parseClaudeCatalog(CLAUDE_INITIALIZE), [
    { id: 'opus', label: 'Opus 5.5', reasoning: ['low', 'xhigh', 'max'], defaultReasoning: null },
    { id: 'claude-fable-5-1', label: 'Fable 5.1', reasoning: ['high'], defaultReasoning: null },
    { id: 'haiku', label: 'Haiku 4.5', reasoning: [], defaultReasoning: null }
  ]);
  assert.throws(() => parseClaudeCatalog({}), /valid JSON/);

  const claude = builtinClaudeCatalog('2026-09-10T00:00:00.000Z');
  assert.deepEqual(claude.models.map((model) => model.id), ['fable', 'opus', 'sonnet', 'haiku']);
  assert.ok(claude.models.every((model) => model.reasoning.includes('xhigh')));

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-models-'));
  const binDir = path.join(tempDir, 'bin');
  fs.mkdirSync(binDir);
  // POSIX runs a shell script. Windows cannot, so the same fake is a node script
  // behind an npm-style .cmd shim, which also exercises the shim resolution.
  const fake = (name: string, shell: string, script: string): string => {
    const file = path.join(binDir, name);
    if (process.platform !== 'win32') {
      fs.writeFileSync(file, shell);
      fs.chmodSync(file, 0o755);
      return file;
    }
    fs.writeFileSync(`${file}.cjs`, script);
    fs.writeFileSync(`${file}.cmd`, `@ECHO off\r\n"%~dp0\\${name}.cjs" %*\r\n`);
    return `${file}.cmd`;
  };
  const codexPath = fake('codex', `#!/bin/sh\ncat <<'CATALOG'\n${JSON.stringify(CODEX_CATALOG)}\nCATALOG\n`,
    `console.log(${JSON.stringify(JSON.stringify(CODEX_CATALOG))});\n`);

  // Fake Claude answers the initialize control request, then waits for stdin.
  const initializeReply = JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'patterm_models', response: CLAUDE_INITIALIZE } });
  const claudePath = fake('claude', `#!/bin/sh\nread line\ncat <<'REPLY'\n${initializeReply}\nREPLY\ncat >/dev/null\n`,
    `process.stdin.once('data', () => console.log(${JSON.stringify(initializeReply)}));\nprocess.stdin.resume();\n`);

  const database = new DatabaseService(path.join(tempDir, 'app-data'));
  database.initialize();
  const now = new Date().toISOString();
  database.connection
    .prepare(`insert into harness_installations (id, harness, executable_path, version, status, discovered_at, last_checked_at) values (?, ?, ?, ?, 'available', ?, ?)`)
    .run('harness_codex', 'codex', codexPath, '1.0.0', now, now);
  database.connection
    .prepare(`insert into harness_installations (id, harness, executable_path, version, status, discovered_at, last_checked_at) values (?, ?, ?, ?, 'available', ?, ?)`)
    .run('harness_opencode', 'opencode', path.join(binDir, 'opencode'), '2.0.14', now, now);
  database.connection
    .prepare(`insert into harness_installations (id, harness, executable_path, version, status, discovered_at, last_checked_at) values (?, ?, ?, ?, 'available', ?, ?)`)
    .run('harness_claude', 'claude', claudePath, '2.1.283', now, now);
  const settings = new SettingsService(database);

  let openCodeCalls = 0;
  const service = new HarnessModelCatalogService({
    database,
    settings,
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` },
    openCodeServer: {
      listModels: async () => {
        openCodeCalls += 1;
        return { data: [{ id: 'luna', providerID: 'openai', name: 'Luna', enabled: true, variants: [{ id: 'high' }] }] };
      }
    }
  });

  try {
    const catalog = await service.refresh();
    assert.equal(openCodeCalls, 1, 'opencode discovery uses the shared-server service');
    assert.deepEqual(catalog.providers.claude?.models.map((model) => model.id), ['opus', 'claude-fable-5-1', 'haiku']);
    assert.equal(catalog.providers.claude?.source, 'cli');
    assert.deepEqual(catalog.providers.codex?.models.map((model) => model.id), ['gpt-visible']);
    assert.deepEqual(catalog.providers.codex?.models[0]?.reasoning, ['low', 'high']);
    assert.deepEqual(catalog.providers.opencode?.models.map((model) => model.id), ['openai/luna']);
    assert.equal(catalog.providers.opencode?.source, 'api');
    assert.equal(catalog.providers.codex?.error, null);
    assert.deepEqual(settings.harnessModelCatalog(), catalog, 'catalog is cached in settings');

    // A failing provider keeps the previous models and records the error.
    if (process.platform === 'win32') fs.writeFileSync(path.join(binDir, 'codex.cjs'), 'process.exit(1);\n');
    else {
      fs.writeFileSync(codexPath, '#!/bin/sh\nexit 1\n');
      fs.chmodSync(codexPath, 0o755);
    }
    const stale = await service.refresh();
    assert.deepEqual(stale.providers.codex?.models.map((model) => model.id), ['gpt-visible'], 'previous codex models survive a failed refresh');
    assert.match(stale.providers.codex?.error ?? '', /failed/);
    assert.equal(stale.providers.claude?.error, null, 'claude discovery is unaffected');

    service.start();
    service.dispose();
    console.log('harnessModelCatalogSmoke: ok');
  } finally {
    database.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
