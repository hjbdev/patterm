import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import path from 'node:path';

async function load() {
  const output = path.resolve('dist/tests/push-avatars-fixture.cjs');
  await build({ entryPoints: [path.resolve('resources/js/lib/pushAvatars.ts')], outfile: output, bundle: true, platform: 'node', format: 'cjs', external: ['vue', 'vue-router', '@tanstack/vue-query'] });
  return createRequire(import.meta.url)(output);
}

// Cache Storage for one cache, keyed by absolute URL like the browser's.
function fakeCaches(origin) {
  const entries = new Map();
  const url = (request) => new URL(typeof request === 'string' ? request : request.url, origin).href;
  const cache = {
    match: async (request) => entries.get(url(request))?.clone(),
    put: async (request, response) => { entries.set(url(request), response); },
    delete: async (request) => entries.delete(url(request)),
    keys: async () => [...entries.keys()].map((key) => ({ url: key }))
  };
  return { entries, caches: { open: async () => cache } };
}

const bot = (id, kind = 'face') => ({ id, name: id, avatar: { kind, look: { color: 'red' }, emoji: null, picture: kind === 'picture' ? 'data:image/png;base64,aGVsbG8=' : null } });

test('one bot whose picture cannot be drawn leaves the others and cleanup working', async () => {
  const origin = 'https://patterm.example.ts.net';
  const { entries, caches } = fakeCaches(origin);
  Object.assign(globalThis, { caches, location: { origin } });
  const { syncPushAvatars, pushAvatarPath } = await load();
  await caches.open().then((cache) => cache.put('/push-avatars/removed.png', new Response('old')));
  const drawn = [];
  const draw = async (target) => {
    drawn.push(target.id);
    if (target.avatar.kind === 'picture') throw new Error('EncodingError');
    return new Blob(['png']);
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    await syncPushAvatars([bot('broken', 'picture'), bot('fox'), bot('mark', 'mark')], draw);
  } finally { console.warn = warn; }
  assert.deepEqual(drawn, ['broken', 'fox']);
  assert.deepEqual([...entries.keys()], [new URL(pushAvatarPath('fox'), origin).href]);
  // An unchanged avatar is not drawn again.
  await syncPushAvatars([bot('fox')], draw);
  assert.deepEqual(drawn, ['broken', 'fox']);
});
