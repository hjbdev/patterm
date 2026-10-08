import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ref } from 'vue';

// Sonner is stubbed: the test keeps each toast's options and calls its
// onDismiss the way Sonner does for a swipe or the close button.
async function load() {
  const output = path.resolve('dist/tests/notification-toast-fixture.cjs');
  await build({
    entryPoints: [path.resolve('resources/js/Composables/useNotifications.ts')],
    outfile: output, bundle: true, platform: 'node', format: 'cjs', external: ['vue', 'vue-router'],
    plugins: [{ name: 'sonner-stub', setup(builder) {
      builder.onResolve({ filter: /^vue-sonner$/ }, () => ({ path: 'vue-sonner', namespace: 'stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `
        export const toast = Object.assign((title, options) => { globalThis.toasts.set(options.id, options); }, {
          getToasts: () => [...globalThis.toasts.keys()].map((id) => ({ id })),
          dismiss: (id) => { for (const [key, options] of globalThis.toasts) if (id === undefined || key === id) { globalThis.toasts.delete(key); options.onDismiss?.(); } }
        });` }));
    } }]
  });
  return createRequire(import.meta.url)(output);
}

// Replays a browser's dispatch order on window: capture listeners, then the
// target's own handler, then bubbling listeners.
function fakeWindow(api) {
  const listeners = [];
  return {
    patterm: api,
    addEventListener: (type, listener, capture) => listeners.push({ type, listener, capture: Boolean(capture) }),
    dispatch(type, atTarget = () => {}) {
      for (const entry of listeners) if (entry.type === type && entry.capture) entry.listener();
      atTarget();
      for (const entry of listeners) if (entry.type === type && !entry.capture) entry.listener();
    }
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('swiping a toast away leaves it unread; the close button marks it read', async () => {
  const { startNotifications } = await load();
  const reads = [];
  let changed;
  globalThis.toasts = new Map();
  const window = fakeWindow({
    onNotificationsChanged: (listener) => { changed = listener; },
    notificationState: async () => ({ unread: [] }),
    notificationsRead: async (args) => { reads.push(args); },
    notificationSettings: async () => ({ toasts: true }),
    presenceUpdate: async () => {}
  });
  globalThis.window = window;
  globalThis.document = { title: 'Patterm', visibilityState: 'visible', hasFocus: () => false, addEventListener: () => {} };
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (...args) => realSetInterval(...args).unref();
  const route = ref({ path: '/projects/p', fullPath: '/projects/p', params: {} });
  startNotifications({ currentRoute: route, push: async () => {} });
  globalThis.setInterval = realSetInterval;
  await flush();

  const raise = (id) => changed({ type: 'raised', notification: {
    id, project_id: 'p', process_id: 'process_1', session_id: null, kind: 'notify', urgency: 'normal', delivery: 'in_app',
    audience: 'user', title: id, body: '', occurrences: 1, created_at: '', updated_at: '', read_at: null, resolved_at: null,
    url: '/projects/p/process_1', project_name: null, process_name: null
  } });

  raise('swiped');
  window.dispatch('pointerup', () => globalThis.toasts.get('swiped').onDismiss());
  assert.deepEqual(reads, [], 'a swipe only hides the toast');

  raise('dragged');
  const dragged = globalThis.toasts.get('dragged');
  window.dispatch('pointerup', () => dragged.onDismiss());
  window.dispatch('click', () => dragged.onDismiss());
  assert.deepEqual(reads, [], 'a swipe from the close icon ignores the click that ends it');

  raise('closed');
  window.dispatch('pointerup');
  window.dispatch('click', () => globalThis.toasts.get('closed').onDismiss());
  assert.deepEqual(reads, [{ ids: ['closed'] }], 'the close button marks it read');

  raise('cleared');
  changed({ type: 'read', ids: ['cleared'] });
  assert.equal(reads.length, 1, 'toasts the app clears stay unread');
});
