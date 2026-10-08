import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

test('settings autosave reports each setting and section by key', async () => {
  const output = path.resolve('dist/tests/settings-autosave-fixture.cjs');
  await build({
    entryPoints: [path.resolve('resources/js/Composables/useSettingsAutosave.ts')],
    outfile: output, bundle: true, platform: 'node', format: 'cjs', external: ['vue']
  });
  const { autosave, settingSaveStatus, sectionSaveStatus, resetSettingsSaveStatus } = createRequire(import.meta.url)(output);
  try {
    let finish;
    const saving = autosave('appearance.terminal.font', () => new Promise((resolve) => { finish = resolve; }));
    assert.equal(settingSaveStatus('appearance.terminal.font')?.state, 'saving');
    assert.equal(sectionSaveStatus('appearance.terminal').state, 'saving');
    assert.equal(sectionSaveStatus('appearance.interface').state, 'idle');
    finish();
    assert.equal(await saving, true);
    assert.equal(sectionSaveStatus('appearance').state, 'saved');

    // A failure stays visible while other settings save, until it saves itself.
    assert.equal(await autosave('summaries.enabled', async () => { throw new Error('offline'); }), false);
    await autosave('summaries.model', async () => {});
    assert.deepEqual(sectionSaveStatus('summaries'), { state: 'error', error: 'offline' });
    assert.equal(settingSaveStatus('summaries.enabled')?.error, 'offline');
    await autosave('summaries.enabled', async () => {});
    assert.equal(sectionSaveStatus('summaries').state, 'saved');

    // When one setting saves twice at once, the newer save decides.
    let failOlder;
    const older = autosave('notifications.delivery.toasts', () => new Promise((_, reject) => { failOlder = reject; }));
    assert.equal(await autosave('notifications.delivery.toasts', async () => {}), true);
    failOlder(new Error('stale'));
    assert.equal(await older, false);
    assert.equal(settingSaveStatus('notifications.delivery.toasts')?.state, 'saved');
  } finally {
    resetSettingsSaveStatus();
    fs.unlinkSync(output);
  }
});
