import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { createRenderer, nextTick, ref, watch } from 'vue';
import { createMemoryHistory } from 'vue-router';
import ts from 'typescript';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const renderer = createRenderer({ createComment: () => ({}), insert() {}, remove() {}, parentNode: () => null, nextSibling: () => null,
  createElement: () => ({}), createText: () => ({}), setText() {}, setElementText() {}, patchProp() {} });

// Real router, shared workbench, launch store and composable; only pages and
// the native RPC are replaced. No live harness, server or database is changed.
test('launch tabs open before native readiness; independent completions preserve selection and project', async () => {
  const output = path.resolve('dist/tests/harness-launch-ui-fixture.cjs');
  await build({ stdin: { contents: `export { createWorkbenchRouter } from './resources/js/router';
    export { useHarnessLaunch, useHarnessLaunchCleanup, useSelectedHarnessLaunch } from './resources/js/Composables/useHarnessLaunch';
    export { harnessLaunches } from './resources/js/lib/harnessLaunches';
    export { lastProjectLocation } from './resources/js/lib/projectLocations';
    export { useWorkbench } from './resources/js/Composables/useWorkbench';`, resolveDir: process.cwd() },
    outfile: output, bundle: true, platform: 'node', format: 'cjs', external: ['vue', 'vue-router'],
    plugins: [{ name: 'page-stubs', setup(builder) { builder.onLoad({ filter: /\.vue$/ }, () => ({ contents: 'export default {}', loader: 'js' })); } }] });
  const calls = [], native = [];
  let failRefresh = false, refreshGate = null;
  const projects = ['p1', 'p2'].map(id => ({ project: { id }, projectSessions: [], processes: [] }));
  globalThis.window = { patterm: {
    workbench: async () => { if (failRefresh) throw new Error('offline'); if (refreshGate) await refreshGate.promise; return { projects: structuredClone(projects) }; },
    call: (tool, args) => { assert.equal(tool, 'harness_launch'); const pending = deferred(); calls.push(args); native.push(pending); return pending.promise; }
  }, addEventListener() {} };
  const fixture = createRequire(import.meta.url)(output);
  const router = fixture.createWorkbenchRouter(createMemoryHistory());
  await router.push('/projects/p1');
  let launchHarness, selectedLaunch;
  const app = renderer.createApp({ setup() { fixture.useHarnessLaunchCleanup(); ({ launchHarness } = fixture.useHarnessLaunch()); selectedLaunch = fixture.useSelectedHarnessLaunch(); return () => null; } });
  app.use(router).mount({});
  const store = fixture.harnessLaunches;
  // Exercise the real overlay-dismissal watcher against the same router.
  const sidebarSource = fs.readFileSync('resources/js/Components/Sidebar/WorkbenchSidebar.vue', 'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
  const sidebarParsed = ts.createSourceFile('sidebar.ts', sidebarSource, ts.ScriptTarget.Latest, true);
  const watchSource = sidebarParsed.statements.find(statement => ts.isExpressionStatement(statement)
    && statement.getText(sidebarParsed).startsWith('watch(') && statement.getText(sidebarParsed).includes('sidebar.page')).getText(sidebarParsed);
  const sidebarLayout = { drawerOpen: true };
  const stopSidebarWatch = new Function('watch', 'sidebar', 'selectedLaunch', 'sidebarLayout', `return ${watchSource}`)(watch,
    { page: ref(null), tabs: ref([]) }, selectedLaunch, sidebarLayout);
  async function settle(index, sessionId, projectId = 'p1') {
    projects.find(project => project.project.id === projectId).projectSessions.push({ id: sessionId, interfaceMode: 'integrated' });
    native[index].resolve({ session_id: sessionId, pty_process_id: null });
    await tick(); await tick(); await nextTick();
  }
  try {
    await fixture.useWorkbench().refresh();
    launchHarness({ projectId: 'p1', targetProjectId: 'p1', harness: 'opencode', interfaceMode: 'tui' });
    assert.equal(store.launches[0].state, 'starting', 'Starting tab is present synchronously');
    await tick();
    const firstId = store.launches[0].id;
    assert.equal(router.currentRoute.value.name, 'launch');
    assert.equal(router.currentRoute.value.params.launchId, firstId);
    assert.equal(calls.length, 1);
    assert.equal(sidebarLayout.drawerOpen, false, 'Board-to-launch navigation closes the narrow sidebar');
    assert.equal(fixture.lastProjectLocation('p1').name, 'project', 'Temporary routes do not become saved project locations');

    sidebarLayout.drawerOpen = true;
    launchHarness({ projectId: 'p1', targetProjectId: 'p1', harness: 'claude', preset: 'fast', interfaceMode: 'integrated' });
    await tick();
    const secondId = store.launches[1].id;
    assert.equal(calls.length, 2, 'Claude RPC starts while OpenCode remains pending');
    assert.equal(router.currentRoute.value.params.launchId, secondId);
    assert.equal(sidebarLayout.drawerOpen, false, 'Selecting another pending tab closes the narrow sidebar');
    await settle(1, 'claude');
    assert.equal(router.currentRoute.value.params.sessionId, 'claude');
    await settle(0, 'opencode');
    assert.equal(router.currentRoute.value.params.sessionId, 'claude', 'Late OpenCode completion never steals focus');
    assert.equal(store.launches.length, 0, 'Real sessions replace temporary entries');

    // Complete the older launch first while viewing the newer pending tab.
    launchHarness({ projectId: 'p1', targetProjectId: 'p1', harness: 'opencode' }); await tick();
    launchHarness({ projectId: 'p1', targetProjectId: 'p1', harness: 'claude' }); await tick();
    const currentId = router.currentRoute.value.params.launchId;
    await settle(2, 'older');
    assert.equal(router.currentRoute.value.params.launchId, currentId);
    await router.push('/projects/p2');
    await settle(3, 'newer');
    assert.equal(router.currentRoute.value.params.projectId, 'p2', 'Project switches survive native completion');

    // A paired-host target still opens in the initiating project's merged view.
    launchHarness({ projectId: 'p1', targetProjectId: 'workstation:remote', harness: 'claude', host: 'workstation' }); await tick();
    assert.equal(calls[4].project_id, 'workstation:remote');
    assert.equal(router.currentRoute.value.params.projectId, 'p1');
    await settle(4, 'workstation:claude');
    assert.equal(router.currentRoute.value.params.sessionId, 'workstation:claude');

    launchHarness({ projectId: 'p1', targetProjectId: 'p1', harness: 'opencode' }); await tick();
    native[5].reject(new Error('Server connection failed')); await tick();
    assert.equal(store.launches[0].state, 'failed');
    assert.equal(store.launches[0].error, 'Server connection failed');
    assert.equal(router.currentRoute.value.name, 'launch', 'Failure keeps its visible error tab');
    assert.equal(calls.length, 6, 'Errors never automatically replay native launches');
    store.dismiss(store.launches[0].id);

    launchHarness({ projectId: 'p1', targetProjectId: 'p1', harness: 'claude' }); await tick();
    failRefresh = true;
    native[6].resolve({ session_id: 'successful-offline' }); await tick(); await tick();
    assert.equal(router.currentRoute.value.params.sessionId, 'successful-offline');
    assert.equal(store.launches[0].state, 'ready', 'Refresh failure cannot reclassify a successful launch');
    assert.equal(calls.length, 7);
    failRefresh = false;
    projects[0].projectSessions.push({ id: 'successful-offline', interfaceMode: 'integrated' });
    await fixture.useWorkbench().refresh(); await tick();
    assert.equal(store.launches.length, 0, 'A later snapshot retires a completed temporary launch');
    projects[0].projectSessions = projects[0].projectSessions.filter(session => session.id !== 'successful-offline');
    await fixture.useWorkbench().refresh(); await tick();
    assert.equal(store.launches.length, 0, 'An aged-out session never resurrects a Ready tab');

    launchHarness({ projectId: 'p1', targetProjectId: 'p1', harness: 'claude' }); await tick();
    native[7].resolve({}); await tick();
    assert.equal(store.launches[0].state, 'failed', 'Malformed replies do not leave an eternal spinner');
    assert.match(store.launches[0].error, /Check the project/);
    store.dismiss(store.launches[0].id);

    // A live patch can observe the session before the completion refresh
    // returns. Keep the selected launch view through that handoff.
    launchHarness({ projectId: 'p1', targetProjectId: 'p1', harness: 'claude' }); await tick();
    const handoffId = router.currentRoute.value.params.launchId;
    refreshGate = deferred();
    native[8].resolve({ session_id: 'handoff' }); await tick();
    fixture.useWorkbench().projects.value[0].projectSessions.push({ id: 'handoff', interfaceMode: 'integrated' });
    await tick();
    assert.equal(store.launches[0].id, handoffId, 'Observed sessions retain the selected placeholder during handoff');
    assert.equal(router.currentRoute.value.params.launchId, handoffId);
    projects[0].projectSessions.push({ id: 'handoff', interfaceMode: 'integrated' });
    refreshGate.resolve(); refreshGate = null;
    await tick(); await tick();
    assert.equal(router.currentRoute.value.params.sessionId, 'handoff');
    assert.equal(store.launches.length, 0, 'Navigation handoff retires the observed launch');
  } finally { stopSidebarWatch?.(); app.unmount(); delete globalThis.window; fs.unlinkSync(output); }
});

// An open tab keeps the build it loaded. After a redeploy, a page it never
// loaded is gone, and opening it fails.
test('a launch view that cannot load still opens the agent, unless the user moved on', async () => {
  const output = path.resolve('dist/tests/harness-launch-stale-fixture.cjs');
  await build({ stdin: { contents: `export { createWorkbenchRouter } from './resources/js/router';
    export { useHarnessLaunch } from './resources/js/Composables/useHarnessLaunch';
    export { useWorkbench } from './resources/js/Composables/useWorkbench';`, resolveDir: process.cwd() },
    outfile: output, bundle: true, platform: 'node', format: 'cjs', external: ['vue', 'vue-router'],
    plugins: [{ name: 'page-stubs', setup(builder) { builder.onLoad({ filter: /\.vue$/ }, (args) => ({ contents: args.path.endsWith('HarnessLaunchPage.vue')
      ? 'throw new Error("Failed to fetch dynamically imported module")' : 'export default {}', loader: 'js' })); } }] });
  const native = [];
  const projects = [{ project: { id: 'p1' }, projectSessions: [{ id: 'current', interfaceMode: 'integrated' }], processes: [] }];
  globalThis.window = { patterm: {
    workbench: async () => ({ projects: structuredClone(projects) }),
    call: () => { const pending = deferred(); native.push(pending); return pending.promise; }
  }, addEventListener() {} };
  const fixture = createRequire(import.meta.url)(output);
  const router = fixture.createWorkbenchRouter(createMemoryHistory());
  router.onError(() => {});
  await router.push('/projects/p1/agents/current');
  let launchHarness;
  const app = renderer.createApp({ setup() { ({ launchHarness } = fixture.useHarnessLaunch()); return () => null; } });
  app.use(router).mount({});
  async function settle(index, sessionId) {
    projects[0].projectSessions.push({ id: sessionId, interfaceMode: 'integrated' });
    native[index].resolve({ session_id: sessionId });
    await tick(); await tick(); await tick();
  }
  try {
    await fixture.useWorkbench().refresh();
    launchHarness({ projectId: 'p1', targetProjectId: 'p1', harness: 'claude', interfaceMode: 'integrated' });
    await tick();
    assert.equal(router.currentRoute.value.params.sessionId, 'current', 'The launch view failed to open');
    await settle(0, 'spawned');
    assert.equal(router.currentRoute.value.params.sessionId, 'spawned', 'The new agent opens anyway');
    router.back(); await tick(); await tick();
    assert.equal(router.currentRoute.value.params.sessionId, 'current', 'Back returns to where the launch started');

    launchHarness({ projectId: 'p1', targetProjectId: 'p1', harness: 'claude', interfaceMode: 'integrated' });
    await tick();
    await router.push('/projects/p1/todos');
    await settle(1, 'later');
    assert.equal(router.currentRoute.value.name, 'todos', 'Moving on before the launch finishes keeps the user there');
  } finally { app.unmount(); delete globalThis.window; fs.unlinkSync(output); }
});

test('menu and empty-state handlers submit every launch with click-time arguments', () => {
  const calls = [];
  const menu = fs.readFileSync('resources/js/Components/LaunchAgentMenu.vue', 'utf8');
  const empty = fs.readFileSync('resources/js/Components/AgentEmptyState.vue', 'utf8');
  function handler(page, values) {
    const parsed = ts.createSourceFile('launch.ts', page.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1], ts.ScriptTarget.Latest, true);
    const fn = parsed.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'launchHarness').getText(parsed);
    const js = ts.transpileModule(fn, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return new Function(...Object.keys(values), `${js};return launchHarness;`)(...Object.values(values));
  }
  const props = { projectId: 'p1' }, targetProjectId = { value: 'p1' }, interfaceMode = { value: 'tui' };
  const menuState = { targetProjectId, interfaceMode, menuOpen: { value: true }, remoteTarget: { value: false }, targetHost: { value: '' }, startHarness: input => calls.push(input), emit() {} };
  const menuLaunch = handler(menu, { ...menuState, launchProjectId: { get value() { return props.projectId; } } });
  // Showing all agents, nothing launches until a project is chosen.
  handler(menu, { ...menuState, launchProjectId: { value: null } })('claude', null);
  assert.equal(calls.length, 0);
  menuLaunch('opencode', null);
  menuLaunch('claude', 'fast');
  props.projectId = 'p2'; targetProjectId.value = 'p2'; interfaceMode.value = 'integrated';
  assert.deepEqual(calls.map(input => [input.harness, input.projectId, input.interfaceMode]), [['opencode', 'p1', 'tui'], ['claude', 'p1', 'tui']]);
  const emptyLaunch = handler(empty, { props, startHarness: input => calls.push(input) });
  emptyLaunch('opencode'); emptyLaunch('claude');
  assert.equal(calls.length, 4);
  assert.equal(calls[3].projectId, 'p2');
  assert.doesNotMatch(menu + empty, /:disabled="launching"/);
});
