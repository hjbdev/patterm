import assert from 'node:assert/strict';

import {
  clampTerminalFontSize,
  nextTerminalFontSize,
  terminalFontSizeShortcutDirection,
  TERMINAL_FONT_SIZE_STORAGE_KEY,
  writeStoredTerminalFontSize,
  readStoredTerminalFontSize
} from '../resources/js/terminal/TerminalFontSize';
import { TerminalInputRouter, keyToTerminalInput, type TerminalInputDispatch, type TerminalKeyboardEventLike } from '../resources/js/terminal/TerminalInputRouter';

interface SentInput extends TerminalInputDispatch {}

class FakeKeyboardEvent implements TerminalKeyboardEventLike {
  public defaultPrevented = false;

  constructor(
    public key: string,
    public ctrlKey = false,
    public metaKey = false,
    public altKey = false,
    public shiftKey = false,
    public code = ''
  ) {}

  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

async function main(): Promise<void> {
  const sink = { value: '' };
  const inputs: SentInput[] = [];
  const controls: string[] = [];
  const router = new TerminalInputRouter(sink, {
    sendInput: (input) => inputs.push(input),
    sendControl: (text) => controls.push(text),
    readClipboard: async () => ({ text: 'from clipboard', hasImage: false, formats: ['text/plain'] })
  });

  const printable = new FakeKeyboardEvent('a');
  assert.equal(router.handleKeydown(printable), false);
  assert.equal(printable.defaultPrevented, false, 'plain text keydown should not block browser text insertion');
  router.handleBeforeInput({
    inputType: 'insertText',
    data: 'a',
    preventDefault() {
      assert.fail('plain insertText should not be prevented');
    }
  });
  sink.value = 'a';
  assert.equal(router.handleInput(), true);
  assert.deepEqual(inputs.pop(), { kind: 'text', text: 'a' });
  assert.equal(sink.value, '', 'committed text clears the hidden sink');

  sink.value = 'dictated words';
  assert.equal(router.handleInput(), true, 'input fallback sends sink value even without beforeinput');
  assert.deepEqual(inputs.pop(), { kind: 'text', text: 'dictated words' });

  let pastePrevented = false;
  assert.equal(router.handleBeforeInput({
    inputType: 'insertFromPaste',
    data: 'pasted',
    preventDefault() {
      pastePrevented = true;
    }
  }), true);
  assert.equal(pastePrevented, true);
  assert.deepEqual(inputs.pop(), { kind: 'paste', text: 'pasted' });

  let clipboardPrevented = false;
  assert.equal(router.handlePaste({
    clipboardData: { getData: () => 'clip event' },
    preventDefault() {
      clipboardPrevented = true;
    }
  }), true);
  assert.equal(clipboardPrevented, true);
  assert.deepEqual(inputs.pop(), { kind: 'paste', text: 'clip event' });

  const enter = new FakeKeyboardEvent('Enter');
  assert.equal(router.handleKeydown(enter), true);
  assert.equal(enter.defaultPrevented, true);
  assert.equal(controls.pop(), '\r');

  const arrow = new FakeKeyboardEvent('ArrowLeft', true);
  assert.equal(router.handleKeydown(arrow), true);
  assert.equal(controls.pop(), '\u001b[1;5D');

  const altX = new FakeKeyboardEvent('x', false, false, true);
  assert.equal(router.handleKeydown(altX), true);
  assert.equal(controls.pop(), '\u001bx');

  const ctrlU = new FakeKeyboardEvent('u', true);
  assert.equal(keyToTerminalInput(ctrlU), '\u0015');

  const ctrlD = new FakeKeyboardEvent('d', true);
  assert.equal(keyToTerminalInput(ctrlD), '\u0004', 'raw terminal routing still maps Ctrl-D to EOF when app shortcuts do not consume it');

  router.handleCompositionStart();
  sink.value = 'partial';
  assert.equal(router.handleInput(), false, 'composition input should wait for compositionend');
  assert.equal(sink.value, 'partial');
  assert.equal(router.handleCompositionEnd({ data: 'compose' }), true);
  assert.deepEqual(inputs.pop(), { kind: 'text', text: 'compose' });
  assert.equal(sink.value, '');

  const pasteShortcut = new FakeKeyboardEvent('v', true);
  assert.equal(router.handleKeydown(pasteShortcut), true);
  assert.equal(pasteShortcut.defaultPrevented, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(inputs.pop(), { kind: 'paste', text: 'from clipboard' });

  const imageControls: string[] = [];
  const imageRouter = new TerminalInputRouter(sink, {
    sendInput: (input) => inputs.push(input),
    sendControl: (text) => imageControls.push(text),
    readClipboard: async () => ({ text: '', hasImage: true, formats: ['image/png'] })
  });
  const imagePasteShortcut = new FakeKeyboardEvent('v', true, false, false, true);
  assert.equal(imageRouter.handleKeydown(imagePasteShortcut), true);
  assert.equal(imagePasteShortcut.defaultPrevented, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(imageControls.pop(), '\u0016', 'image-only shortcut forwards Ctrl-V to the PTY for agent-native paste handling');

  let imagePastePrevented = false;
  assert.equal(imageRouter.handlePaste({
    clipboardData: { getData: () => '', types: ['image/png'] },
    preventDefault() {
      imagePastePrevented = true;
    }
  }), true);
  assert.equal(imagePastePrevented, true);
  assert.equal(imageControls.pop(), '\u0016', 'image-only paste events forward Ctrl-V to the PTY');

  const emptyRouter = new TerminalInputRouter(sink, {
    sendInput: (input) => inputs.push(input),
    sendControl: (text) => imageControls.push(text),
    readClipboard: async () => ({ text: '', hasImage: false, formats: [] })
  });
  const emptyPasteShortcut = new FakeKeyboardEvent('v', true);
  assert.equal(emptyRouter.handleKeydown(emptyPasteShortcut), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(imageControls.length, 0, 'empty clipboard does not dispatch terminal input');

  assert.equal(clampTerminalFontSize(8), 10);
  assert.equal(clampTerminalFontSize(30), 24);
  assert.equal(clampTerminalFontSize(Number.NaN), 14);
  assert.equal(nextTerminalFontSize(14, 'increase'), 15);
  assert.equal(nextTerminalFontSize(14, 'decrease'), 13);
  assert.equal(nextTerminalFontSize(24, 'increase'), 24);
  assert.equal(nextTerminalFontSize(10, 'decrease'), 10);
  assert.equal(terminalFontSizeShortcutDirection(new FakeKeyboardEvent('=', true)), 'increase');
  assert.equal(terminalFontSizeShortcutDirection(new FakeKeyboardEvent('+', true)), 'increase');
  assert.equal(terminalFontSizeShortcutDirection(new FakeKeyboardEvent('Add', true, false, false, false, 'NumpadAdd')), 'increase');
  assert.equal(terminalFontSizeShortcutDirection(new FakeKeyboardEvent('-', true)), 'decrease');
  assert.equal(terminalFontSizeShortcutDirection(new FakeKeyboardEvent('Subtract', true, false, false, false, 'NumpadSubtract')), 'decrease');
  assert.equal(terminalFontSizeShortcutDirection(new FakeKeyboardEvent('=', false)), null);
  assert.equal(terminalFontSizeShortcutDirection(new FakeKeyboardEvent('=', true, true)), null);
  assert.equal(terminalFontSizeShortcutDirection(new FakeKeyboardEvent('=', true, false, true)), null);

  const storage = new Map<string, string>();
  const storageLike = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    }
  };
  assert.equal(readStoredTerminalFontSize(storageLike), 14);
  writeStoredTerminalFontSize(30, storageLike);
  assert.equal(storage.get(TERMINAL_FONT_SIZE_STORAGE_KEY), '24');
  assert.equal(readStoredTerminalFontSize(storageLike), 24);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
