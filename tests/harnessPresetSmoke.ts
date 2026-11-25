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
import { HarnessLauncher } from '../app/Services/HarnessLauncher';
import type { SpawnSink } from '../app/Services/ProcessLauncher';
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

  // The seeded defaults pass no model, so each CLI keeps its own configuration.
  const seeded = seededHarnessPresetSettings();
  assert.deepEqual(resolveHarnessLaunchSelection({ settings: seeded, harness: 'codex' }), {
    harness: 'codex', model: null, reasoning: null, serviceTier: null, presetId: 'preset_default_codex', presetName: 'Default'
  });
  assert.throws(() => harnessPresetSettingsInput.parse({ presets: [{ id: 'bad', harness: 'claude', name: 'bad', model: null, reasoning: 'high' }] }), /reasoning requires a model/);
}

function assertPresetService(database: DatabaseService): void {
  const service = new HarnessPresetService(new SettingsService(database));
  const seeded = service.list();
  assert.deepEqual(seeded.presets.map((preset) => `${preset.harness}/${preset.name}`), ['claude/Default', 'codex/Default', 'opencode/Default', 'agy/Default']);
  assert.ok(seeded.presets.every((preset) => preset.model === null && preset.reasoning === null), 'seeded defaults keep the harness configuration');
  assert.equal(seeded.defaultPresetIdByHarness.claude, 'preset_default_claude');

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

  const savedWithRemovedHarness = {
    ...reloaded,
    presets: [...reloaded.presets, { id: 'removed', harness: 'amp', name: 'Old default', model: null, reasoning: null, serviceTier: null }],
    defaultPresetIdByHarness: { ...reloaded.defaultPresetIdByHarness, amp: 'removed' }
  };
  database.connection.prepare('update settings set value = ? where key = ?').run(JSON.stringify(savedWithRemovedHarness), 'harness.presets.v1');
  assert.deepEqual(new SettingsService(database).harnessPresets(), reloaded, 'removed harness settings leave retained presets and defaults intact');
  assert.throws(() => service.create({ harness: 'amp', name: 'Removed' } as never), /Invalid enum value/);

  const described = new HarnessPresetService(new SettingsService(database)).describe();
  assert.equal(described.presets.find((preset) => preset.harness === 'claude' && preset.name === 'Default')?.default, true, 'describe marks the seeded default');
  assert.equal(described.presets.find((preset) => preset.name === 'smartypants')?.harness, 'claude');
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
  // OpenCode launches link the user's OpenCode config; keep the real one out.
  const previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = path.join(tempDir, 'opencode-config');
  fs.mkdirSync(process.env.OPENCODE_CONFIG_DIR);
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

  const integratedLaunches: Array<{ harness: string; model: string | null | undefined; reasoning: string | null | undefined; serviceTier?: string | null | undefined }> = [];
  const launcher = new HarnessLauncher({
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
    workbench: new WorkbenchRepository(database),
    providers: harnessProviders,
    nodePath: MCP.command,
    shimPath,
    socketPath: MCP.env.PATTERM_MCP_SOCKET!,
    runtimeDir,
    presetSettings: settings
  });

  try {
    // Claude applies the default preset to the Integrated launch.
    const claude = await launcher.launch({ harness: 'claude', project_id: projectId });
    assert.deepEqual(integratedLaunches.at(-1), { harness: 'claude', model: 'fable', reasoning: 'high' });
    assert.equal(sessionModel(database, claude.session_id).model, 'fable');
    assert.equal(sessionModel(database, claude.session_id).reasoning, 'high');

    // Codex still has the seeded no-override default, so a plain launch leaves
    // the model untouched; an explicit preset pins it along with service tier.
    const codexDefault = await launcher.launch({ harness: 'codex', project_id: projectId });
    assert.deepEqual(integratedLaunches.at(-1), { harness: 'codex', model: null, reasoning: null });
    assert.equal(sessionModel(database, codexDefault.session_id).model, null);

    const codex = await launcher.launch({ harness: 'codex', project_id: projectId, preset: 'deep' });
    assert.deepEqual(integratedLaunches.at(-1), { harness: 'codex', model: 'gpt-5.6-luna', reasoning: 'high', serviceTier: 'priority' });
    assert.equal(sessionModel(database, codex.session_id).reasoning, 'high');
    assert.equal(sessionServiceTier(database, codex.session_id), 'priority');
    await assert.rejects(() => launcher.launch({ harness: 'claude', project_id: projectId, service_tier: 'priority' }), /does not support service tier/);

    await assert.rejects(() => launcher.launch({ preset: 'missing-preset', project_id: projectId }), /unknown preset/);

    // Register the OpenCode preset, then launch by name: the preset infers the harness.
    new HarnessPresetService(settings).create({ harness: 'opencode', name: 'luna', model: 'openai/gpt-5.6-luna', reasoning: 'max' });
    const openCode = await launcher.launch({ preset: 'LUNA', project_id: projectId });
    assert.equal(openCode.harness, 'opencode');
    assert.deepEqual(integratedLaunches.at(-1), { harness: 'opencode', model: 'openai/gpt-5.6-luna', reasoning: 'max' });
    const stored = sessionModel(database, openCode.session_id);
    assert.equal(stored.model, 'openai/gpt-5.6-luna');
    assert.equal(stored.reasoning, 'max');

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
      modelCatalog: new HarnessModelCatalogService({ database, settings, env: process.env, openCodeServer: { listModels: async () => ({ data: [] }), listProviders: async () => ({ data: [] }) } })
    });
    interface PresetList { presets: Array<{ id: string; harness: string; name: string; default: boolean; look?: unknown }> }
    const listed = await registry.call('harness_presets', {}) as PresetList;
    assert.ok(listed.presets.some((preset) => preset.name === 'smartypants' && preset.harness === 'claude' && preset.default), 'MCP lists preset names with default flags');

    // Settings reads preserve profile faces while agent-facing harness_presets strips them.
    const existing = await registry.call('settings_harness_presets_get', {}) as { presets: Array<{ id: string; harness: string; name: string; model: string | null; reasoning: string | null; serviceTier?: string | null; look?: { hat?: string } | null }>; defaultPresetIdByHarness: Record<string, string | null> };
    const look = { color: 'pink', shape: 'egg', finish: 'soft', marking: 'none', eyes: 'dots', mouth: 'smile', cheeks: false, hat: 'crown', accent: 'pink', idle: 'still' };
    const updated = await registry.call('settings_harness_presets_update', {
      presets: existing.presets.map((preset) => preset.name === 'smartypants' ? { ...preset, look } : preset),
      defaultPresetIdByHarness: existing.defaultPresetIdByHarness
    }) as { presets: Array<{ name: string; look?: { hat?: string } | null }> };
    assert.equal(updated.presets.find((preset) => preset.name === 'smartypants')?.look?.hat, 'crown');
    const reloaded = await registry.call('settings_harness_presets_get', {}) as { presets: Array<{ name: string; look?: { hat?: string } | null }> };
    assert.equal(reloaded.presets.find((preset) => preset.name === 'smartypants')?.look?.hat, 'crown', 'settings_harness_presets_get preserves profile faces');
    const agentListed = await registry.call('harness_presets', {}) as PresetList;
    assert.equal(agentListed.presets.find((preset) => preset.name === 'smartypants')?.look, undefined, 'agent-facing harness_presets keeps faces out of agent context');

    await registry.call('harness_preset_create', { harness: 'codex', name: 'quick', model: 'gpt-5.5', reasoning: 'low' });
    const switched = await registry.call('harness_preset_update', { ref: 'quick', default: true }) as PresetList;
    assert.equal(switched.presets.find((preset) => preset.name === 'quick')?.default, true, 'MCP preset updates can set the harness default');
    const afterDelete = await registry.call('harness_preset_delete', { ref: 'quick' }) as PresetList;
    assert.ok(!afterDelete.presets.some((preset) => preset.name === 'quick'), 'MCP preset deletion removes the preset');

    console.log('harnessPresetSmoke: ok');
  } finally {
    if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
