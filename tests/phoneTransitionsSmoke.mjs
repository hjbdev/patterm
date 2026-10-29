import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createMemoryHistory, createRouter } from 'vue-router';

const output = path.resolve('dist/tests/phone-transitions-fixture.cjs');
await build({
  entryPoints: ['resources/js/lib/phoneTransitions.ts'],
  outfile: output, bundle: true, platform: 'node', format: 'cjs', external: ['vue', 'vue-router']
});

const media = { phone: true, reducedMotion: false };
let layoutChanged, popstate;
globalThis.window = {
  matchMedia: (query) => ({
    matches: query.includes('max-width') ? media.phone : query.includes('reduced-motion') ? media.reducedMotion : false,
    addEventListener: (_type, listener) => { if (query.includes('max-width')) layoutChanged = listener; }
  }),
  addEventListener: (type, listener) => { if (type === 'popstate') popstate = listener; }
};
// Like a browser's: the update runs a frame later, once the old page is
// captured, and starting a transition skips the one running, rejecting its
// `ready`.
const transitions = [];
let running = null;
globalThis.document = {
  documentElement: { dataset: {} },
  startViewTransition(update) {
    running?.skip();
    let skip;
    const ready = new Promise((_resolve, reject) => { skip = () => reject(new Error('Transition was skipped')); });
    const finished = new Promise((resolve) => setTimeout(resolve, 0)).then(update);
    const transition = { direction: document.documentElement.dataset.phoneNavigation, finished, skip };
    running = transition;
    void finished.then(() => { if (running === transition) running = null; });
    transitions.push(transition);
    return { ready, finished };
  }
};
const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));
const { animatePhoneNavigation } = createRequire(import.meta.url)(output);

const page = { render: () => null };
const NAMES = { '/projects/:projectId': 'project', '/projects/:projectId/agents/:sessionId': 'agent', '/projects/:projectId/library': 'library', '/projects/:projectId/todos/:recordId?': 'todos', '/settings': 'settings' };
function phoneRouter(history = createMemoryHistory(), components = {}) {
  const router = createRouter({
    history,
    routes: Object.entries(NAMES).map(([routePath, name]) => ({ path: routePath, name, component: components[name] ?? page }))
  });
  animatePhoneNavigation(router);
  return router;
}
const directions = () => transitions.map((transition) => transition.direction);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settled = async () => {
  await Promise.all(transitions.map((transition) => transition.finished));
  await tick();
};
const shown = (router, name) => new Promise((resolve) => {
  const remove = router.afterEach((to) => { if (to.name === name) { remove(); resolve(); } });
});
function back(router) {
  const done = new Promise((resolve) => { const remove = router.afterEach(() => { remove(); resolve(); }); });
  router.back();
  return done;
}

test('a phone slides deeper pages in and shallower ones out, unless the browser already animated the back', async () => {
  transitions.length = 0;
  const router = phoneRouter();
  await router.push('/projects/p1');
  assert.deepEqual(directions(), [], 'the first page appears without a transition');

  await router.push('/projects/p1/agents/a1');
  await settled();
  assert.deepEqual(directions(), ['push'], 'an agent slides in over the list');
  assert.equal(document.documentElement.dataset.phoneNavigation, undefined, 'the direction is cleared once the transition ends');

  await router.push('/projects/p1/agents/a2');
  assert.deepEqual(directions(), ['push'], 'the agent beside it swaps in place');

  await back(router);
  await back(router);
  await settled();
  assert.deepEqual(directions(), ['push', 'pop'], 'Back slides the agent away');

  await router.push('/projects/p1/library');
  await router.push('/projects/p1/todos');
  await router.push('/projects/p1/todos/t1');
  await settled();
  assert.deepEqual(directions(), ['push', 'pop', 'push', 'push', 'push'], 'each Library page opens deeper, and a record deeper still');

  // The browser animates its own back, such as Safari's edge swipe, before
  // the popstate the router hears.
  popstate({ hasUAVisualTransition: true });
  await back(router);
  assert.equal(transitions.length, 5, 'a back the browser animated is left alone');
  popstate({ hasUAVisualTransition: false });
  await back(router);
  await settled();
  assert.equal(directions().at(-1), 'pop', 'a back the browser did not animate slides');

  media.reducedMotion = true;
  await router.push('/projects/p1');
  assert.equal(transitions.length, 6, 'reduced motion switches pages at once');
  media.reducedMotion = false;

  layoutChanged({ matches: false });
  await router.push('/projects/p1/agents/a1');
  assert.equal(transitions.length, 6, 'wider layouts keep the list beside the page');
  layoutChanged({ matches: true });
});

test('a browser-animated back stays unanimated while a page it overtook finishes loading', async () => {
  transitions.length = 0;
  let openList, openSettings;
  const list = () => new Promise((resolve) => { openList = () => resolve(page); });
  const settings = () => new Promise((resolve) => { openSettings = () => resolve(page); });
  // Reloaded on an agent opened from the list, so the list hasn't loaded.
  const history = createMemoryHistory();
  history.push('/projects/p1');
  history.push('/projects/p1/agents/a1');
  const router = phoneRouter(history, { project: list, settings });
  await router.push('/projects/p1/agents/a1');

  const toSettings = router.push('/settings');
  await tick();
  const listShown = shown(router, 'project');
  popstate({ hasUAVisualTransition: true });
  router.back();
  await tick();
  // Settings loads first, and its cancelled navigation ends.
  openSettings();
  await toSettings;
  openList();
  await listShown;
  await settled();
  assert.equal(router.currentRoute.value.name, 'project');
  assert.deepEqual(directions(), [], 'the browser animated this back, so the page does not again');
});

test('a navigation that overtakes a running transition skips it quietly', async () => {
  transitions.length = 0;
  const router = phoneRouter();
  await router.push('/projects/p1');
  const toAgent = router.push('/projects/p1/agents/a1');
  for (let step = 0; step < 200 && !transitions.length; step += 1) await Promise.resolve();
  assert.equal(transitions.length, 1, 'the agent transition is waiting for its update');
  await router.push('/projects/p1/library');
  await toAgent;
  await settled();
  assert.equal(router.currentRoute.value.name, 'library');
  assert.deepEqual(directions(), ['push', 'push']);
  assert.equal(document.documentElement.dataset.phoneNavigation, undefined);
  assert.deepEqual(unhandled, [], 'the skipped transition rejects nothing unhandled');
});
