import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';

test('PWA manifest has standalone scope and valid install icons', () => {
  const manifest = JSON.parse(fs.readFileSync('public/manifest.webmanifest', 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.id, '/');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  for (const size of [192, 512]) {
    const icon = manifest.icons.find((entry) => entry.sizes === `${size}x${size}`);
    assert(icon);
    const png = fs.readFileSync(path.join('public', icon.src));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
  assert(manifest.icons.some((icon) => icon.purpose === 'maskable'));
  const touchIcon = fs.readFileSync('public/icons/apple-touch-icon.png');
  assert.equal(touchIcon.readUInt32BE(16), 180);
  assert.match(fs.readFileSync('index.html', 'utf8'), /rel="manifest"/);
});

test('service worker caches only offline assets and never intercepts commands or API data', async () => {
  const handlers = new Map();
  const stored = new Map();
  const deleted = [];
  let online = true;
  let claimed = false;
  const caches = {
    open: async () => ({ addAll: async (urls) => urls.forEach((url) => stored.set(url, new Response(url))) }),
    match: async (url) => stored.get(url)?.clone(),
    keys: async () => ['unrelated-cache', 'patterm-offline-old', 'patterm-offline-v2', 'patterm-offline-v3'],
    delete: async (name) => { deleted.push(name); return true; }
  };
  vm.runInNewContext(fs.readFileSync('public/sw.js', 'utf8'), {
    self: { location: { origin: 'https://patterm.example.ts.net' }, clients: { claim: async () => { claimed = true; } }, addEventListener: (event, handler) => handlers.set(event, handler) },
    caches, URL,
    fetch: async () => { if (!online) throw new Error('offline'); return new Response('live page'); }
  });
  const lifetime = async (event) => {
    let work;
    handlers.get(event)({ waitUntil: (promise) => { work = promise; } });
    await work;
  };
  await lifetime('install');
  assert.deepEqual([...stored.keys()], ['/offline.html', '/icon.svg', '/icons/icon-192.png']);
  await lifetime('activate');
  assert.deepEqual(deleted, ['patterm-offline-old', 'patterm-offline-v2']);
  assert(claimed);
  const request = (pathname, method = 'GET', mode = 'cors') => {
    let response;
    handlers.get('fetch')({ request: { method, mode, url: new URL(pathname, 'https://patterm.example.ts.net').href }, respondWith: (promise) => { response = promise; } });
    return response;
  };
  assert.equal(await (await request('/', 'GET', 'navigate')).text(), 'live page');
  online = false;
  assert.equal(await (await request('/', 'GET', 'navigate')).text(), '/offline.html');
  assert.equal(await (await request('/projects/example/agents/session', 'GET', 'navigate')).text(), '/offline.html');
  assert.equal(await (await request('/icons/icon-192.png')).text(), '/icons/icon-192.png');
  for (const [url, method, mode] of [
    ['/api/rpc', 'POST', 'cors'], ['/api/upload', 'POST', 'cors'], ['/api/events', 'GET', 'cors'],
    ['/health', 'GET', 'cors'], ['/api/rpc', 'GET', 'navigate'], ['https://other.example/', 'GET', 'navigate']
  ]) assert.equal(request(url, method, mode), undefined, `${method} ${url} must bypass the worker`);
});

function loadWorker() {
  const handlers = new Map();
  const shown = [];
  const opened = [];
  const windows = [];
  vm.runInNewContext(fs.readFileSync('public/sw.js', 'utf8'), {
    self: {
      location: { origin: 'https://patterm.example.ts.net' },
      registration: { showNotification: async (title, options) => { shown.push({ title, options }); } },
      clients: { claim: async () => {}, matchAll: async () => windows, openWindow: async (url) => { opened.push(url); } },
      addEventListener: (event, handler) => handlers.set(event, handler)
    },
    caches: {}, URL, fetch: async () => new Response('')
  });
  const dispatch = async (event, payload) => {
    let work;
    handlers.get(event)({ ...payload, waitUntil: (promise) => { work = promise; } });
    await work;
  };
  return { dispatch, shown, opened, windows };
}

test('service worker shows every push and never leaves the origin', async () => {
  const worker = loadWorker();
  const push = (data) => worker.dispatch('push', { data: { json: () => data } });
  await push({ id: 'n1', title: 'Claude needs you', body: 'Approve the migration', url: '/projects/p/agents/s', tag: 'process_1', urgency: 'high' });
  assert.equal(worker.shown[0].title, 'Claude needs you');
  assert.equal(worker.shown[0].options.body, 'Approve the migration');
  assert.equal(worker.shown[0].options.badge, '/icons/badge-96.png');
  assert.equal(worker.shown[0].options.renotify, true);
  assert.equal(worker.shown[0].options.requireInteraction, true);
  assert.equal(worker.shown[0].options.data.url, '/projects/p/agents/s');
  await push({ title: 'x', url: '//evil.example/steal', urgency: 'high' });
  assert.equal(worker.shown[1].options.data.url, '/');
  assert.equal(worker.shown[1].options.renotify, false, 'renotify needs a tag');
  await worker.dispatch('push', { data: { json: () => { throw new Error('bad'); } } });
  assert.equal(worker.shown[2].title, 'Patterm', 'malformed payloads still show a notification');
  const badge = fs.readFileSync('public/icons/badge-96.png');
  assert.equal(badge.readUInt32BE(16), 96);
});

test('notification clicks focus an open window or open the target', async () => {
  const worker = loadWorker();
  let closed = false;
  const click = (url) => worker.dispatch('notificationclick', { notification: { data: { url }, close: () => { closed = true; } } });
  await click('/projects/p/processes/q');
  assert(closed);
  assert.deepEqual(worker.opened, ['/projects/p/processes/q']);
  const messages = [];
  let focused = false;
  worker.windows.push({ url: 'https://patterm.example.ts.net/projects', focus: async () => { focused = true; }, postMessage: (message) => messages.push(message) });
  await click('https://evil.example/');
  assert(focused);
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ type: 'patterm:navigate', url: '/' }]);
});
