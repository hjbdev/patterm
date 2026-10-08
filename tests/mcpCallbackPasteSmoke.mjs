import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import path from 'node:path';

async function load() {
  const output = path.resolve('dist/tests/mcp-callback-paste-fixture.cjs');
  await build({
    entryPoints: [path.resolve('resources/js/lib/mcpCallbackPaste.ts')],
    outfile: output, bundle: true, platform: 'node', format: 'cjs',
    plugins: [{ name: 'sonner-stub', setup(builder) {
      builder.onResolve({ filter: /^vue-sonner$/ }, () => ({ path: 'vue-sonner', namespace: 'stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const toast = { success: (message) => globalThis.toasts.push(message) };' }));
    } }]
  });
  return createRequire(import.meta.url)(output);
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('only single loopback callback addresses with a code and state match', async () => {
  const { isMcpCallbackPaste } = await load();
  for (const text of [
    'http://127.0.0.1:33418/callback?code=abc&state=xyz',
    '  http://localhost:8080/oauth/callback?state=xyz&code=abc\n',
    'http://[::1]:9000/cb?error=access_denied&state=xyz'
  ]) assert.equal(isMcpCallbackPaste(text), true, text);
  for (const text of [
    'hello world',
    'https://127.0.0.1:33418/callback?code=abc&state=xyz',
    'http://127.0.0.1:33418/callback?code=abc',
    'http://example.com:80/callback?code=abc&state=xyz',
    'http://127.0.0.1/callback?code=abc&state=xyz',
    'http://127.0.0.1:1/callback?code=abc&state=xyz and more',
    'http://127.0.0.1:1/a?code=1&state=2\nhttp://127.0.0.1:1/a?code=1&state=2'
  ]) assert.equal(isMcpCallbackPaste(text), false, text);
});

test('handled pastes toast; unhandled or failed pastes fall back to a normal paste', async () => {
  const { interceptMcpCallbackPaste } = await load();
  const url = 'http://127.0.0.1:33418/callback?code=abc&state=xyz';
  const calls = [];
  let reply = async () => ({ handled: true, kind: 'patterm', name: 'linear' });
  globalThis.toasts = [];
  globalThis.window = { patterm: { call: async (tool, args) => { calls.push([tool, args]); return reply(); } } };

  const fallback = [];
  assert.equal(interceptMcpCallbackPaste('plain text', (text) => fallback.push(text)), false);
  assert.equal(calls.length, 0);

  assert.equal(interceptMcpCallbackPaste(` ${url} `, (text) => fallback.push(text)), true);
  await flush();
  assert.deepEqual(calls[0], ['patterm.mcp.callback.paste', { url }]);
  assert.deepEqual(globalThis.toasts, ['Signed in to linear']);

  reply = async () => ({ handled: true, kind: 'agent' });
  interceptMcpCallbackPaste(url, (text) => fallback.push(text));
  await flush();
  assert.equal(globalThis.toasts[1], "Finished the agent's sign-in");

  reply = async () => ({ handled: false });
  interceptMcpCallbackPaste(url, (text) => fallback.push(text));
  await flush();
  reply = async () => { throw new Error('offline'); };
  interceptMcpCallbackPaste(url, (text) => fallback.push(text));
  await flush();
  assert.deepEqual(fallback, [url, url]);
});
