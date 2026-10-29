import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createMemoryHistory, createRouter } from 'vue-router';

test('a phone slides deeper pages in and shallower ones out, unless the browser already animated the back', async () => {
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
  const transitions = [];
  globalThis.document = {
    documentElement: { dataset: {} },
    startViewTransition(update) {
      const direction = document.documentElement.dataset.phoneNavigation;
      const finished = Promise.resolve().then(update);
      transitions.push({ direction, finished });
      return { finished };
    }
  };
  const { animatePhoneNavigation } = createRequire(import.meta.url)(output);
  const page = { render: () => null };
  const router = createRouter({
    history: createMemoryHistory(),
    routes: ['/projects/:projectId', '/projects/:projectId/agents/:sessionId', '/projects/:projectId/library', '/projects/:projectId/todos/:recordId?']
      .map((routePath, index) => ({ path: routePath, name: ['project', 'agent', 'library', 'todos'][index], component: page }))
  });
  animatePhoneNavigation(router);

  const directions = () => transitions.map((transition) => transition.direction);
  const settled = async () => {
    await Promise.all(transitions.map((transition) => transition.finished));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const back = () => new Promise((resolve) => {
    const remove = router.afterEach(() => { remove(); resolve(); });
    router.back();
  });

  await router.push('/projects/p1');
  assert.deepEqual(directions(), [], 'the first page appears without a transition');

  await router.push('/projects/p1/agents/a1');
  await settled();
  assert.deepEqual(directions(), ['push'], 'an agent slides in over the list');
  assert.equal(document.documentElement.dataset.phoneNavigation, undefined, 'the direction is cleared once the transition ends');

  await router.push('/projects/p1/agents/a2');
  assert.deepEqual(directions(), ['push'], 'the agent beside it swaps in place');

  await back();
  await back();
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
  await back();
  assert.equal(transitions.length, 5, 'a back the browser animated is left alone');
  popstate({ hasUAVisualTransition: false });
  await back();
  await settled();
  assert.equal(directions().at(-1), 'pop', 'a back the browser did not animate slides');

  media.reducedMotion = true;
  await router.push('/projects/p1');
  assert.equal(transitions.length, 6, 'reduced motion switches pages at once');
  media.reducedMotion = false;

  layoutChanged({ matches: false });
  await router.push('/projects/p1/agents/a1');
  assert.equal(transitions.length, 6, 'wider layouts keep the list beside the page');
});
