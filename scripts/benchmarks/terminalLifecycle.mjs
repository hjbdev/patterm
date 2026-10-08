// Linux RSS stress test against a real sidecar and PTYs. Run with the baseline
// and optimised release binaries as arguments. Each sample starts a fresh sidecar.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const [before, after] = process.argv.slice(2);
assert.ok(before && after, 'usage: node scripts/benchmarks/terminalLifecycle.mjs BASELINE_BINARY OPTIMISED_BINARY');
const cycles = 12;
const samples = 10;

function sidecar(binary) {
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  let nextId = 0;
  let buffered = Buffer.alloc(0);
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4 && buffered.length >= buffered.readUInt32LE(0) + 4) {
      const size = buffered.readUInt32LE(0);
      const frame = buffered.subarray(4, size + 4);
      buffered = buffered.subarray(size + 4);
      if (frame[0] !== 1) continue;
      const response = JSON.parse(frame.subarray(1));
      const request = pending.get(response.id);
      if (!request) continue;
      pending.delete(response.id);
      clearTimeout(request.timer);
      if (response.error) request.reject(new Error(response.error));
      else request.resolve(response.result);
    }
  });
  return {
    child,
    request(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 10_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
  };
}

function rss(pid) {
  return Number(readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+) kB$/m)[1]) * 1024;
}

const results = { benchmark: 'terminal_lifecycle_rss', samples, cycles, cols: 240, rows: 80, output_lines_per_cycle: 3000, before: [], after: [] };
for (let sample = 0; sample < samples; sample++) {
  // Alternate order to reduce systematic effects from host activity.
  for (const [name, binary] of sample % 2 ? [['after', after], ['before', before]] : [['before', before], ['after', after]]) {
    const core = sidecar(binary);
    try {
      await core.request('terminal.ping');
      const initial = rss(core.child.pid);
      const bytes = [];
      for (let cycle = 0; cycle < cycles; cycle++) {
        const { process_id } = await core.request('terminal.process.spawn', {
          command: process.execPath,
          args: ['-e', "process.stdout.write(('x'.repeat(239)+'\\r\\n').repeat(3000)+'READY'); setInterval(() => {}, 1000)"],
          cols: 240, rows: 80,
        });
        const deadline = Date.now() + 10_000;
        while (!(await core.request('terminal.process.output', { process_id, max_lines: 1 })).screen.includes('READY')) {
          assert.ok(Date.now() < deadline, 'PTY finished producing scrollback');
          await delay(5);
        }
        await core.request('terminal.process.stop', { process_id });
        if (name === 'after') await core.request('terminal.process.close', { process_id });
        // Allow the PTY reader to consume Shutdown and drop its final reference.
        await delay(25);
        bytes.push(rss(core.child.pid));
      }
      results[name].push({ initial_bytes: initial, rss_bytes_after_each_close: bytes, retained_bytes: bytes.at(-1) - initial });
    } finally {
      core.child.kill();
    }
  }
}
for (const name of ['before', 'after']) {
  const sorted = results[name].map((sample) => sample.retained_bytes).sort((a, b) => a - b);
  results[`${name}_summary`] = { median_retained_bytes: (sorted[4] + sorted[5]) / 2, p95_retained_bytes: sorted[9] };
}
console.log(JSON.stringify(results, null, 2));
