// Compile first: pnpm exec tsc -p tsconfig.tests.json
// Compares synthetic text with a pre-change Git ref (default HEAD).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { transformSync } from 'esbuild';
import { SecretRedactor } from '../../dist/tests/app/Services/AgentHistory/SecretRedactor.js';

const reference = process.argv[2] ?? 'HEAD';
const source = execFileSync('git', ['show', `${reference}:app/Services/AgentHistory/SecretRedactor.ts`], { encoding: 'utf8' });
const module = { exports: {} };
new Function('module', 'exports', transformSync(source, { loader: 'ts', format: 'cjs' }).code)(module, module.exports);
const before = new module.exports.SecretRedactor();
const after = new SecretRedactor();

let compatibleCases = 0;
for (const left of ['', '"', "'", 'ordinary=', '{', '.', '-', '9', 'é', ' ']) {
  for (const key of ['api_key', 'API-KEY', 'apiKey', 'token', 'secret', 'password', 'credential', 'auth', 'notsecret', 'ordinary', 'authtoken', 'my_token_2']) {
    for (const right of ['', '"', "'", ' ']) {
      for (const separator of ['=', ':', ' : ', '\n=\n']) {
        for (const value of ['abcdefgh', '"abcdefgh"', "'abcdefgh'", 'short', 'token=abcdefgh', 'abcdefgh,token=ijklmnop']) {
          const input = left + key + right + separator + value;
          assert.deepEqual(after.redact(input), before.redact(input), JSON.stringify(input));
          compatibleCases++;
        }
      }
    }
  }
}
console.log(JSON.stringify({ reference, node: process.version, compatibleCases, boundary: 'Warmed redactor only; synthetic text, ten alternating samples after one discarded warm-up. Not worker startup or UI latency.' }));
for (const size of [16_384, 32_768, 65_536]) {
  for (const kind of ['solid', 'spaced']) {
    const input = kind === 'solid' ? 'x'.repeat(size) : 'x '.repeat(size / 2);
    const implementations = [{ name: 'before', redactor: before, samples: [] }, { name: 'after', redactor: after, samples: [] }];
    for (let sample = -1; sample < 10; sample++) {
      for (const implementation of sample % 2 === 0 ? implementations : [...implementations].reverse()) {
        const start = performance.now();
        const result = implementation.redactor.redact(input);
        const elapsed = performance.now() - start;
        assert.deepEqual(result, { text: input, redactionCount: 0 });
        if (sample >= 0) implementation.samples.push(elapsed);
      }
    }
    for (const { name, samples } of implementations) {
      const sorted = [...samples].sort((a, b) => a - b);
      console.log(JSON.stringify({ size, kind, implementation: name, medianMs: (sorted[4] + sorted[5]) / 2, p95Ms: sorted[9], samplesMs: samples }));
    }
  }
}
