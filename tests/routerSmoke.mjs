import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import ts from 'typescript';
import path from 'node:path';
import { createRenderer, ref } from 'vue';
import { createMemoryHistory } from 'vue-router';

test('saved IDs drive navigation, delayed snapshots, history queries, and Back/Forward', async () => {
  const output = path.resolve('dist/tests/router-fixture.cjs');
  await build({
    stdin: { contents: `export { createWorkbenchRouter } from './resources/js/router';
      export { useTerminalPageNavigation as useWorkbenchNavigation, useProjectFirstTab } from './resources/js/Composables/useTerminalPageNavigation';
      export { useWorkbench } from './resources/js/Composables/useWorkbench';`, resolveDir: process.cwd() },
    outfile: output, bundle: true, platform: 'node', format: 'cjs', external: ['vue', 'vue-router'],
    // Page rendering is checked in the browser; this fixture exercises real routing and selection.
    plugins: [{ name: 'page-stubs', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, () => ({ contents: 'export default {}', loader: 'js' }));
    } }]
  });
  let releaseSnapshot;
  const snapshot = new Promise((resolve) => { releaseSnapshot = resolve; });
  globalThis.window = { patterm: { workbench: () => snapshot }, addEventListener() {} };
  const fixture = createRequire(import.meta.url)(output);
  const router = fixture.createWorkbenchRouter(createMemoryHistory());
  // A bot link that names no project, as its notifications use, still resolves.
  const botLink = router.resolve('/bots/assistant');
  assert.equal(botLink.name, 'botLink');
  assert.equal(botLink.params.botId, 'assistant');
  await router.push('/projects/p1/agents/s1');
  const renderer = createRenderer({
    createComment: () => ({}), insert() {}, remove() {}, parentNode: () => null, nextSibling: () => null,
    createElement: () => ({}), createText: () => ({}), setText() {}, setElementText() {}, patchProp() {}
  });
  let navigation;
  // The project page's own redirect stands in for ProjectPage, which is stubbed.
  const app = renderer.createApp({ setup() { navigation = fixture.useWorkbenchNavigation(); fixture.useProjectFirstTab(ref(false)); return () => null; } });
  app.use(router).mount({});
  try {
    assert.equal(navigation.activeProjectId.value, 'p1');
    assert.equal(navigation.activeProject.value, null);
    assert.equal(router.currentRoute.value.fullPath, '/projects/p1/agents/s1', 'initial loading must preserve the deep link');
    releaseSnapshot({ projects: [{ project: { id: 'p1' }, projectSessions: [{ id: 's1', processId: 'process-s1', worktreeId: 'w1' }, { id: 'ended', processId: 'process-ended', exitedAt: '2026-09-08' }], processes: [{ id: 'p2', ptyProcessId: 'pty-shell', status: 'running' }, { id: 'p_old', ptyProcessId: 'reused-pty', status: 'exited' }] }] });
    await fixture.useWorkbench().refresh();
    assert.equal(navigation.selectedAgent.value.id, 's1');
    assert.equal(navigation.activeTerminalId.value, null);
    await navigation.selectTerminal('p1', 'pty-shell');
    assert.equal(router.currentRoute.value.fullPath, '/projects/p1/processes/p2');
    assert.equal(navigation.activeTerminalId.value, 'pty-shell');
    const travel = (direction) => new Promise((resolve) => {
      const remove = router.afterEach(() => { remove(); resolve(); });
      router[direction]();
    });
    await travel('back');
    assert.equal(navigation.selectedAgent.value.id, 's1');
    assert.equal(navigation.activeTerminalId.value, null);
    await router.push('/projects/p1/agents/s1/diffs');
    assert.equal(router.currentRoute.value.fullPath, '/projects/p1/agents/s1', 'old Diffs page links open the agent');
    assert.equal(navigation.selectedAgent.value.worktreeId, 'w1');
    await navigation.switchViewMode('worktrees');
    assert.equal(router.currentRoute.value.fullPath, '/projects/p1/worktrees');
    await travel('back');
    assert.equal(navigation.projectViewMode.value, 'agents');
    await travel('forward');
    assert.equal(navigation.projectViewMode.value, 'worktrees');
    await navigation.openConversationHistory();
    await router.push({ query: { conversation: 'c1', message: 'm1' } });
    assert.equal(router.currentRoute.value.fullPath, '/projects/p1/history?conversation=c1&message=m1');
    assert.equal(navigation.activeTerminalId.value, null);
    for (const kind of ['todos', 'scratchpads']) {
      await router.push(`/projects/p1/${kind}/context-record`);
      assert.equal(router.currentRoute.value.name, kind);
      assert.equal(router.currentRoute.value.params.recordId, 'context-record');
      assert.equal(navigation.activeTerminalId.value, null, 'project context must not select a terminal');
    }
    await router.push('/projects/p1/agents/missing');
    assert.equal(navigation.activeTerminalId.value, null, 'missing IDs must not silently select another terminal');
    await router.push('/projects/p1/agents/ended');
    assert.equal(navigation.activeTerminalId.value, null, 'exited sessions must not attach to reused PTY IDs after restart');
    await router.push('/projects/missing/agents/s1');
    assert.equal(navigation.activeProject.value, null);
    await navigation.selectProject(null);
    assert.equal(router.currentRoute.value.fullPath, '/projects');
    await router.push('/unrecognised');
    assert.equal(router.currentRoute.value.name, 'not-found');
    const beforeLaunch = fixture.useWorkbench().projects.value[0];
    window.patterm.workbench = async () => ({ projects: [{ ...beforeLaunch, processes: [
      ...beforeLaunch.processes, { id: 'p_fresh', ptyProcessId: 'reused-pty', status: 'running' }
    ] }] });
    await navigation.selectTerminal('p1', 'reused-pty');
    assert.equal(router.currentRoute.value.fullPath, '/projects/p1/processes/p_fresh', 'a historical PTY match must not suppress refresh or select the exited process');
    assert.equal(navigation.activeTerminalId.value, 'reused-pty');
    const workbench = fixture.useWorkbench();
    const bumpProjects = () => {
      workbench.projects.value = workbench.projects.value.map((p) => ({
        ...p,
        projectSessions: p.projectSessions.map((s) => ({ ...s })),
        processes: p.processes.map((proc) => ({ ...proc }))
      }));
    };
    workbench.projects.value[0].projectSessions = beforeLaunch.projectSessions;
    workbench.projects.value[0].processes = beforeLaunch.processes;
    bumpProjects();
    await router.push('/projects/p1/agents/s1');
    workbench.projects.value[0].projectSessions[0].exitedAt = '2026-09-08';
    bumpProjects();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(router.currentRoute.value.fullPath, '/projects/p1/processes/p2', 'agent exit selects another live tab');
    workbench.projects.value[0].processes[0].status = 'exited';
    bumpProjects();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(router.currentRoute.value.fullPath, '/projects/p1', 'last tab exit returns to the empty project page');
    workbench.projects.value[0].projectSessions.push({ id: 'integrated', processId: 'process-integrated' });
    bumpProjects();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(router.currentRoute.value.fullPath, '/projects/p1/agents/integrated', 'an agent launched from the empty project page opens');
    assert.equal(navigation.activeTerminalId.value, null, 'an Integrated agent has no PTY terminal ID');
    workbench.projects.value[0].projectSessions.at(-1).exitedAt = '2026-09-22';
    workbench.projects.value[0].projectSessions.at(-1).processStatus = 'failed';
    bumpProjects();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(router.currentRoute.value.fullPath, '/projects/p1/agents/integrated', 'a failed Integrated agent stays open for /restart');
    // Exercise the actual layout handler used by sidebar families and tabs,
    // starting on another page rather than opening a direct agent URL.
    await router.push('/projects/p1/todos');
    const layout = fs.readFileSync('resources/js/Layouts/WorkbenchLayout.vue', 'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
    const parsed = ts.createSourceFile('layout.ts', layout, ts.ScriptTarget.Latest, true);
    const handler = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'selectAgentSession');
    const compiled = ts.transpileModule(handler.getFullText(parsed), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const ownerProjectId = () => navigation.activeProject.value?.project.id ?? null;
    const clickSession = new Function('ownerProjectId', 'router', 'selectTerminal', `${compiled}; return selectAgentSession;`)(ownerProjectId, router, navigation.selectTerminal);
    clickSession(workbench.projects.value[0].projectSessions.at(-1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(router.currentRoute.value.fullPath, '/projects/p1/agents/integrated', 'clicking the failed parent in the sidebar opens its conversation');
    workbench.projects.value[0].projectSessions.at(-1).processStatus = 'closed';
    bumpProjects();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(router.currentRoute.value.fullPath, '/projects/p1', 'explicitly closing the Integrated tab returns to the empty project page');
  } finally {
    app.unmount();
    delete globalThis.window;
    fs.unlinkSync(output);
  }
});

test('a page whose code is gone after an update reloads the tab there once', async () => {
  const output = path.resolve('dist/tests/router-stale-fixture.cjs');
  await build({
    stdin: { contents: `export { createWorkbenchRouter, reloadOnStaleBuild } from './resources/js/router';`, resolveDir: process.cwd() },
    outfile: output, bundle: true, platform: 'node', format: 'cjs', external: ['vue', 'vue-router'],
    plugins: [{ name: 'page-stubs', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, (args) => ({ contents: /TodosPage|ScratchpadsPage|HarnessLaunchPage|MediaPage/.test(args.path)
        ? `throw new Error(${JSON.stringify(args.path.includes('MediaPage') ? 'Cannot read properties of undefined' : 'Failed to fetch dynamically imported module: https://x/assets/page.js')})`
        : 'export default {}', loader: 'js' }));
    } }]
  });
  globalThis.window = { patterm: {}, addEventListener() {} };
  try {
    const fixture = createRequire(import.meta.url)(output);
    const router = fixture.createWorkbenchRouter(createMemoryHistory());
    const reloads = [];
    const values = new Map();
    const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
    fixture.reloadOnStaleBuild(router, (url) => reloads.push(url), () => storage);
    await router.push('/projects/p1/agents/s1');
    await router.push('/projects/p1/todos').catch(() => {});
    assert.deepEqual(reloads, ['/projects/p1/todos'], 'a missing page loads the new build there');
    await router.push('/projects/p1/todos').catch(() => {});
    assert.equal(reloads.length, 1, 'a page that still fails after reloading is not reloaded again');
    await router.push('/projects/p1/launches/launch_1').catch(() => {});
    assert.equal(reloads.length, 1, 'the launch view is left to its own fallback');
    await router.push('/projects/p1/media').catch(() => {});
    assert.equal(reloads.length, 1, 'other page errors do not reload');
    await router.push('/projects/p1/history');
    assert.equal(values.size, 0, 'a page that opens clears the attempt');
    const unstored = fixture.createWorkbenchRouter(createMemoryHistory());
    const blind = [];
    fixture.reloadOnStaleBuild(unstored, (url) => blind.push(url), () => null);
    const failed = await unstored.push('/projects/p1/scratchpads').then(() => null, (error) => error);
    assert.match(String(failed), /Failed to fetch/);
    assert.deepEqual(blind, [], 'without storage to bound it, the tab is never reloaded');
  } finally { delete globalThis.window; fs.unlinkSync(output); }
});
