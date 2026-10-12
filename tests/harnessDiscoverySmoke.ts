import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DiscoverHarnessesAction } from '../app/Actions/DiscoverHarnessesAction';
import { harnessProviders } from '../app/Harness/providers';
import { DatabaseService } from '../app/Services/DatabaseService';
import { HarnessDiscoveryService } from '../app/Services/HarnessDiscoveryService';
import type { TerminalService } from '../app/Services/TerminalService';
import { TimelineService } from '../app/Services/TimelineService';
import { WorkbenchRepository } from '../app/Repositories/WorkbenchRepository';
import { createTestMcpRegistry } from './fixtures/McpRegistryFixture';

interface HarnessRow {
  harness: string;
  executable_path: string;
  version: string | null;
  status: string;
  discovered_at: string;
  last_checked_at: string;
}

async function main(): Promise<void> {
  assert.equal(harnessProviders.find((provider) => provider.id === 'opencode')?.parseVersion('opencode v2.0.14'), '2.0.14');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-harness-'));
  const binDir = path.join(tempDir, 'bin');
  fs.mkdirSync(binDir);

  // Fake CLI banners exercise PATH discovery and version parsing.
  const isWindows = process.platform === 'win32';
  if (!isWindows) {
    const fakeClaude = path.join(binDir, 'claude');
    fs.writeFileSync(fakeClaude, '#!/bin/sh\necho "1.2.3 (Claude Code)"\n');
    fs.chmodSync(fakeClaude, 0o755);
    const fakeAmp = path.join(binDir, 'amp');
    fs.writeFileSync(fakeAmp, '#!/bin/sh\necho "0.0.1790164843-gc57770 (released 2026-09-23)"\n');
    fs.chmodSync(fakeAmp, 0o755);
  }

  try {
    const discovery = new HarnessDiscoveryService(harnessProviders, {
      env: { PATH: binDir },
      shell: '/bin/sh',
      versionTimeoutMs: 4000
    });

    const discovered = await discovery.discover();
    const byId = new Map(discovered.map((row) => [row.harness, row]));

    if (!isWindows) {
      const claude = byId.get('claude');
      assert.equal(claude?.status, 'available', 'fake claude on PATH discovered as available');
      assert.equal(claude?.version, '1.2.3', 'claude version parsed from banner');
      assert.ok(claude?.executablePath?.endsWith(path.join('bin', 'claude')), 'claude path points at the fixture');
      assert.ok(discovered.every((row) => (row.harness as string) !== 'amp'), 'Amp is not discovered even when installed');
    }

    assert.equal(byId.get('codex')?.status, 'missing', 'absent codex is missing');
    assert.equal(byId.get('opencode')?.status, 'missing', 'absent opencode is missing');

    const rawpty = byId.get('rawpty');
    assert.equal(rawpty?.status, 'available', 'raw terminal is always available');
    assert.equal(rawpty?.executablePath, '/bin/sh', 'raw terminal reports the configured shell');
    assert.equal(rawpty?.version, null, 'raw terminal has no version');

    // Persistence: the action upserts one row per harness and is idempotent.
    const database = new DatabaseService(tempDir);
    database.initialize();
    const timeline = new TimelineService(database);
    const action = new DiscoverHarnessesAction(database, timeline, discovery);

    await action.execute();
    const firstRun = database.connection
      .prepare(`select * from harness_installations order by harness asc`)
      .all() as HarnessRow[];
    assert.equal(firstRun.length, harnessProviders.length, 'one row per provider');
    const claudeRow = firstRun.find((row) => row.harness === 'claude');
    if (!isWindows) {
      assert.equal(claudeRow?.status, 'available');
      assert.equal(claudeRow?.version, '1.2.3');
    }
    const originalDiscoveredAt = claudeRow?.discovered_at;

    await action.execute();
    const secondRun = database.connection
      .prepare(`select * from harness_installations order by harness asc`)
      .all() as HarnessRow[];
    assert.equal(secondRun.length, harnessProviders.length, 're-discovery does not duplicate rows');
    const claudeAfter = secondRun.find((row) => row.harness === 'claude');
    assert.equal(claudeAfter?.discovered_at, originalDiscoveredAt, 'discovered_at preserved across re-runs');

    database.connection.prepare(`insert into harness_installations
      (id, harness, executable_path, version, status, discovered_at, last_checked_at)
      values (?, ?, ?, ?, ?, ?, ?)`)
      .run('old_amp', 'amp', '/usr/bin/amp', 'old', 'available', '2026-09-01', '2026-09-01');

    // Read layer + registry surface only the supported harnesses.
    const repo = new WorkbenchRepository(database);
    const listed = repo.listHarnesses();
    assert.equal(listed.length, harnessProviders.length, 'repository lists every harness');

    const fakeTerminal = { isAvailable: () => false } as unknown as TerminalService;
    const registry = createTestMcpRegistry({
      tempDir,
      database,
      terminal: fakeTerminal,
      timeline,
      workbench: repo,
      harnessDiscovery: discovery
    });

    const viaList = (await registry.call('harness_list', {})) as { harnesses: Array<{ harness: string }> };
    assert.ok(viaList.harnesses.some((row) => row.harness === 'rawpty'), 'harness.list surfaces rawpty');
    assert.ok(!viaList.harnesses.some((row) => row.harness === 'amp'), 'harness_list hides stale Amp installations');
    await assert.rejects(registry.call('spawn_agent', { agent: 'amp' }), /Invalid enum value/);

    const viaDiscover = (await registry.call('harness_discover', {})) as { harnesses: Array<{ harness: string }> };
    assert.equal(viaDiscover.harnesses.length, harnessProviders.length, 'harness.discover re-runs discovery');

    database.dispose();
    // eslint-disable-next-line no-console
    console.log('harness discovery smoke ok');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
