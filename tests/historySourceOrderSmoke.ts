import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../app/Services/DatabaseService';
import { AgentHistorySourceService } from '../app/Services/AgentHistory/AgentHistorySourceService';
import { ProviderHistoryDiscoveryService } from '../app/Services/AgentHistory/ProviderHistoryDiscoveryService';
import type { HistorySourceCandidate } from '../app/Services/AgentHistory/AgentHistoryTypes';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-history-source-order-'));
const database = new DatabaseService(directory);
try {
  database.initialize();
  const defaults: HistorySourceCandidate[] = [
    { provider: 'claude', sourceKind: 'manual_directory', path: path.join(directory, 'claude'), exists: false },
    { provider: 'codex', sourceKind: 'manual_directory', path: path.join(directory, 'codex-z'), exists: false },
    { provider: 'opencode', sourceKind: 'manual_directory', path: path.join(directory, 'opencode'), exists: false }
  ];
  class Discovery extends ProviderHistoryDiscoveryService {
    override defaultSources(): HistorySourceCandidate[] { return defaults; }
  }
  const sources = new AgentHistorySourceService(database, new Discovery());
  const order = () => sources.sources().sources.map((source) => source.provider);
  assert.deepEqual(order(), ['claude', 'codex', 'opencode']);
  sources.configure({ provider: 'codex', path: defaults[1]!.path, enabled: true, watch_enabled: true });
  assert.deepEqual(order(), ['claude', 'codex', 'opencode'], 'enabling a default source must not move its row');
  sources.configure({ provider: 'opencode', path: defaults[2]!.path, enabled: true, watch_enabled: true });
  assert.deepEqual(order(), ['claude', 'codex', 'opencode'], 'enabling another source must keep provider order');
  sources.configure({ provider: 'codex', path: defaults[1]!.path, enabled: false, watch_enabled: false });
  assert.deepEqual(order(), ['claude', 'codex', 'opencode'], 'disabling a source must keep provider order');
  const earlierCodexPath = path.join(directory, 'codex-a');
  sources.configure({ provider: 'codex', path: earlierCodexPath, enabled: true, watch_enabled: true });
  assert.deepEqual(sources.sources().sources.map((source) => source.path), [
    defaults[0]!.path, earlierCodexPath, defaults[1]!.path, defaults[2]!.path
  ], 'sources within a provider remain alphabetical by path');
  console.log('history source order smoke passed');
} finally {
  database.dispose();
  fs.rmSync(directory, { recursive: true, force: true });
}
