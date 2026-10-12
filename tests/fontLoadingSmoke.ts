import assert from 'node:assert/strict';
import { loadFontFamily } from '../resources/js/appearance/FontLoading';

async function main(): Promise<void> {
  const calls: string[] = [];
  let finishSubset!: () => void;
  const subset = new Promise<void>((resolve) => { finishSubset = resolve; });
  const faces = [
    { family: '"JetBrains Mono"', load: () => { calls.push('latin'); return Promise.resolve(); } },
    { family: '"JetBrains Mono"', load: () => { calls.push('cyrillic italic'); return subset; } },
    { family: 'Geist Mono', load: () => { calls.push('unselected'); return Promise.resolve(); } }
  ];
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    fonts: { forEach: (callback: (face: unknown) => void) => faces.forEach(callback) }
  } });
  try {
    let ready = false;
    const loading = loadFontFamily('"JetBrainsMono Nerd Font", "JetBrains Mono", monospace').then(() => { ready = true; });
    await Promise.resolve();
    assert.equal(ready, false, 'measurement must wait for every selected subset and style');
    assert.deepEqual(calls, ['latin', 'cyrillic italic'], 'only selected font families load');
    finishSubset();
    await loading;
    assert.equal(ready, true);
    faces[0]!.load = () => Promise.reject(new Error('asset unavailable'));
    await loadFontFamily('"JetBrains Mono"');
    await loadFontFamily('"Comic Code", monospace');
  } finally {
    Reflect.deleteProperty(globalThis, 'document');
  }
  console.log('font loading smoke passed');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
