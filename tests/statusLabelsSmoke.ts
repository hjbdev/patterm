import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RegisterProcessAction, registerProcessInput } from '../app/Actions/RegisterProcessAction';
import { RegisterSessionAction, registerSessionInput } from '../app/Actions/RegisterSessionAction';
import { StatusLabelActions } from '../app/Actions/StatusLabelActions';
import { BROWSER_TOOLS } from '../app/Http/BrowserTools';
import { WorkbenchRepository } from '../app/Repositories/WorkbenchRepository';
import { AgentContextService } from '../app/Services/AgentContextService';
import { DatabaseService } from '../app/Services/DatabaseService';
import { SettingsService } from '../app/Services/SettingsService';
import { DEFAULT_STATUS_LABELS, statusLabelSettingsInput } from '../app/Services/StatusLabels';
import type { TerminalService } from '../app/Services/TerminalService';
import { TimelineService } from '../app/Services/TimelineService';
import { createTestMcpRegistry } from './fixtures/McpRegistryFixture';
import { removeTree } from './fixtures/TempTree';

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-status-labels-'));
  const database = new DatabaseService(dir);
  try {
    database.initialize();
    const db = database.connection;
    const now = new Date().toISOString();
    db.prepare('insert into projects(id,name,path,created_at,updated_at) values(?,?,?,?,?)').run('p', 'Project', dir, now, now);
    const timeline = new TimelineService(database);
    const settings = new SettingsService(database);
    const agent = (identity: string) => {
      const { process_id } = new RegisterProcessAction(database, timeline).execute(registerProcessInput.parse({ project_id: 'p', name: identity, kind: 'agent' }));
      new RegisterSessionAction(database, timeline).execute(registerSessionInput.parse({ project_id: 'p', process_id, harness: 'claude', mcp_identity: identity }));
      return process_id;
    };
    let changes = 0;
    const labels = new StatusLabelActions(database, settings, timeline, () => { changes += 1; });
    const registry = createTestMcpRegistry({ tempDir: dir, database, timeline,
      terminal: { request: async () => ({}) } as unknown as TerminalService,
      workbench: new WorkbenchRepository(database), statusLabels: labels });
    const pinned = (processId: string) => new WorkbenchRepository(database).snapshot().projects[0]!.projectSessions.find((session) => session.processId === processId)!.statusLabel ?? null;
    const listed = async (identity: string, processId: string) => ((await registry.callPublic('list_processes', {}, { identity })) as { processes: Array<{ process_id: string; status_label?: string }> }).processes.find((row) => row.process_id === processId)?.status_label;

    // Fresh installs start with the default labels, and the list rejects
    // duplicate names whatever their case.
    assert.deepEqual(settings.statusLabels(), DEFAULT_STATUS_LABELS);
    assert.throws(() => statusLabelSettingsInput.parse({ labels: [
      { id: 'a', name: 'Blocked', color: 'red' },
      { id: 'b', name: 'blocked', color: 'blue' }
    ] }), /Duplicate status label/);
    assert.throws(() => statusLabelSettingsInput.parse({ labels: [{ id: 'a', name: 'Odd', color: 'magenta' }] }));

    const alice = agent('alice');
    const bob = agent('bob');

    // Agents see the labels and pin one on themselves by name, in any case.
    const listedLabels = await registry.callPublic('status_label_list', {}, { identity: 'alice' }) as { labels: Array<{ id: string; description?: string }> };
    assert.equal(listedLabels.labels[0]?.id, 'waiting-for-review');
    assert.ok(listedLabels.labels[0]?.description);
    assert.deepEqual(await registry.callPublic('status_set', { label: 'waiting FOR review' }, { identity: 'alice' }), { label: { id: 'waiting-for-review', name: 'Waiting for review', color: 'amber' } });
    assert.equal(pinned(alice)?.name, 'Waiting for review');
    assert.equal(pinned(alice)?.setBy, 'agent');
    assert.equal(await listed('bob', alice), 'Waiting for review');
    assert.equal(await listed('bob', bob), undefined);
    assert.ok(changes > 0);

    // Unknown labels fail and name the configured ones; only agents can call it.
    await assert.rejects(registry.callPublic('status_set', { label: 'Daydreaming' }, { identity: 'alice' }), /Unknown status label "Daydreaming"\. Configured labels: Waiting for review, Waiting on CI/);
    await assert.rejects(registry.callPublic('status_set', { label: 'Blocked' }, {}), /authenticated agent session/);

    // The user's message clears the agent's own label.
    labels.userInput(alice);
    assert.equal(pinned(alice), null);

    // A label the user pins stays when they talk to the agent, and the
    // browser tools that set labels are allowed from the UI.
    assert.ok(BROWSER_TOOLS.has('process_status_set') && BROWSER_TOOLS.has('settings_status_labels_update'));
    await registry.call('process_status_set', { process_id: bob, label: 'blocked' }, {});
    assert.equal(pinned(bob)?.setBy, 'user');
    labels.userInput(bob);
    assert.equal(pinned(bob)?.name, 'Blocked');

    // Renaming a label renames it on the agent; deleting it clears it.
    const renamed = settings.statusLabels().labels.map((label) => label.id === 'blocked' ? { ...label, name: 'Stuck', color: 'pink' as const } : label);
    await registry.call('settings_status_labels_update', { labels: renamed }, {});
    assert.deepEqual([pinned(bob)?.name, pinned(bob)?.color], ['Stuck', 'pink']);
    await registry.call('settings_status_labels_update', { labels: renamed.filter((label) => label.id !== 'blocked') }, {});
    assert.equal(pinned(bob), null);
    assert.equal(await listed('alice', bob), undefined);
    // A new label that takes the deleted one's id doesn't revive the pin.
    await registry.call('settings_status_labels_update', { labels: [...renamed.filter((label) => label.id !== 'blocked'), { id: 'blocked', name: 'Blocked!', color: 'blue' }] }, {});
    assert.equal(pinned(bob), null);
    assert.equal((db.prepare('select status_label_id from processes where id = ?').get(bob) as { status_label_id: string | null }).status_label_id, null);

    // An agent creates a label only when asked; a second with the same name
    // returns the first. The new label is marked as an agent's.
    const created = await registry.callPublic('status_label_create', { name: 'Deploying', color: 'teal', description: 'A deploy is rolling out.' }, { identity: 'alice' }) as { label: { id: string }; created: boolean };
    assert.deepEqual(created, { label: { id: 'deploying', name: 'Deploying', color: 'teal', description: 'A deploy is rolling out.' }, created: true });
    assert.equal((await registry.callPublic('status_label_create', { name: 'deploying', color: 'red' }, { identity: 'alice' }) as { created: boolean }).created, false);
    assert.equal(settings.statusLabels().labels.find((label) => label.id === 'deploying')?.createdBy, 'agent');
    await registry.callPublic('status_set', { label: 'Deploying' }, { identity: 'alice' });
    assert.equal(pinned(alice)?.color, 'teal');

    // Clearing with null, and an exited agent shows no label.
    await registry.callPublic('status_set', { label: null }, { identity: 'alice' });
    assert.equal(pinned(alice), null);
    await registry.callPublic('status_set', { label: 'Deploying' }, { identity: 'alice' });
    db.prepare(`update processes set status = 'exited' where id = ?`).run(alice);
    assert.equal(pinned(alice), null);
    assert.throws(() => labels.set(alice, 'Deploying', 'user'), /running agent/);

    // The agent prompt says when to use labels and when to create them.
    const context = new AgentContextService().build('p');
    assert.match(context, /status_set/);
    assert.match(context, /status_label_create only when the user explicitly asks/);
  } finally {
    database.dispose();
    removeTree(dir);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
