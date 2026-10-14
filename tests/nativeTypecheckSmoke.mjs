import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);

function fixture(t, project, extension) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-typecheck-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const source = path.join(directory, `probe.${extension}`);
  const config = path.join(directory, 'tsconfig.json');
  fs.writeFileSync(config, JSON.stringify({
    extends: path.join(root, `tsconfig.${project}.json`), include: [source],
    compilerOptions: { rootDir: directory, noEmit: true, incremental: true, tsBuildInfoFile: path.join(directory, 'state.tsbuildinfo') }
  }));
  const cli = require.resolve(project === 'renderer' ? 'vue-tsc/bin/vue-tsc.js' : 'typescript/bin/tsc');
  const run = () => {
    const result = spawnSync(process.execPath, [cli, '-p', config], { encoding: 'utf8', timeout: 45_000 });
    assert.ifError(result.error);
    return { status: result.status, output: result.stdout + result.stderr };
  };
  return { source, run };
}

test('strict TypeScript checks reject errors introduced after a warm incremental pass', t => {
  const { source, run } = fixture(t, 'main', 'ts');
  const good = 'export const value: string = "valid";';
  fs.writeFileSync(source, good);
  let result = run();
  assert.equal(result.status, 0, result.output);
  fs.writeFileSync(source, [
    'export const value: string = 123;',
    "export const indexed: string = ['value'][2];",
    'export const optional: { value?: string } = { value: undefined };',
    'class Base { method() {} }',
    'export class Derived extends Base { method() {} }'
  ].join('\n'));
  result = run();
  assert.notEqual(result.status, 0, result.output);
  for (const code of ['TS2322', 'TS2375', 'TS4114']) assert.match(result.output, new RegExp(code), result.output);
  assert.match(result.output, /probe\.ts\(2,\d+\): error TS2322/, 'unchecked index access is rejected');
  fs.writeFileSync(source, good);
  result = run();
  assert.equal(result.status, 0, result.output);
});

test('Vue checks reject script and template errors introduced after a warm incremental pass', t => {
  const { source, run } = fixture(t, 'renderer', 'vue');
  const good = '<script setup lang="ts">defineProps<{ count: number }>();</script><template>{{ count.toFixed() }}</template>';
  fs.writeFileSync(source, good);
  let result = run();
  assert.equal(result.status, 0, result.output);
  fs.writeFileSync(source, '<script setup lang="ts">const value: string = 123; defineProps<{ count: number }>();</script><template>{{ count.toUpperCase() }}</template>');
  result = run();
  assert.notEqual(result.status, 0, result.output);
  for (const code of ['TS2322', 'TS2339']) assert.match(result.output, new RegExp(code), result.output);
  assert.match(result.output, /probe\.vue/, result.output);
  fs.writeFileSync(source, good);
  result = run();
  assert.equal(result.status, 0, result.output);
});

test('Vue checks preserve prop types across imported components after a warm pass', t => {
  const { source, run } = fixture(t, 'renderer', 'vue');
  fs.writeFileSync(path.join(path.dirname(source), 'Child.vue'), '<script setup lang="ts">defineProps<{ count: number }>();</script><template>{{ count.toFixed() }}</template>');
  const component = value => `<script setup lang="ts">import Child from './Child.vue'; const count = ${value};</script><template><Child :count="count" /></template>`;
  fs.writeFileSync(source, component('123'));
  let result = run();
  assert.equal(result.status, 0, result.output);
  fs.writeFileSync(source, component('"invalid"'));
  result = run();
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /TS2322/, result.output);
  assert.match(result.output, /probe\.vue/, result.output);
  fs.writeFileSync(source, component('123'));
  result = run();
  assert.equal(result.status, 0, result.output);
});
