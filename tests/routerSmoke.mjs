import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import fs from 'node:fs';
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
    releaseSnapshot({ projects: [{ project: { id: 'p1' }, projectSessions: [{ id: 's1', ptyProcessId: 'pty-agent', worktreeId: 'w1' }, { id: 'ended', ptyProcessId: 'reused-pty', exitedAt: '2026-09-08' }], processes: [{ id: 'p2', ptyProcessId: 'pty-shell', status: 'running' }] }] });
    await fixture.useWorkbench().refresh();
    assert.equal(navigation.activeTerminalId.value, 'pty-agent');
    await navigation.selectTerminal('p1', 'pty-shell');
    assert.equal(router.currentRoute.value.fullPath, '/projects/p1/processes/p2');
    assert.equal(navigation.activeTerminalId.value, 'pty-shell');
    const travel = (direction) => new Promise((resolve) => {
      const remove = router.afterEach(() => { remove(); resolve(); });
      router[direction]();
    });
    await travel('back');
    assert.equal(navigation.activeTerminalId.value, 'pty-agent');
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
    window.patterm.workbench = async () => ({ projects: [{ ...beforeLaunch, projectSessions: [
      ...beforeLaunch.projectSessions, { id: 'fresh', ptyProcessId: 'reused-pty' }
    ] }] });
    await navigation.selectTerminal('p1', 'reused-pty');
    assert.equal(router.currentRoute.value.fullPath, '/projects/p1/agents/fresh', 'a historical PTY match must not suppress refresh or select the exited session');
    assert.equal(navigation.activeTerminalId.value, 'reused-pty');
    fixture.useWorkbench().projects.value[0].projectSessions = beforeLaunch.projectSessions;
    const project = fixture.useWorkbench().projects.value[0];
    await router.push('/projects/p1/agents/s1');
    project.projectSessions[0].exitedAt = '2026-09-08';
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(router.currentRoute.value.fullPath, '/projects/p1/processes/p2', 'agent exit selects another live terminal');
    project.processes[0].status = 'exited';
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(router.currentRoute.value.fullPath, '/projects/p1', 'last terminal exit returns to the empty project page');
    project.projectSessions.push({ id: 'integrated', processId: 'process-integrated', interfaceMode: 'integrated', ptyProcessId: null });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(router.currentRoute.value.fullPath, '/projects/p1/agents/integrated', 'an agent launched from the empty project page opens');
    assert.equal(navigation.activeTerminalId.value, null, 'an Integrated agent has no PTY terminal ID');
    project.projectSessions.at(-1).exitedAt = '2026-09-22';
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(router.currentRoute.value.fullPath, '/projects/p1', 'closing the Integrated tab returns to the empty project page');
  } finally {
    app.unmount();
    delete globalThis.window;
    fs.unlinkSync(output);
  }
});
