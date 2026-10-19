import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const canvas = fs.readFileSync(new URL('../resources/js/Components/Canvas/ProjectCanvas.vue', import.meta.url), 'utf8');
const card = fs.readFileSync(new URL('../resources/js/Components/Canvas/CanvasCard.vue', import.meta.url), 'utf8');

test('the canvas takes the pointer from a card without ending the drag', () => {
  // Touch captures the pointer to the card first; handing it to the canvas
  // fires lostpointercapture on the card, which bubbles. Only the canvas's own
  // loss ends a press.
  assert.match(canvas, /@lostpointercapture\.self="onPointerUp"/);
  assert.doesNotMatch(canvas, /@lostpointercapture="/);
});

test('a press released outside the canvas ends on the next move', () => {
  assert.match(canvas, /if \(!\(event\.buttons & 1\)\) return onPointerUp\(event\);/);
});

test('only keyboard focus pans a card into view', () => {
  assert.match(card, /@focus="onFocus"/);
  assert.match(card, /matches\(':focus-visible'\)\) emit\('focus'/);
});
