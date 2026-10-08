import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { createRendererHarness, loadRendererModule, snapshot } from '../../tests/terminalRendererHarness.mjs';

const sources = process.argv.slice(2);
if (sources.length === 0) sources.push('resources/js/terminal/TerminalRenderer.ts');
const implementations = await Promise.all(sources.map(async (source) => ({ source, ...await loadRendererModule(source) })));
const samples = 10;
const iterations = 20;
const percentile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return fraction === 0.5 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[Math.ceil(values.length * fraction) - 1];
};
const results = [];
for (const backend of ['webgpu', 'webgl']) {
  for (const [workload, cols, rows] of [['text', 120, 40], ['text', 240, 80], ['styled', 120, 40], ['blocks', 120, 40], ['unicode', 120, 40]]) {
    const frame = snapshot(cols, rows, workload, workload === 'unicode' ? 0x4e00 : 33);
    const measurements = implementations.map((implementation) => ({ ...implementation, cold: [], warm: [], metrics: null }));
    for (let sample = 0; sample < samples; sample += 1) {
      // Alternate implementations to reduce bias from run order and host load.
      for (const measurement of sample % 2 === 0 ? measurements : [...measurements].reverse()) {
        const harness = await createRendererHarness(measurement.TerminalRenderer, { backend, cols, rows });
        const start = performance.now();
        harness.renderer.applyDamageFrame(frame, 'p');
        measurement.cold.push(performance.now() - start);
        for (let index = 0; index < 10; index += 1) harness.renderer.renderCurrentState();
        harness.reset();
        const warmed = performance.now();
        for (let index = 0; index < iterations; index += 1) harness.renderer.renderCurrentState();
        measurement.warm.push((performance.now() - warmed) / iterations);
        measurement.metrics = harness.metrics();
        harness.renderer.dispose();
      }
    }
    for (const { source, cold, warm, metrics } of measurements) {
      results.push({ source, backend, workload, cols, rows, coldMedianMs: percentile(cold, 0.5), coldP95Ms: percentile(cold, 0.95), warmMedianMs: percentile(warm, 0.5), warmP95Ms: percentile(warm, 0.95), uploadBytesPerFrame: metrics.uploadedBytes / iterations, coldSamplesMs: cold, warmSamplesMs: warm });
    }
  }
}
const decoderResults = [];
const { parseDamageFrame } = implementations[0];
for (const [cols, rows, sparse] of [[120, 40, false], [240, 80, false], [240, 80, true]]) {
  const frame = snapshot(sparse ? 1 : cols, sparse ? 1 : rows);
  if (sparse) {
    frame.writeUInt8(1, 2);
    frame.writeUInt16LE(cols, 18);
    frame.writeUInt16LE(rows, 20);
  }
  const decoder = new TextDecoder();
  for (let index = 0; index < 100; index += 1) parseDamageFrame(frame, decoder);
  const times = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const start = performance.now();
    for (let index = 0; index < 200; index += 1) {
      if (!parseDamageFrame(frame, decoder)) throw new Error('Invalid benchmark frame');
    }
    times.push((performance.now() - start) / 200);
  }
  decoderResults.push({ source: implementations[0].source, cols, rows, sparse, bytes: frame.byteLength, medianMs: percentile(times, 0.5), p95Ms: percentile(times, 0.95), samplesMs: times });
}
console.log(JSON.stringify({ node: process.version, cpu: cpus()[0].model, samples, iterations, boundary: 'CPU renderer with stub GPU/canvas; cold is the first frame of a fresh renderer and includes snapshot decoding; warm samples are means of 20 repaints and exclude decoding; no GPU or rasterisation timing', results, decoderResults }, null, 2));
