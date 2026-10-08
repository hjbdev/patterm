import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRendererHarness, loadRendererModule, snapshot, damage } from './terminalRendererHarness.mjs';

const { TerminalRenderer: Renderer } = await loadRendererModule();


for (const backend of ['webgpu', 'webgl']) {
  test(`${backend}: reuse atlas entries and preserve glyph variants`, async () => {
    const harness = await createRendererHarness(Renderer, { backend, cols: 16, rows: 4, capture: true });
    assert.equal(harness.renderer.applyDamageFrame(snapshot(16, 4, 'variants'), 'p'), 'p');
    assert.equal(harness.glyphs.length, 12);
    if (backend === 'webgpu') assert.equal(harness.textures[0].usage & 0x12, 0x12, 'external image copies require COPY_DST and RENDER_ATTACHMENT');
    assert.equal(new Set(harness.glyphs.map(([char, font]) => `${char}:${font}`)).size, 12);
    harness.reset();
    harness.renderer.renderCurrentState();
    assert.ok(harness.metrics().uploadedBytes <= 336, 'unchanged repaint uploads only cursor geometry');
    assert.equal(harness.glyphs.length, 0);
    assert.equal(harness.metrics().atlasUploads, 0);
    harness.renderer.dispose();
  });

  test(`${backend}: retain a full atlas without repeated rasterisation`, async () => {
    const harness = await createRendererHarness(Renderer, { backend, cols: 16, rows: 4, maxTextureSize: 128, capture: true });
    harness.renderer.applyDamageFrame(snapshot(16, 4, 'unicode', 0x1f600), 'p');
    assert.equal(harness.glyphs.length, 24);
    harness.reset();
    harness.renderer.renderCurrentState();
    assert.equal(harness.glyphs.length, 0);
    assert.ok(harness.metrics().uploadedBytes <= 336, 'unchanged repaint uploads only cursor geometry');
    assert.equal(harness.metrics().atlasUploads, 0);
    harness.renderer.dispose();
  });

  test(`${backend}: upload only damaged rows and new glyph pixels`, async () => {
    const harness = await createRendererHarness(Renderer, { backend, cols: 240, rows: 80 });
    harness.renderer.applyDamageFrame(snapshot(240, 80), 'p');
    const fullBytes = harness.metrics().uploadedBytes;
    harness.reset();
    harness.renderer.applyDamageFrame(damage(240, 80, { row: 5, codepoint: 0x03a9 }), 'p');
    assert.ok(harness.metrics().uploadedBytes < fullBytes / 20);
    assert.equal(harness.metrics().rasterisedGlyphs, 1);
    assert.equal(harness.metrics().atlasUploads, 1);
    assert.equal(harness.metrics().atlasUploadBytes, 19 * 26 * 4);
    harness.renderer.dispose();
  });

  test(`${backend}: reclaim unused atlas slots while retaining visible glyphs`, async () => {
    const harness = await createRendererHarness(Renderer, { backend, cols: 12, rows: 1, maxTextureSize: 128 });
    harness.renderer.applyDamageFrame(snapshot(12, 1, 'unicode', 0x400), 'p');
    harness.renderer.applyDamageFrame(snapshot(12, 1, 'unicode', 0x40c), 'p');
    harness.reset();
    // Keep eleven cached glyphs and introduce one that needs an old slot.
    harness.renderer.applyDamageFrame(damage(12, 1, { codepoint: 0x500 }), 'p');
    assert.equal(harness.metrics().rasterisedGlyphs, 1);
    harness.reset();
    harness.renderer.renderCurrentState();
    assert.equal(harness.metrics().rasterisedGlyphs, 0);
    assert.equal(harness.metrics().atlasUploads, 0);
    harness.renderer.dispose();
  });
  test(`${backend}: recover omitted glyphs when an overflowing screen frees a slot`, async () => {
    const harness = await createRendererHarness(Renderer, { backend, cols: 32, rows: 1, maxTextureSize: 128, capture: true });
    harness.renderer.applyDamageFrame(snapshot(32, 1, 'unicode', 0x400), 'p');
    harness.reset();
    harness.renderer.applyDamageFrame(damage(32, 1, { codepoint: 32 }), 'p');
    assert.deepEqual(harness.glyphs.map(([char]) => char), [String.fromCodePoint(0x418)]);
    harness.renderer.dispose();
  });

  test(`${backend}: sparse screens do not draw padded rows`, async () => {
    const harness = await createRendererHarness(Renderer, { backend, cols: 240, rows: 80 });
    const frame = snapshot(240, 80);
    for (let row = 1; row < 80; row += 1) for (let col = 0; col < 240; col += 1) frame.writeUInt32LE(32, 30 + row * (6 + 240 * 16) + 6 + col * 16);
    harness.renderer.applyDamageFrame(frame, 'p');
    assert.equal(harness.metrics().submittedVertices, (240 + 2) * 6);
    harness.reset();
    harness.renderer.applyDamageFrame(damage(240, 80, { row: 3, col: 2 }), 'p');
    assert.equal(harness.metrics().submittedVertices, (241 + 2) * 6);
    harness.renderer.dispose();
  });

  test(`${backend}: overflow retains the first distinct glyphs in screen order`, async () => {
    const harness = await createRendererHarness(Renderer, { backend, cols: 32, rows: 1, maxTextureSize: 128, capture: true });
    const frame = snapshot(32, 1, 'unicode', 0x400);
    for (let col = 24; col < 32; col += 1) frame.writeUInt32LE(0x400 + col - 24, 36 + col * 16);
    harness.renderer.applyDamageFrame(frame, 'p');
    harness.reset();
    harness.renderer.applyDamageFrame(damage(32, 1, { codepoint: 0x500 }), 'p');
    assert.deepEqual(harness.glyphs.map(([char]) => char), [String.fromCodePoint(0x500)]);
    const atlas = harness.renderer.backend.atlas;
    assert.ok(atlas.glyphs.has(0x500 * 8));
    assert.ok(!atlas.glyphs.has(0x400 * 8));
    harness.renderer.dispose();
  });

  test(`${backend}: restore a stashed grid until the next snapshot`, async () => {
    const harness = await createRendererHarness(Renderer, { backend, cols: 16, rows: 4, capture: true });
    harness.renderer.applyDamageFrame(snapshot(16, 4, 'text', 0x41), 'p');
    harness.renderer.stashGrid('p');
    harness.renderer.clear();
    assert.equal(harness.renderer.linkAt(0, 0), null);
    assert.equal(harness.renderer.restoreGrid('missing'), false);
    harness.reset();
    assert.equal(harness.renderer.restoreGrid('p'), true);
    assert.ok(harness.metrics().submittedVertices > 0, 'restored grid paints immediately');
    assert.equal(harness.renderer.restoreGrid('p'), false, 'restore takes the cached grid');
    // Damage cannot apply to a possibly stale grid; the next snapshot can.
    harness.renderer.applyDamageFrame(damage(16, 4, { codepoint: 0x42 }), 'p');
    assert.equal(harness.renderer.debugState().lastFrameDecision.reason, 'epoch-or-dimensions-mismatch');
    harness.renderer.applyDamageFrame(snapshot(16, 4, 'text', 0x43), 'p');
    assert.equal(harness.renderer.debugState().lastFrameDecision.action, 'applied');
    harness.renderer.dispose();
  });
}

test('webgpu: a remounted renderer reuses the device, pipelines, and glyph atlas', async () => {
  const harness = await createRendererHarness(Renderer, { backend: 'webgpu', cols: 16, rows: 4, capture: true });
  harness.renderer.applyDamageFrame(snapshot(16, 4, 'variants'), 'p');
  harness.renderer.dispose();
  const gpu = globalThis.navigator.gpu;
  let adapterRequests = 0;
  const requestAdapter = gpu.requestAdapter;
  gpu.requestAdapter = async () => { adapterRequests += 1; return requestAdapter(); };
  harness.reset();
  const remounted = new Renderer(harness.canvas);
  remounted.mount();
  // No await: a cached device attaches synchronously.
  remounted.applyDamageFrame(snapshot(16, 4, 'variants'), 'p');
  assert.equal(adapterRequests, 0);
  assert.ok(harness.metrics().submittedVertices > 0);
  assert.equal(harness.glyphs.length, 0, 'glyphs are not rasterised again');
  assert.equal(harness.metrics().atlasUploads, 0);
  assert.equal(harness.textures.length, 1);
  remounted.dispose();
});

test('webgpu: device loss drops the shared device and reattaches mounted renderers', async () => {
  const harness = await createRendererHarness(Renderer, { backend: 'webgpu', cols: 16, rows: 4 });
  harness.renderer.dispose();
  const device = await (await globalThis.navigator.gpu.requestAdapter()).requestDevice();
  let loseDevice;
  let adapterRequests = 0;
  const lostDevice = { ...device, lost: new Promise((resolve) => { loseDevice = resolve; }) };
  const gpu = { requestAdapter: async () => { adapterRequests += 1; return { requestDevice: async () => adapterRequests === 1 ? lostDevice : device }; } };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { gpu } });
  const renderer = new Renderer(harness.canvas);
  renderer.mount();
  await new Promise((resolve) => setImmediate(resolve));
  renderer.applyDamageFrame(snapshot(16, 4), 'p');
  assert.equal(adapterRequests, 1);
  loseDevice({ reason: 'unknown' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(adapterRequests, 2, 'the lost device is not reused');
  harness.reset();
  renderer.renderCurrentState();
  assert.ok(harness.metrics().submittedVertices > 0, 'the renderer draws with the new device');
  renderer.dispose();
});
