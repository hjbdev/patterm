import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { createRendererHarness, loadRendererModule, snapshot, damage } from '../../tests/terminalRendererHarness.mjs';

const sources = process.argv.slice(2);
if (!sources.length) sources.push('resources/js/terminal/TerminalRenderer.ts');
const implementations = await Promise.all(sources.map(async (source) => ({ source, ...await loadRendererModule(source) })));
const samples = 10;
const iterations = 20;
const percentile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  return fraction === 0.5 ? (sorted[4] + sorted[5]) / 2 : sorted[9];
};
const results = [];
for (const backend of ['webgpu', 'webgl']) {
  for (const workload of ['sparse-text', 'sparse-styled', 'sparse-insert', 'sparse-screen', 'full-damage', 'new-glyph', 'overflow']) {
    const overflow = workload === 'overflow';
    const cols = overflow ? 16 : 240;
    const rows = overflow ? 4 : 80;
    const frame = snapshot(cols, rows, overflow ? 'unicode' : ['sparse-styled', 'sparse-screen'].includes(workload) ? 'styled' : 'text', overflow ? 0x4e00 : 33);
    if (['sparse-insert', 'sparse-screen'].includes(workload)) {
      for (let row = 0; row < rows; row += 1) for (let col = 0; col < cols; col += 1) {
        if (workload === 'sparse-insert' ? row !== 3 : row === 0) continue;
        const offset = 30 + row * (6 + cols * 16) + 6 + col * 16;
        frame.writeUInt32LE(32, offset); frame.writeUInt16LE(0, offset + 4);
        frame.writeUInt32LE(0x151515, offset + 12);
      }
    }
    const measurements = implementations.map((implementation) => ({ ...implementation, cold: [], warm: [], metrics: null }));
    for (let sample = 0; sample < samples; sample += 1) {
      for (const measurement of sample % 2 === 0 ? measurements : [...measurements].reverse()) {
        const harness = await createRendererHarness(measurement.TerminalRenderer, { backend, cols, rows, maxTextureSize: overflow ? 128 : 4096 });
        let start = performance.now();
        harness.renderer.applyDamageFrame(frame, 'p');
        measurement.cold.push(performance.now() - start);
        const frames = Array.from({ length: 30 }, (_, index) => damage(cols, rows, { row: workload === 'sparse-screen' ? 0 : Math.min(3, rows - 1), col: workload === 'sparse-insert' ? index : 1, codepoint: workload === 'new-glyph' ? 0x400 + index : 65 + index % 2 }));
        for (let index = 0; index < 10; index += 1) overflow ? harness.renderer.renderCurrentState() : harness.renderer.applyDamageFrame(workload === 'full-damage' ? frame : frames[index], 'p');
        harness.reset();
        start = performance.now();
        for (let index = 0; index < iterations; index += 1) overflow ? harness.renderer.renderCurrentState() : harness.renderer.applyDamageFrame(workload === 'full-damage' ? frame : frames[index + 10], 'p');
        measurement.warm.push((performance.now() - start) / iterations);
        measurement.metrics = harness.metrics();
        const backendState = harness.renderer.backend;
        measurement.cachedGeometryBytes = ['colorGeometry', 'glyphGeometry', 'underlineGeometry'].reduce((sum, key) => sum + (backendState[key]?.data.byteLength ?? 0), 0);
        harness.renderer.dispose();
      }
    }
    for (const { source, cold, warm, metrics, cachedGeometryBytes } of measurements) results.push({ source, backend, workload, cols, rows, cachedGeometryBytes, coldMedianMs: percentile(cold, 0.5), coldP95Ms: percentile(cold, 0.95), warmMedianMs: percentile(warm, 0.5), warmP95Ms: percentile(warm, 0.95), ...Object.fromEntries(Object.entries(metrics).map(([key, value]) => [`${key}PerFrame`, value / iterations])), coldSamplesMs: cold, warmSamplesMs: warm });
  }
}
console.log(JSON.stringify({ node: process.version, cpu: cpus()[0].model, samples, iterations, boundary: 'Production renderer with stub GPU and canvas. CPU timings include damage decoding and upload preparation, not rasterisation or GPU execution. Cold is a fresh snapshot; warm samples average 20 frames after 10 warm-up frames.', results }, null, 2));
