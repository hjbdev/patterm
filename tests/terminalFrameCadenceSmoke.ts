import assert from 'node:assert/strict';

import {
  BACKGROUND_VISIBLE_TERMINAL_FRAME_INTERVAL_MS,
  clampForegroundFrameInterval,
  shouldSubscribeTerminalFrames,
  terminalFrameIntervalForMode,
  terminalFrameMode
} from '../resources/js/terminal/TerminalFrameCadence';

function main(): void {
  const foreground = terminalFrameMode({ visibilityState: 'visible', hasFocus: true });
  assert.equal(foreground, 'foreground');
  assert.equal(shouldSubscribeTerminalFrames(foreground), true);
  assert.equal(terminalFrameIntervalForMode(foreground, 8.4), 8.4);

  const backgroundVisible = terminalFrameMode({ visibilityState: 'visible', hasFocus: false });
  assert.equal(backgroundVisible, 'background-visible');
  assert.equal(shouldSubscribeTerminalFrames(backgroundVisible), true);
  assert.equal(
    terminalFrameIntervalForMode(backgroundVisible, 8.4),
    BACKGROUND_VISIBLE_TERMINAL_FRAME_INTERVAL_MS,
    'visible unfocused terminals use the low-fps cadence'
  );

  const hidden = terminalFrameMode({ visibilityState: 'hidden', hasFocus: false });
  assert.equal(hidden, 'hidden');
  assert.equal(shouldSubscribeTerminalFrames(hidden), false);
  assert.equal(terminalFrameIntervalForMode(hidden, 8.4), null);

  assert.equal(clampForegroundFrameInterval(1), 2);
  assert.equal(clampForegroundFrameInterval(4.2), 4.2);
  assert.equal(clampForegroundFrameInterval(50), 33);
}

main();
