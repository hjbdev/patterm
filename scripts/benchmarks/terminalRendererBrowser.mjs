import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshot, damage } from '../../tests/terminalRendererHarness.mjs';

// Start this page, then use agent-browser to evaluate window.verify('webgl')
// and window.verify('webgpu'). Supply a baseline source as the first argument.
const directory = await mkdtemp(join(tmpdir(), 'patterm-renderer-browser-'));
const baseline = process.argv[2] ?? 'resources/js/terminal/TerminalRenderer.ts';
await Promise.all([['current', 'resources/js/terminal/TerminalRenderer.ts'], ['reference', baseline]].flatMap(([name, source]) => ['webgpu', 'webgl'].map(async backend => {
  let contents = await readFile(source, 'utf8');
  // Select the fallback without replacing navigator.gpu; replacing that native
  // object can invalidate the software Dawn instance in headless Chromium.
  // Baseline atlas copies also need RENDER_ATTACHMENT to render any glyphs.
  // Apply only this validation fix to the browser baseline for a fair comparison.
  if (name === 'reference' && backend === 'webgpu') contents = contents.replace('usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING | GPU_TEXTURE_USAGE_COPY_DST', 'usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING | GPU_TEXTURE_USAGE_COPY_DST | 0x10');
  if (backend === 'webgl') contents = contents.replace(/function hasWebGpu\(\): boolean \{\n[^\n]+\n\}/, 'function hasWebGpu(): boolean { return false; }');
  await build({ stdin: { contents, sourcefile: source, loader: 'ts' }, outfile: join(directory, name + '-' + backend + '.js'), bundle: true, format: 'esm', platform: 'browser', logLevel: 'silent' });
})));
const fixtures = Object.fromEntries(['text', 'styled', 'blocks', 'variants', 'unicode'].map((workload) => [workload, [...snapshot(24, 8, workload, workload === 'unicode' ? 0x4e00 : 33)]]));
const wide = snapshot(24, 8, 'variants');
for (let row = 0; row < 8; row += 1) for (let col = 0; col < 24; col += 4) {
  const offset = 30 + row * (6 + 24 * 16) + 6 + col * 16;
  wide.writeUInt32LE(0x4e00 + row, offset); wide.writeUInt16LE(32, offset + 4);
  wide.writeUInt32LE(32, offset + 16); wide.writeUInt16LE(64, offset + 20);
  wide.writeUInt32LE(102, offset + 32); wide.writeUInt16LE(12, offset + 36);
  wide.writeUInt16LE(256, offset + 52);
}
fixtures.wide = [...wide];
const benchmarkFrame = snapshot(240, 80).toString('base64');
const html = `<!doctype html><html><body style="background:#151515;color:white"><p>Terminal renderer pixel and browser benchmark harness</p><div id="canvases"></div><pre id="result"></pre><script type="module">
import { TerminalRenderer as CurrentGpu } from '/current-webgpu.js';
import { TerminalRenderer as ReferenceGpu } from '/reference-webgpu.js';
import { TerminalRenderer as CurrentGl } from '/current-webgl.js';
import { TerminalRenderer as ReferenceGl } from '/reference-webgl.js';
const fixtures = ${JSON.stringify(fixtures)};
const benchmarkFrame = Uint8Array.from(atob('${benchmarkFrame}'), char => char.charCodeAt(0));
const damageTemplate = ${JSON.stringify([...damage(24, 8)])};
const errors = [];
window.addEventListener('error', event => errors.push(event.message));
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
async function create(Renderer, backend, width = 216, height = 144) {

  const canvas = document.createElement('canvas');
  canvas.style.width = width + 'px'; canvas.style.height = height + 'px';
  document.querySelector('#canvases').append(canvas);
  const renderer = new Renderer(canvas);
  renderer.mount(); window.lastCreatedRenderer = renderer;
  if (backend === 'webgpu') {
    for (let index = 0; index < 1000 && !renderer.backend?.ready; index++) await new Promise(resolve => setTimeout(resolve, 10));
    if (!renderer.backend?.ready) throw new Error('WebGPU did not initialise');
    renderer.backend.device.addEventListener('uncapturederror', event => errors.push(event.error.message));

  }
  let texture, textureWidth = 0, textureHeight = 0;
  if (backend === 'webgpu') renderer.backend.context = {
    configure() {},
    getCurrentTexture() {
      if (!texture || textureWidth !== canvas.width || textureHeight !== canvas.height) {
        texture?.destroy(); textureWidth = canvas.width; textureHeight = canvas.height;
        texture = renderer.backend.device.createTexture({ size: [textureWidth, textureHeight], format: renderer.backend.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      }
      return texture;
    },
  };
  return { canvas, renderer, get texture() { return texture; }, dispose() { texture?.destroy(); const device = renderer.backend.device; const gl = renderer.backend.gl; renderer.dispose(); device?.destroy(); gl?.getExtension('WEBGL_lose_context')?.loseContext(); canvas.remove(); } };
}
async function settle(...items) {
  await Promise.all(items.map(item => item.renderer.backend.device?.queue.onSubmittedWorkDone()));
}
async function pixels(item) {
  const { canvas, renderer, texture } = item;
  if (texture) {
    // Headless Linux does not present WebGPU canvases reliably. Read the real
    // render target directly, including padding required by GPU buffer copies.
    const device = renderer.backend.device;
    const bytesPerRow = Math.ceil(canvas.width * 4 / 256) * 256;
    const buffer = device.createBuffer({ size: bytesPerRow * canvas.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [canvas.width, canvas.height]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(buffer.getMappedRange()), data = new Uint8Array(canvas.width * canvas.height * 4);
    for (let row = 0; row < canvas.height; row++) data.set(mapped.subarray(row * bytesPerRow, row * bytesPerRow + canvas.width * 4), row * canvas.width * 4);
    buffer.unmap(); buffer.destroy(); return data;
  }
  const copy = document.createElement('canvas'); copy.width = canvas.width; copy.height = canvas.height;
  const context = copy.getContext('2d'); context.drawImage(canvas, 0, 0);
  return context.getImageData(0, 0, copy.width, copy.height).data;
}
async function compare(a, b, label) {
  const left = await pixels(a), right = await pixels(b);
  if (left.length !== right.length) throw new Error(label + ': size differs');
  let different = 0;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) different++;
  if (different) throw new Error(label + ': ' + different + ' channel differences');
}
window.verify = async backend => {
  const Current = backend === 'webgpu' ? CurrentGpu : CurrentGl, Reference = backend === 'webgpu' ? ReferenceGpu : ReferenceGl;
  const checked = [];
  for (const workload of Object.keys(fixtures)) {
    const a = await create(Current, backend), b = await create(Reference, backend);
    const frame = Uint8Array.from(fixtures[workload]);
    a.renderer.applyDamageFrame(frame, 'p'); b.renderer.applyDamageFrame(frame, 'p');
    await settle(a, b);
    await compare(a, b, workload + ' snapshot');
    if (workload === 'text' && new Set(await pixels(a)).size < 8) throw new Error('Glyphs were not rasterised');
    for (const [row, col, codepoint, shape] of [[2, 1, 0x03a9, 0], [5, 4, 0x4e42, 1], [0, 0, 32, 2], [7, 23, 0x1f642, 3]]) {
      const change = Uint8Array.from(damageTemplate), view = new DataView(change.buffer);
      view.setUint16(30, row, true); view.setUint16(32, col, true); view.setUint32(36, codepoint, true);
      view.setUint16(22, col, true); view.setUint16(24, row, true); view.setUint8(27, shape);
      a.renderer.applyDamageFrame(change, 'p'); b.renderer.applyDamageFrame(change, 'p');
      await settle(a, b);
    await compare(a, b, workload + ' damage ' + row);
    }
    for (const item of [a, b]) { item.canvas.style.width = '324px'; item.canvas.style.height = '180px'; item.renderer.resizeSurface(); }
    await settle(a, b);
    await compare(a, b, workload + ' resize');
    for (const item of [a, b]) { item.renderer.setFontSettings({ fontSize: 18, fontFamily: 'monospace' }); item.renderer.renderCurrentState(); }
    await settle(a, b);
    await compare(a, b, workload + ' font');
    for (const item of [a, b]) { item.renderer.renderCurrentState(); }
    await settle(a, b);
    await compare(a, b, workload + ' unchanged repaint');
    for (const item of [a, b]) item.renderer.clear();
    await settle(a, b);
    await compare(a, b, workload + ' clear');
    checked.push(workload); a.dispose(); b.dispose();
  }
  await new Promise(resolve => requestAnimationFrame(resolve));
  if (errors.length) throw new Error(errors.join('; '));
  const result = { backend, baselineAdjustment: backend === 'webgpu' ? 'Required RENDER_ATTACHMENT atlas texture flag only' : null, checked, devicePixelRatio, errors, userAgent: navigator.userAgent };
  document.querySelector('#result').textContent = JSON.stringify(result, null, 2);
  return result;
};
window.benchmark = async backend => {
  const Current = backend === 'webgpu' ? CurrentGpu : CurrentGl, Reference = backend === 'webgpu' ? ReferenceGpu : ReferenceGl;
  const samples = 10, iterations = 5, results = [];
  for (const workload of ['sparse-text', 'sparse-screen', 'full-damage', 'new-glyph']) {
    const initial = benchmarkFrame.slice(), initialView = new DataView(initial.buffer);
    if (workload === 'sparse-screen') for (let row = 1; row < 80; row++) for (let col = 0; col < 240; col++) initialView.setUint32(30 + row * (6 + 240 * 16) + 6 + col * 16, 32, true);
    const measurements = [{name:'reference', Renderer:Reference, cold:[], warm:[]}, {name:'current', Renderer:Current, cold:[], warm:[]}];
    for (let sample = 0; sample < samples; sample++) {
      for (const measurement of sample % 2 ? [...measurements].reverse() : measurements) {
        const item = await create(measurement.Renderer, backend, 2160, 1440);
        const start = performance.now(); item.renderer.applyDamageFrame(initial, 'p'); await settle(item); await pixels(item); measurement.cold.push(performance.now() - start);
        const change = Uint8Array.from(damageTemplate), view = new DataView(change.buffer);
        view.setUint16(18, 240, true); view.setUint16(20, 80, true);
        for (let i = 0; i < 3; i++) { view.setUint32(36, workload === 'new-glyph' ? 0x400 + i : 65 + i % 2, true); item.renderer.applyDamageFrame(workload === 'full-damage' ? initial : change, 'p'); await settle(item); await pixels(item); }
        const warmed = performance.now();
        for (let i = 0; i < iterations; i++) { view.setUint32(36, workload === 'new-glyph' ? 0x403 + i : 65 + i % 2, true); item.renderer.applyDamageFrame(workload === 'full-damage' ? initial : change, 'p'); await settle(item); await pixels(item); }
        measurement.warm.push((performance.now() - warmed) / iterations); item.dispose();
      }
    }
    const percentile = (values, median) => { const ordered = [...values].sort((a,b) => a-b); return median ? (ordered[4] + ordered[5]) / 2 : ordered[9]; };
    for (const {name, cold, warm} of measurements) results.push({ name, workload, cols:240, rows:80, coldMedianMs:percentile(cold,true), coldP95Ms:percentile(cold), warmMedianMs:percentile(warm,true), warmP95Ms:percentile(warm), cold, warm });
  }
  return { backend, baselineAdjustment: backend === 'webgpu' ? 'Required RENDER_ATTACHMENT atlas texture flag only' : null, samples, iterations, devicePixelRatio, userAgent:navigator.userAgent, boundary: 'Chromium with SwiftShader, rendering 240x80 and completed GPU queue and pixel readback, including CPU, software GPU, and readback. WebGPU uses an offscreen render target to avoid the headless compositor; WebGL uses canvas readback. This is not presentation latency or physical GPU performance.', results, errors };
};
window.ready = true;
</script></body></html>`;
const server = createServer(async (request, response) => {
  if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); }
  else if (['/current-webgpu.js', '/reference-webgpu.js', '/current-webgl.js', '/reference-webgl.js'].includes(request.url)) { response.setHeader('Content-Type', 'text/javascript'); response.end(await readFile(join(directory, request.url.slice(1)))); }
  else { response.statusCode = 404; response.end(); }
});
server.listen(0, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}`));
process.on('SIGINT', async () => { server.close(); await rm(directory, { recursive: true, force: true }); process.exit(0); });
