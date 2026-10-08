import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { harnessPresetSettingsInput, resolveHarnessLaunchSelection, seededHarnessPresetSettings } from '../app/Harness/HarnessPresets';
import type { McpServerSpec } from '../app/Harness/HarnessProvider';
import { harnessProviders } from '../app/Harness/providers';
import { WorkbenchRepository } from '../app/Repositories/WorkbenchRepository';
import { DatabaseService } from '../app/Services/DatabaseService';
import { HarnessModelCatalogService } from '../app/Services/HarnessModelCatalogService';
import { HarnessPresetService } from '../app/Services/HarnessPresetService';
import { HarnessLauncher, type SpawnSink } from '../app/Services/HarnessLauncher';
import { SettingsService } from '../app/Services/SettingsService';
import type { TerminalService } from '../app/Services/TerminalService';
import { TimelineService } from '../app/Services/TimelineService';
import { createTestMcpRegistry } from './fixtures/McpRegistryFixture';

const MCP: McpServerSpec = {
  command: '/opt/electron',
  args: ['/app/dist/mcp/patterm-mcp.js'],
  env: { ELECTRON_RUN_AS_NODE: '1', PATTERM_MCP_SOCKET: '/run/mcp.sock' }
};

function presetsFixture() {
  return harnessPresetSettingsInput.parse({
    presets: [
      { id: 'preset_claude', harness: 'claude', name: 'smartypants', model: 'fable', reasoning: 'high' },
      { id: 'preset_codex', harness: 'codex', name: 'deep', model: 'gpt-5.6-luna', reasoning: 'high', serviceTier: 'priority' },
      { id: 'preset_opencode', harness: 'opencode', name: 'luna', model: 'openai/gpt-5.6-luna', reasoning: 'max' }
    ],
    defaultPresetIdByHarness: { claude: 'preset_claude', codex: 'preset_codex', opencode: 'preset_opencode' }
  });
}

function assertSelectionRules(): void {
  const settings = presetsFixture();

  const defaulted = resolveHarnessLaunchSelection({ settings, harness: 'claude' });
  assert.deepEqual(defaulted, { harness: 'claude', model: 'fable', reasoning: 'high', serviceTier: null, presetId: 'preset_claude', presetName: 'smartypants' });

  const byName = resolveHarnessLaunchSelection({ settings, preset: 'SMARTYPANTS' });
  assert.equal(byName.harness, 'claude', 'preset names resolve case-insensitively and infer the harness');
  assert.equal(byName.model, 'fable');

  const byId = resolveHarnessLaunchSelection({ settings, harness: 'codex', preset: 'preset_codex' });
  assert.equal(byId.model, 'gpt-5.6-luna');
  assert.equal(byId.serviceTier, 'priority', 'a Codex preset supplies its service tier');
  assert.equal(resolveHarnessLaunchSelection({ settings, harness: 'codex', preset: 'deep', serviceTier: 'default' }).serviceTier, 'default', 'an explicit tier overrides the preset');
  assert.equal(resolveHarnessLaunchSelection({ settings, harness: 'codex', preset: 'deep', model: 'gpt-5.5' }).serviceTier, 'priority', 'an explicit model keeps the preset tier');
  assert.throws(() => harnessPresetSettingsInput.parse({ presets: [{ id: 'bad_tier', harness: 'claude', name: 'bad', model: null, serviceTier: 'priority' }] }), /only Codex presets/);

  const explicit = resolveHarnessLaunchSelection({ settings, harness: 'claude', preset: 'smartypants', model: 'opus', reasoning: 'max' });
  assert.equal(explicit.model, 'opus', 'explicit model overrides the preset');
  assert.equal(explicit.reasoning, 'max');

  assert.throws(() => resolveHarnessLaunchSelection({ settings, harness: 'codex', preset: 'missing' }), /Available presets: codex\/deep/);

  const ambiguous = harnessPresetSettingsInput.parse({ presets: [...settings.presets, { id: 'preset_clash', harness: 'codex', name: 'smartypants', model: 'gpt-5.5' }] });
  assert.throws(() => resolveHarnessLaunchSelection({ settings: ambiguous, preset: 'smartypants' }), /multiple harnesses/);
  assert.throws(() => resolveHarnessLaunchSelection({ settings, preset: 'smartypants', harness: 'rawpty' }), /unknown preset/);

  // The seeded defaults pass no model, so each CLI keeps its own configuration.
  const seeded = seededHarnessPresetSettings();
  assert.deepEqual(resolveHarnessLaunchSelection({ settings: seeded, harness: 'codex' }), {
    harness: 'codex', model: null, reasoning: null, serviceTier: null, presetId: 'preset_default_codex', presetName: 'Default'
  });
  assert.throws(() => harnessPresetSettingsInput.parse({ presets: [{ id: 'bad', harness: 'claude', name: 'bad', model: null, reasoning: 'high' }] }), /reasoning requires a model/);
  assert.deepEqual(resolveHarnessLaunchSelection({ settings: seeded, harness: 'amp' }), {
    harness: 'amp', model: null, reasoning: null, serviceTier: null, presetId: 'preset_default_amp', presetName: 'Default'
  });
  assert.throws(() => harnessPresetSettingsInput.parse({ presets: [{ id: 'bad_amp', harness: 'amp', name: 'bad', model: 'gpt-5', reasoning: null }] }), /built-in mode/);
}

function assertPresetService(database: DatabaseService): void {
  const service = new HarnessPresetService(new SettingsService(database));
  const seeded = service.list();
  assert.deepEqual(seeded.presets.map((preset) => `${preset.harness}/${preset.name}`), ['claude/Default', 'codex/Default', 'opencode/Default', 'amp/Default']);
  assert.ok(seeded.presets.every((preset) => preset.model === null && preset.reasoning === null), 'seeded defaults keep the harness configuration');
  assert.equal(seeded.defaultPresetIdByHarness.claude, 'preset_default_claude');
  assert.equal(seeded.defaultPresetIdByHarness.amp, 'preset_default_amp');
  assert.equal(service.create({ harness: 'amp', name: 'Careful', model: 'high' }).presets.find((preset) => preset.harness === 'amp' && preset.name === 'Careful')?.model, 'high');

  const created = service.create({ harness: 'claude', name: 'smartypants', model: 'fable', reasoning: 'high' });
  assert.equal(created.defaultPresetIdByHarness.claude, 'preset_default_claude', 'creating a preset leaves the seeded default alone');

  const second = service.create({ harness: 'claude', name: 'fast', model: 'haiku', reasoning: 'low' });
  assert.equal(second.defaultPresetIdByHarness.claude, 'preset_default_claude', 'creating another preset leaves the default alone');

  assert.throws(() => service.create({ harness: 'claude', name: 'SMARTYPANTS', model: 'opus' }), /already exists/);
  assert.throws(() => service.create({ harness: 'claude', name: 'no-model', reasoning: 'high' }), /reasoning requires a model/);

  const updated = service.update({ ref: 'fast', model: 'sonnet', reasoning: null });
  assert.equal(updated.presets.find((preset) => preset.name === 'fast')?.model, 'sonnet');
  assert.equal(updated.presets.find((preset) => preset.name === 'fast')?.reasoning, null);

  const switched = service.update({ ref: 'fast', default: true });
  assert.equal(switched.defaultPresetIdByHarness.claude, switched.presets.find((preset) => preset.name === 'fast')?.id);

  const removed = service.remove({ ref: 'fast' });
  assert.equal(removed.defaultPresetIdByHarness.claude, 'preset_default_claude', 'deleting the default promotes the next claude preset');

  assert.throws(() => service.update({ ref: 'ghost', model: 'x' }), /unknown preset 'ghost'/);

  // Clearing the model drops the reasoning and keeps the CLI default.
  const native = service.create({ harness: 'claude', name: 'native', model: 'sonnet', reasoning: 'low' });
  assert.equal(native.presets.find((preset) => preset.name === 'native')?.model, 'sonnet');
  assert.throws(() => service.update({ ref: 'native', model: null, reasoning: 'low' }), /reasoning requires a model/);
  const cleared = service.update({ ref: 'native', model: null });
  assert.equal(cleared.presets.find((preset) => preset.name === 'native')?.model, null);
  assert.equal(cleared.presets.find((preset) => preset.name === 'native')?.reasoning, null);
  service.remove({ ref: 'native' });

  const reloaded = new HarnessPresetService(new SettingsService(database)).list();
  assert.deepEqual(reloaded.presets.filter((preset) => preset.harness === 'claude').map((preset) => preset.name), ['Default', 'smartypants'], 'presets persist');

  const described = new HarnessPresetService(new SettingsService(database)).describe();
  assert.equal(described.presets.find((preset) => preset.harness === 'claude' && preset.name === 'Default')?.default, true, 'describe marks the seeded default');
  assert.equal(described.presets.find((preset) => preset.name === 'smartypants')?.harness, 'claude');
  service.remove({ ref: 'preset_default_amp' });
  service.remove({ ref: 'Careful', harness: 'amp' });
  assert.equal(new HarnessPresetService(new SettingsService(database)).list().presets.some((preset) => preset.harness === 'amp'), false, 'removing Amp presets remains saved');
}

async function main(): Promise<void> {
  assertSelectionRules();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-presets-'));
  const database = new DatabaseService(path.join(tempDir, 'app-data'));
  database.initialize();
  const timeline = new TimelineService(database);
  const now = new Date().toISOString();

  assertPresetService(database);
  const settings = new SettingsService(database);
  const presetService = new HarnessPresetService(settings);
  presetService.create({ harness: 'codex', name: 'deep', model: 'gpt-5.6-luna', reasoning: 'high', serviceTier: 'priority' });
  presetService.update({ ref: 'smartypants', default: true });

  const projectId = 'project_presets';
  const projectPath = path.join(tempDir, 'repo');
  fs.mkdirSync(projectPath, { recursive: true });
  database.connection
    .prepare(`insert into projects (id, name, path, created_at, updated_at) values (?, ?, ?, ?, ?)`)
    .run(projectId, 'Preset Test', projectPath, now, now);
  for (const [harness, executable] of [['claude', '/usr/bin/claude'], ['codex', '/usr/bin/codex'], ['opencode', '/usr/bin/opencode']] as const) {
    database.connection
      .prepare(`insert into harness_installations (id, harness, executable_path, version, status, discovered_at, last_checked_at) values (?, ?, ?, ?, 'available', ?, ?)`)
      .run(`harness_${harness}`, harness, executable, '1.0.0', now, now);
  }

  const shimPath = path.join(tempDir, 'patterm-mcp.js');
  fs.writeFileSync(shimPath, '');
  const runtimeDir = path.join(tempDir, 'runtime');
  const terminalRequests: Array<{ method: string; params: Record<string, unknown> }> = [];
  let nextProcessNumber = 1;
  const terminal: SpawnSink = {
    request: async (method, params) => {
      terminalRequests.push({ method, params: params as Record<string, unknown> });
      if (method === 'terminal.process.spawn') return { process_id: `proc_${nextProcessNumber++}` };
      if (method === 'terminal.process.output') return { status: 'running', lines: ['ready'] };
      return { ok: true };
    }
  };

  let preparedModel: unknown;
  let preparedReasoning: unknown;
  const integratedLaunches: Array<{ harness: string; model: string | null | undefined; reasoning: string | null | undefined; serviceTier?: string | null | undefined }> = [];
  const launcher = new HarnessLauncher({
    openCodeServer: { prepare: async (input) => {
      preparedModel = input.model;
      preparedReasoning = input.reasoning;
      return { resumeId: 'ses_preset', argv: ['/usr/bin/opencode'] };
    } },
    integrated: {
      prepare: async (harness, input) => {
        integratedLaunches.push({ harness, model: input.model, reasoning: input.reasoning, ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}) });
        return { resumeId: `native_${integratedLaunches.length}`, argv: ['/usr/bin/native'] };
      },
      prompt: async () => ({ delivery: 'accepted' }),
      stop: async () => undefined,
      observe: () => undefined,
      cleanupLaunch: async () => undefined
    },
    database,
    timeline,
    terminal,
    workbench: new WorkbenchRepository(database),
    providers: harnessProviders,
    nodePath: MCP.command,
    shimPath,
    socketPath: MCP.env.PATTERM_MCP_SOCKET!,
    runtimeDir,
    presetSettings: settings
  });

  try {
    // Claude applies the default preset to the CLI.
    const claude = await launcher.launch({ harness: 'claude', project_id: projectId });
    const claudeSpawn = lastSpawn(terminalRequests);
    const claudeArgs = claudeSpawn.args as string[];
    assert.deepEqual(claudeArgs.slice(claudeArgs.indexOf('--model'), claudeArgs.indexOf('--model') + 2), ['--model', 'fable']);
    assert.deepEqual(claudeArgs.slice(claudeArgs.indexOf('--effort'), claudeArgs.indexOf('--effort') + 2), ['--effort', 'high']);
    assert.equal(sessionModel(database, claude.session_id).model, 'fable');
    assert.equal(sessionModel(database, claude.session_id).reasoning, 'high');

    // Codex maps a preset to inline TOML overrides.
    // Codex still has the seeded no-override default, so a plain launch leaves
    // the model untouched; an explicit preset pins it.
    const codexDefault = await launcher.launch({ harness: 'codex', project_id: projectId });
    const codexDefaultArgs = lastSpawn(terminalRequests).args as string[];
    assert.ok(!codexDefaultArgs.some((arg) => arg.startsWith('model=')), `seeded default keeps the harness model: ${codexDefaultArgs.join(' ')}`);
    assert.equal(sessionModel(database, codexDefault.session_id).model, null);

    const codex = await launcher.launch({ harness: 'codex', project_id: projectId, preset: 'deep' });
    const codexArgs = lastSpawn(terminalRequests).args as string[];
    assert.ok(codexArgs.includes('model="gpt-5.6-luna"'), `codex model override present: ${codexArgs.join(' ')}`);
    assert.ok(codexArgs.includes('model_reasoning_effort="high"'), `codex reasoning override present: ${codexArgs.join(' ')}`);
    assert.equal(sessionModel(database, codex.session_id).reasoning, 'high');
    assert.ok(codexArgs.includes('service_tier="priority"'), `codex service tier override present: ${codexArgs.join(' ')}`);
    assert.equal(sessionServiceTier(database, codex.session_id), 'priority');
    await assert.rejects(() => launcher.launch({ harness: 'claude', project_id: projectId, service_tier: 'priority' }), /does not support service tier/);

    await assert.rejects(() => launcher.launch({ preset: 'missing-preset', project_id: projectId }), /unknown preset/);

    // Register the OpenCode preset, then launch by name: the preset infers the harness.
    new HarnessPresetService(settings).create({ harness: 'opencode', name: 'luna', model: 'openai/gpt-5.6-luna', reasoning: 'max' });
    const openCode = await launcher.launch({ preset: 'LUNA', project_id: projectId });
    assert.equal(openCode.harness, 'opencode');
    assert.equal(preparedModel, 'openai/gpt-5.6-luna');
    assert.equal(preparedReasoning, 'max');
    const openCodeSpawn = lastSpawn(terminalRequests);
    assert.deepEqual(openCodeSpawn.args, ['--session', 'ses_preset']);
    const stored = sessionModel(database, openCode.session_id);
    assert.equal(stored.model, 'openai/gpt-5.6-luna');
    assert.equal(stored.reasoning, 'max');

    // Preset selection must reach the native Integrated provider, not just the
    // TUI argv or the session record.
    const integrated = await launcher.launch({ harness: 'codex', preset: 'deep', project_id: projectId, interface_mode: 'integrated' });
    assert.equal(integrated.pty_process_id, null);
    assert.deepEqual(integratedLaunches.at(-1), { harness: 'codex', model: 'gpt-5.6-luna', reasoning: 'high', serviceTier: 'priority' });
    assert.equal(sessionServiceTier(database, integrated.session_id), 'priority');
    assert.deepEqual(sessionModel(database, integrated.session_id), { model: 'gpt-5.6-luna', reasoning: 'high' });

    const integratedOpenCode = await launcher.launch({ preset: 'LUNA', project_id: projectId, interface_mode: 'integrated' });
    assert.deepEqual(integratedLaunches.at(-1), { harness: 'opencode', model: 'openai/gpt-5.6-luna', reasoning: 'max' });
    assert.deepEqual(sessionModel(database, integratedOpenCode.session_id), { model: 'openai/gpt-5.6-luna', reasoning: 'max' });

    await assert.rejects(() => launcher.launch({ preset: 'ghost', project_id: projectId }), /unknown preset/);

    // The MCP surface exposes preset names, default flags, and CRUD.
    const registry = createTestMcpRegistry({
      tempDir,
      database,
      timeline,
      terminal: terminal as unknown as TerminalService,
      workbench: new WorkbenchRepository(database),
      harnessLauncher: launcher,
      harnessPresets: new HarnessPresetService(settings),
      modelCatalog: new HarnessModelCatalogService({ database, settings, env: process.env, openCodeServer: { listModels: async () => ({ data: [] }) } })
    });
    interface PresetList { presets: Array<{ id: string; harness: string; name: string; default: boolean }> }
    const listed = await registry.call('patterm.harness.presets', {}) as PresetList;
    assert.ok(listed.presets.some((preset) => preset.name === 'smartypants' && preset.harness === 'claude' && preset.default), 'MCP lists preset names with default flags');
    await registry.call('patterm.harness.preset.create', { harness: 'codex', name: 'quick', model: 'gpt-5.5', reasoning: 'low' });
    const switched = await registry.call('patterm.harness.preset.update', { ref: 'quick', default: true }) as PresetList;
    assert.equal(switched.presets.find((preset) => preset.name === 'quick')?.default, true, 'MCP preset updates can set the harness default');
    const afterDelete = await registry.call('patterm.harness.preset.delete', { ref: 'quick' }) as PresetList;
    assert.ok(!afterDelete.presets.some((preset) => preset.name === 'quick'), 'MCP preset deletion removes the preset');

    console.log('harnessPresetSmoke: ok');
  } finally {
    database.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function sessionServiceTier(database: DatabaseService, sessionId: string): string | null {
  return (database.connection.prepare(`select service_tier from sessions where id = ?`).get(sessionId) as { service_tier: string | null }).service_tier;
}

function sessionModel(database: DatabaseService, sessionId: string): { model: string | null; reasoning: string | null } {
  return database.connection.prepare(`select model, reasoning from sessions where id = ?`).get(sessionId) as { model: string | null; reasoning: string | null };
}

function lastSpawn(requests: Array<{ method: string; params: Record<string, unknown> }>): Record<string, unknown> {
  const spawns = requests.filter((request) => request.method === 'terminal.process.spawn');
  return spawns[spawns.length - 1]?.params ?? {};
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
