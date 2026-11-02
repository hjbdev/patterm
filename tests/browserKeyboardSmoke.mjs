import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'patchright-core';

const cache = path.join(os.homedir(), '.cache/ms-playwright');
const executablePath = process.env.PATTERM_TEST_CHROME ?? (fs.existsSync(cache)
  ? fs.readdirSync(cache).filter(name => /^chromium-\d+$/.test(name)).sort().reverse()
    .map(name => path.join(cache, name, 'chrome-linux64/chrome')).find(file => fs.existsSync(file))
  : undefined);

test('browser viewer keyboard events insert punctuation and preserve editing keys', { skip: !executablePath && 'Set PATTERM_TEST_CHROME to run live keyboard checks' }, async () => {
  // Use the same conversion as PeekBrowser, then dispatch its output to Chrome.
  const bundle = await build({
    stdin: { contents: 'export { keyEvents } from "./resources/js/lib/browser.ts";', resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'viewerKeyboard', logLevel: 'silent'
  });
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent('<input id="box">');
    await page.evaluate(source => { (0, eval)(source); }, bundle.outputFiles[0].text);
    await page.locator('#box').focus();
    const cdp = await page.context().newCDPSession(page);
    async function press(key, code, modifiers = {}) {
      const events = await page.evaluate(({ key, code, modifiers }) =>
        window.viewerKeyboard.keyEvents(new KeyboardEvent('keydown', { key, code, ...modifiers })), { key, code, modifiers });
      for (const { kind, ...event } of events) await cdp.send('Input.dispatchKeyEvent', event);
    }
    for (const [key, code, modifiers] of [
      ['.', 'Period'], ['>', 'Period', { shiftKey: true }], [',', 'Comma'],
      ['@', 'Digit2', { shiftKey: true }], ['é', 'KeyE'], ['a', 'KeyA'], ['1', 'Digit1']
    ]) {
      await page.locator('#box').fill('');
      await press(key, code, modifiers);
      assert.equal(await page.locator('#box').inputValue(), key, `inserts ${key}`);
    }
    await page.locator('#box').fill('ab');
    await press('ArrowLeft', 'ArrowLeft');
    await press('Delete', 'Delete');
    assert.equal(await page.locator('#box').inputValue(), 'a');
    await press('Backspace', 'Backspace');
    assert.equal(await page.locator('#box').inputValue(), '');
    await page.locator('#box').fill('select me');
    await press('a', 'KeyA', { ctrlKey: true });
    await press('.', 'Period');
    assert.equal(await page.locator('#box').inputValue(), '.', 'Ctrl+A still selects all');
  } finally {
    await browser.close();
  }
});
