import assert from 'node:assert/strict';
import type { ProjectWorkbenchDto, SessionDto, WorkbenchSnapshotDto } from '../app/Repositories/WorkbenchRepository';
import { McpToolRegistry } from '../app/MCP/ToolRegistry';
import { diffWorkbench, type WorkbenchChanges as ServerChanges } from '../app/Services/WorkbenchPatch';
import { WorkbenchSyncService } from '../app/Services/WorkbenchSyncService';
import { applyWorkbenchChanges, changesLifecycle, type WorkbenchChanges as ClientChanges, type WorkbenchSnapshot } from '../resources/js/lib/workbenchPatch';

const clone = <T>(value: T): T => structuredClone(value);
// Patches reach clients as JSON.
const wire = (changes: ServerChanges): ClientChanges => JSON.parse(JSON.stringify(changes)) as ClientChanges;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

let nextId = 0;
const id = (prefix: string) => `${prefix}_${++nextId}`;

function session(overrides: Partial<SessionDto> = {}): SessionDto {
  return {
    id: id('session'),
    parentId: null,
    processId: id('process'),
    ptyProcessId: null,
    worktreeId: null,
    harness: 'claude',
    interfaceMode: 'integrated',
    sessionRole: 'orchestrator',
    resumeStatus: 'found',
    activity: 'idle',
    lastTitle: 'Investigate flaky tab strip scroll restore after a reconnect',
    displayName: null,
    model: 'claude-opus',
    reasoning: 'high',
    startedAt: new Date(Date.UTC(2026, 8, 1, 0, nextId)).toISOString(),
    exitedAt: null,
    summary: { text: 'Patched the renderer so the tab strip keeps its scroll position across switches and reconnects.', generatedAt: '2026-09-01T00:00:00.000Z', provider: 'claude', model: 'claude-haiku' },
    ...overrides
  };
}

function project(sessions: number): ProjectWorkbenchDto {
  const projectId = id('project');
  return {
    project: { id: projectId, name: `Project ${projectId}`, path: `/srv/${projectId}`, logo: null },
    projectSessions: Array.from({ length: sessions }, () => session()),
    processes: Array.from({ length: 3 }, (_, index) => ({
      id: id('process'), parentProcessId: null, kind: 'command', name: `dev server ${index}`, command: 'pnpm run dev', cwd: '/srv',
      argv: ['/bin/bash', '-lc', 'pnpm run dev'], status: 'running', activity: 'idle', ptyProcessId: id('proc'), worktreeId: null,
      autoRestart: false, exitedAt: null, exitCode: null, summary: null
    })),
    worktrees: [{ id: id('worktree'), repoPath: '/srv/repo', worktreePath: '/srv/repo/.worktrees/a', branch: 'patterm/a' }],
    timers: Array.from({ length: 3 }, (_, index) => ({
      id: id('timer'), kind: 'delay', status: 'pending', ownerProcessId: null, watched: [], body: 'Wake up', label: `timer ${index}`,
      firesAtUnixMs: 1_000 + index, pausedRemainingMs: null, createdAtUnixMs: index
    }))
  } as ProjectWorkbenchDto;
}

function workbench(projects: number, sessions: number): WorkbenchSnapshotDto {
  return {
    projects: Array.from({ length: projects }, () => project(sessions)),
    harnesses: [{ id: 'harness_claude', harness: 'claude', executablePath: '/usr/bin/claude', version: '2.1', status: 'available', discoveredAt: '2026-09-01', lastCheckedAt: '2026-09-01' }],
    sidebarState: { projects: [], sections: [], knownProjects: [], knownSections: [] }
  };
}

const pick = <T>(random: () => number, items: T[]): T | undefined => items[Math.floor(random() * items.length)];

// One random edit of the kind the server makes, including some it rarely
// makes, such as reordering.
function mutate(snapshot: WorkbenchSnapshotDto, random: () => number): string {
  const target = pick(random, snapshot.projects);
  const choice = Math.floor(random() * 12);
  if (!target && choice < 9) {
    snapshot.projects.push(project(2));
    return 'add first project';
  }
  switch (choice) {
    case 0: { const item = pick(random, target!.projectSessions); if (item) item.activity = item.activity === 'idle' ? 'working' : 'idle'; return 'activity'; }
    case 1: target!.projectSessions.push(session()); return 'add session';
    case 2: { const item = pick(random, target!.projectSessions); if (item) item.exitedAt = '2026-09-02T00:00:00.000Z'; return 'exit session'; }
    case 3: { const index = Math.floor(random() * target!.processes.length); target!.processes.splice(index, 1); return 'remove process'; }
    case 4: {
      const index = Math.floor(random() * (target!.processes.length + 1));
      target!.processes.splice(index, 0, { ...clone(target!.processes[0] ?? project(0).processes[0]!), id: id('process'), name: 'inserted' });
      return 'insert process';
    }
    case 5: target!.timers.reverse(); return 'reorder timers';
    case 6: target!.project.name = `Renamed ${random()}`; return 'rename project';
    case 7: snapshot.sidebarState = { ...snapshot.sidebarState, sections: [`section ${random()}`] }; return 'sidebar';
    case 8: snapshot.harnesses[0]!.status = snapshot.harnesses[0]!.status === 'available' ? 'missing' : 'available'; return 'harness';
    case 9: snapshot.projects.splice(Math.floor(random() * (snapshot.projects.length + 1)), 0, project(2)); return 'insert project';
    case 10: snapshot.projects.splice(Math.floor(random() * snapshot.projects.length), 1); return 'remove project';
    default: return 'no change';
  }
}

function roundTrips(): void {
  const random = seeded(42);
  const truth = workbench(3, 6);
  // `built` stands for the server's last published snapshot; `client` for
  // what a renderer holds after applying every patch.
  let built = clone(truth);
  let client: WorkbenchSnapshot = clone(truth) as WorkbenchSnapshot;
  for (let step = 0; step < 400; step++) {
    const edits = Array.from({ length: 1 + Math.floor(random() * 3) }, () => mutate(truth, random));
    const rebuilt = clone(truth);
    const changes = diffWorkbench(built, rebuilt);
    if (!changes) {
      assert.deepEqual(built, truth, `step ${step} (${edits.join(', ')}): no patch means nothing changed`);
      continue;
    }
    const before = client;
    client = applyWorkbenchChanges(client, wire(changes));
    assert.deepEqual(client, truth, `step ${step} (${edits.join(', ')}): the patched client matches the server`);
    for (const previous of before.projects) {
      if (!changes.projects?.change?.some((patch) => patch.id === previous.project.id) && !changes.projects?.remove?.includes(previous.project.id)) {
        assert.equal(client.projects.find((item) => item.project.id === previous.project.id), previous, 'untouched projects keep their identity');
      }
    }
    built = rebuilt;
  }
  assert.equal(diffWorkbench(built, clone(truth)), undefined, 'a rebuild with no change produces no patch');
}

function patchSize(): void {
  const previous = workbench(1, 500);
  const next = clone(previous);
  next.projects[0]!.projectSessions[250]!.activity = 'working';
  const full = JSON.stringify(next).length;
  const changes = diffWorkbench(previous, clone(next))!;
  const patch = JSON.stringify(changes).length;
  assert.ok(full > 300_000, `fixture is the size of a long-lived workbench (${full} bytes)`);
  assert.ok(patch < 2_000, `one activity change is a small patch (${patch} bytes)`);
  const client = clone(previous) as WorkbenchSnapshot;
  const updated = applyWorkbenchChanges(client, wire(changes));
  assert.equal(updated.projects[0]!.projectSessions[0], client.projects[0]!.projectSessions[0], 'untouched sessions keep their identity');
  assert.notEqual(updated.projects[0]!.projectSessions[250], client.projects[0]!.projectSessions[250]);
  assert.equal(updated.harnesses, client.harnesses, 'untouched lists keep their identity');
  console.log(`  one activity change: ${patch} byte patch instead of a ${full} byte snapshot`);
}

function lifecycle(): void {
  const base = workbench(1, 3);
  const check = (edit: (snapshot: WorkbenchSnapshotDto) => void) => {
    const next = clone(base);
    edit(next);
    return changesLifecycle(base as WorkbenchSnapshot, wire(diffWorkbench(clone(base), next)!));
  };
  assert.equal(check((next) => { next.projects[0]!.projectSessions[0]!.activity = 'working'; }), false, 'activity is not a lifecycle change');
  assert.equal(check((next) => { next.projects[0]!.projectSessions[0]!.lastTitle = 'Renamed'; }), false, 'titles are not lifecycle changes');
  assert.equal(check((next) => { next.projects[0]!.projectSessions[0]!.exitedAt = '2026-09-02T00:00:00.000Z'; }), true, 'exits are lifecycle changes');
  assert.equal(check((next) => { next.projects[0]!.projectSessions.push(session()); }), true, 'new sessions are lifecycle changes');
  assert.equal(check((next) => { next.projects[0]!.processes[0]!.status = 'exited'; }), true, 'process status is a lifecycle change');
  assert.equal(check((next) => { next.projects[0]!.processes.pop(); }), true, 'removed processes are lifecycle changes');
  assert.equal(check((next) => { next.projects[0]!.timers.pop(); }), false, 'timers are not lifecycle changes');
}

async function syncService(): Promise<void> {
  let data = workbench(2, 4);
  let builds = 0;
  const sync = new WorkbenchSyncService(() => { builds += 1; return clone(data); }, { delayMs: 5, maxDelayMs: 25, historySize: 3 });
  const patches: Array<{ from: number; to: number }> = [];
  sync.onPatch((patch) => patches.push(patch));
  const change = () => { data = clone(data); data.projects[0]!.projectSessions.push(session()); };
  try {
    const first = sync.read();
    assert.ok('projects' in first && first.version === 0, 'the first read is the whole snapshot at version 0');
    const epoch = first.epoch;

    change();
    sync.invalidate();
    sync.invalidate();
    sync.invalidate();
    await sleep(40);
    assert.deepEqual(patches.map((patch) => [patch.from, patch.to]), [[0, 1]], 'a burst of changes publishes one patch');
    sync.invalidate();
    await sleep(40);
    assert.equal(patches.length, 1, 'a rebuild that changes nothing publishes nothing');

    assert.deepEqual(sync.read({ epoch, version: 1 }), { epoch, version: 1, current: true }, 'a current client gets no data');
    const behind = sync.read({ epoch, version: 0 });
    assert.ok('patches' in behind && behind.patches.map((patch) => patch.to).join() === '1', 'a client one change behind gets that patch');
    assert.ok('projects' in sync.read({ epoch: 'restarted', version: 1 }), 'a client from another server run gets the snapshot');

    change();
    const unannounced = sync.read({ epoch, version: 1 });
    assert.equal(patches.length, 2, 'a change nobody announced still reaches every client on the next read');
    assert.ok('patches' in unannounced && unannounced.patches[0]!.from === 1);

    for (let index = 0; index < 4; index++) { change(); sync.flush(); }
    assert.ok('projects' in sync.read({ epoch, version: 1 }), 'a client older than the kept patches gets the snapshot');

    const counted = builds;
    sync.snapshot();
    assert.equal(builds, counted, 'server-side readers reuse the published snapshot');
    sync.invalidate();
    sync.snapshot();
    assert.equal(builds, counted + 1, 'a pending change is published before a server-side read');

    // A steady stream of changes still publishes within the maximum delay.
    const published = patches.length;
    const stream = setInterval(() => { change(); sync.invalidate(); }, 2);
    await sleep(60);
    clearInterval(stream);
    assert.ok(patches.length > published, 'continuous changes do not postpone publishing indefinitely');
  } finally {
    sync.dispose();
  }
}

function topics(): void {
  const registry = new McpToolRegistry();
  const handler = () => null;
  registry.register({ name: 'patterm.example.write', namespace: 'example', description: 'Write.', inputSchema: {} }, handler);
  registry.register({ name: 'patterm.example.read', namespace: 'example', description: 'Read.', inputSchema: {}, changes: [] }, handler);
  registry.register({ name: 'patterm.example.post', namespace: 'example', description: 'Post.', inputSchema: {}, changes: ['settings'] }, handler);
  registry.register({ name: 'whoami', namespace: 'cli', description: 'Identity.', inputSchema: {} }, handler);
  assert.deepEqual(registry.changedTopics('patterm.example.write'), ['workbench', 'context'], 'undeclared writes refresh workbench and context data');
  assert.deepEqual(registry.changedTopics('example.write'), ['workbench', 'context'], 'public names resolve to the same tool');
  assert.deepEqual(registry.changedTopics('patterm.example.read'), []);
  assert.deepEqual(registry.changedTopics('patterm.example.post'), ['settings']);
  assert.deepEqual(registry.changedTopics('whoami'), [], 'known reads announce nothing');
  assert.deepEqual(registry.changedTopics('missing'), [], 'unknown tools announce nothing');
}

async function main(): Promise<void> {
  roundTrips();
  patchSize();
  lifecycle();
  await syncService();
  topics();
  console.log('workbench sync smoke passed: randomised patch round trips, sharing, lifecycle, versions, catch-up, topics');
}

void main().catch((error) => { console.error(error); process.exit(1); });
