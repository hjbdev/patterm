// Compile with pnpm exec tsc -p tsconfig.tests.json before running this file.
// Measures the production pipe framing path. It excludes OS I/O and client rendering.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { TerminalService } from '../../dist/tests/app/Services/TerminalService.js';

const samples = 10;
const iterations = 1000;
function frame(cols, rows, cells) {
  const runCount = Math.ceil(cells / cols);
  const payload = Buffer.alloc(35 + runCount * 6 + cells * 16);
  payload.writeUInt16LE(2, 0);
  payload[2] = 1;
  payload.writeUInt32LE(1, 3);
  payload.writeUInt32LE(1, 7);
  payload.writeUInt16LE(6, 15);
  payload.write('proc_1', 17);
  payload.writeUInt16LE(cols, 23);
  payload.writeUInt16LE(rows, 25);
  payload[31] = 1;
  payload.writeUInt16LE(runCount, 33);
  let offset = 35;
  for (let row = 0; row < runCount; row++) {
    const count = Math.min(cols, cells - row * cols);
    payload.writeUInt16LE(row, offset);
    payload.writeUInt16LE(count, offset + 4);
    offset += 6;
    for (let col = 0; col < count; col++, offset += 16) {
      payload.writeUInt32LE(65 + col % 26, offset);
      payload.writeUInt32LE(256, offset + 7);
      payload.writeUInt32LE(257, offset + 12);
    }
  }
  const framed = Buffer.alloc(payload.length + 5);
  framed.writeUInt32LE(payload.length + 1, 0);
  framed[4] = 5;
  payload.copy(framed, 5);
  return { framed, payload };
}

for (const [name, cols, rows, cells] of [
  ['cursor', 80, 24, 0], ['single_cell', 80, 24, 1],
  ['full_80x24', 80, 24, 1920], ['full_240x80', 240, 80, 19200],
]) {
  const { framed, payload } = frame(cols, rows, cells);
  for (const chunkSize of [framed.length, 4096, 65536]) {
    if (chunkSize !== framed.length && chunkSize >= framed.length) continue;
    const chunks = [];
    for (let offset = 0; offset < framed.length; offset += chunkSize) chunks.push(framed.subarray(offset, offset + chunkSize));
    let received = 0;
    let latest;
    const terminal = new TerminalService('', { write() {} });
    terminal.onFrame((frame) => { received++; latest = frame; });
    const timings = [];
    for (let sample = 0; sample <= samples; sample++) {
      const start = performance.now();
      for (let iteration = 0; iteration < iterations; iteration++) {
        for (const chunk of chunks) terminal.handleStdout(chunk);
      }
      const elapsed = (performance.now() - start) * 1000 / iterations;
      if (sample > 0) timings.push(elapsed);
    }
    assert.equal(received, (samples + 1) * iterations);
    assert.equal(latest.processId, 'proc_1');
    assert.deepEqual(Buffer.from(latest.payload), payload);
    timings.sort((a, b) => a - b);
    console.log(JSON.stringify({ name, chunkSize, payloadBytes: payload.length, samples, iterations,
      median_us: (timings[4] + timings[5]) / 2, p95_us: timings[9], samples_us: timings }));
  }
}
