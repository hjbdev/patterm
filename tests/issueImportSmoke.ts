import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../app/Services/DatabaseService';
import { TimelineService } from '../app/Services/TimelineService';
import { WorkbenchRepository } from '../app/Repositories/WorkbenchRepository';
import type { TerminalService } from '../app/Services/TerminalService';
import { createTestMcpRegistry } from './fixtures/McpRegistryFixture';

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-removed-tools-'));
  const database = new DatabaseService(directory);
  try {
    database.initialize();
    const registry = createTestMcpRegistry({ tempDir: directory, database, timeline: new TimelineService(database), workbench: new WorkbenchRepository(database), terminal: {} as TerminalService });
    for (const name of ['patterm.task.create', 'patterm.task.get', 'patterm.task.plan.update', 'patterm.issue.import', 'patterm.issue.link']) {
      await assert.rejects(registry.call(name, {}), /unknown MCP tool/i);
    }
    assert.ok(!registry.publicTools().some(({ name }) => name.startsWith('patterm.task.') || name.startsWith('patterm.issue.')));
    console.log('removed task and issue tools smoke ok');
  } finally {
    database.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
