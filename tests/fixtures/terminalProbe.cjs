'use strict';
// A portable stand-in for the /bin/sh one-liners the terminal sidecar smoke test
// runs on POSIX, for Windows where there is no /bin/sh, stty, dd, or od.
//
// node terminalProbe.cjs '<JSON array of steps>'
//   {"out": text}                write text to the terminal
//   {"sleep": ms}                wait
//   {"raw": true}                like `stty raw -echo`: no echo, no line editing
//   {"hex": n, "compact": bool}  read n input bytes and print them as `od -An -tx1`
//                                does (" 61 62 63"), or joined without spaces
//   {"line": true}               read one input line and print "submitted:<line>"
//   {"ticks": n, "every": ms}    print tick0 .. tick<n-1>, one every `every` ms
//   {"exit": code}               exit

const steps = JSON.parse(process.argv[2] || '[]');
let pending = Buffer.alloc(0);
let waiting = null;

function write(text) {
  return new Promise((resolve) => process.stdout.write(text, resolve));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function onData(chunk) {
  pending = Buffer.concat([pending, chunk]);
  if (waiting) waiting();
}

// Resolves with the first input bytes for which `take` returns a length.
function read(take) {
  return new Promise((resolve) => {
    const attempt = () => {
      const length = take(pending);
      if (length === null) return;
      waiting = null;
      const bytes = pending.subarray(0, length);
      pending = pending.subarray(length);
      resolve(bytes);
    };
    waiting = attempt;
    attempt();
  });
}

async function main() {
  if (steps.some((step) => 'hex' in step || 'line' in step)) {
    process.stdin.on('data', onData);
    process.stdin.resume();
  }
  for (const step of steps) {
    if ('out' in step) await write(step.out);
    else if ('sleep' in step) await sleep(step.sleep);
    else if ('raw' in step) process.stdin.setRawMode(step.raw);
    else if ('hex' in step) {
      const bytes = await read((buffer) => (buffer.length >= step.hex ? step.hex : null));
      const pairs = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'));
      await write(step.compact ? pairs.join('') : ` ${pairs.join(' ')}\r\n`);
    } else if ('line' in step) {
      process.stdin.setRawMode(true);
      const bytes = await read((buffer) => {
        const end = buffer.findIndex((byte) => byte === 13 || byte === 10);
        return end < 0 ? null : end + 1;
      });
      await write(`submitted:${bytes.subarray(0, bytes.length - 1).toString('utf8')}\r\n`);
    } else if ('ticks' in step) {
      for (let tick = 0; tick < step.ticks; tick++) {
        await write(`tick${tick}\r\n`);
        await sleep(step.every);
      }
    } else if ('exit' in step) process.exit(step.exit);
  }
  process.exit(0);
}

void main();
