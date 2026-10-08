import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function loadRendererModule(source = 'resources/js/terminal/TerminalRenderer.ts') {
  const directory = await mkdtemp(join(tmpdir(), 'patterm-renderer-'));
  const output = join(directory, 'renderer.mjs');
  try {
    await build({ entryPoints: [source], outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    return await import(pathToFileURL(output).href);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Exercise the production renderer and vertex uploads. Canvas rasterisation and
// GPU calls are stubs, so timings measure CPU work, not browser or GPU latency.
export async function createRendererHarness(Renderer, { backend = 'webgpu', cols = 120, rows = 40, maxTextureSize = 4096, capture = false } = {}) {
  const uploads = [];
  const glyphs = [];
  const textures = [];
  let uploadedBytes = 0;
  let atlasUploads = 0;
  let atlasUploadBytes = 0;
  let rasterisedGlyphs = 0;
  let submittedVertices = 0;
  const upload = (data) => {
    uploadedBytes += data.byteLength ?? data;
    if (capture) uploads.push(Array.from(data));
  };
  const texture = { createView: () => ({}) };
  const pass = { end() {}, setBindGroup() {}, setPipeline() {}, setVertexBuffer() {}, draw(count) { submittedVertices += count; } };
  const device = {
    limits: { maxTextureDimension2D: maxTextureSize },
    queue: { submit() {}, writeBuffer: (_buffer, _offset, data) => upload(data), copyExternalImageToTexture(_source, _destination, [width, height]) { atlasUploads += 1; atlasUploadBytes += width * height * 4; } },
    createBindGroup: () => ({}), createBuffer: () => ({ destroy() {} }),
    createCommandEncoder: () => ({ beginRenderPass: () => pass, finish: () => ({}) }),
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createSampler: () => ({}), createShaderModule: () => ({}), createTexture: (descriptor) => { textures.push(descriptor); return texture; },
  };
  const context2d = {
    measureText: () => ({ width: 9 }), clearRect() {}, drawImage() {}, getImageData: (_x, _y, width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
    fillText(char, x, y) { rasterisedGlyphs += 1; if (capture) glyphs.push([char, this.font, x, y]); },
  };
  const gl = new Proxy({
    getShaderParameter: () => true, getProgramParameter: () => true,
    getParameter: () => maxTextureSize,
    drawArrays(_mode, _first, count) { submittedVertices += count; },
    bufferData: (_target, data) => upload(data),
    bufferSubData: (_target, _offset, data) => upload(data),
    texImage2D(...args) { const canvas = args.at(-1); atlasUploads += 1; atlasUploadBytes += canvas.width * canvas.height * 4; },
    texSubImage2D(...args) { const canvas = args.at(-1); atlasUploads += 1; atlasUploadBytes += canvas.width * canvas.height * 4; },
  }, { get(target, key) {
    if (key in target) return target[key];
    if (typeof key === 'string' && key.toUpperCase() === key) return 1;
    return () => ({});
  } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: backend === 'webgpu' ? { gpu: { requestAdapter: async () => ({ requestDevice: async () => device }) } } : {} });
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.HTMLCanvasElement = class { getContext() {} };
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => context2d }) };
  const canvas = {
    width: cols * 9, height: rows * 18,
    getBoundingClientRect() { return { width: this.width, height: this.height }; },
    getContext: (kind) => kind === 'webgpu' ? { configure() {}, getCurrentTexture: () => texture } : gl,
  };
  const renderer = new Renderer(canvas);
  renderer.mount();
  await new Promise((resolve) => setImmediate(resolve));
  return { renderer, canvas, uploads, glyphs, textures, metrics: () => ({ uploadedBytes, atlasUploads, atlasUploadBytes, rasterisedGlyphs, submittedVertices }), reset() { uploads.length = 0; glyphs.length = 0; uploadedBytes = 0; atlasUploads = 0; atlasUploadBytes = 0; rasterisedGlyphs = 0; submittedVertices = 0; } };
}

export function snapshot(cols, rows, workload = 'text', startCodepoint = 33) {
  const payload = Buffer.alloc(30 + rows * (6 + cols * 16));
  let offset = 0;
  const u8 = (value) => { payload.writeUInt8(value, offset); offset += 1; };
  const u16 = (value) => { payload.writeUInt16LE(value, offset); offset += 2; };
  const u32 = (value) => { payload.writeUInt32LE(value, offset); offset += 4; };
  u16(2); u8(0); u32(1); u32(1); u32(0); u16(1); u8(112);
  u16(cols); u16(rows); u16(0); u16(0); u8(1); u8(0); u16(rows);
  for (let row = 0; row < rows; row += 1) {
    u16(row); u16(0); u16(cols);
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col;
      const codepoint = workload === 'blocks' ? 0x2580 + index % 32 : workload === 'unicode' ? startCodepoint + index : startCodepoint + index % (workload === 'variants' ? 3 : 90);
      u32(codepoint); u16(workload === 'styled' || workload === 'variants' ? index % 16 : 0);
      u8(2); u32(workload === 'styled' ? (index * 7919) % 0xffffff : 0xfafafa);
      u8(2); u32(workload === 'styled' ? (index * 31) % 0xffffff : 0x151515);
    }
  }
  return payload;
}

export function damage(cols, rows, { row = 0, col = 0, codepoint = 65, cursorRow = 0, cursorCol = 0, cursorShape = 0 } = {}) {
  const frame = snapshot(1, 1, 'text', codepoint);
  frame.writeUInt8(1, 2);
  frame.writeUInt16LE(cols, 18);
  frame.writeUInt16LE(rows, 20);
  frame.writeUInt16LE(cursorCol, 22);
  frame.writeUInt16LE(cursorRow, 24);
  frame.writeUInt8(cursorShape, 27);
  frame.writeUInt16LE(row, 30);
  frame.writeUInt16LE(col, 32);
  return frame;
}
