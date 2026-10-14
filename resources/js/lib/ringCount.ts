// Fits a subagent count inside a status ring for the current UI font. The count
// is SVG text with an explicit baseline, so nothing snaps it to a pixel; the
// baseline puts the font's digit height on the ring's centre, and a count too
// wide for the ring's opening shrinks to fit. Fonts differ in both, and the UI
// font is a setting, so each font is measured once and measured again when the
// setting changes or a web font finishes loading.

import { ref } from 'vue';

export interface RingCountFit {
  // Font size and SVG baseline in a 14×14 viewBox centred on the ring.
  size: number;
  baseline: number;
}

const BOX = 14;
const SIZE = 8.25;
// The widest ink allowed inside the 16px ring's 12.5px opening.
const MAX_WIDTH = 9.5;
// Measured large, so canvas metrics don't round at the count's small size.
const PROBE = 100;

// Bumped whenever measurements may be stale, so computed fits re-run.
export const ringFontVersion = ref(0);

const cache = new Map<string, RingCountFit>();
let context: CanvasRenderingContext2D | null | undefined;
let watching = false;

function invalidate(): void {
  cache.clear();
  ringFontVersion.value += 1;
}

function watchFont(): void {
  if (watching || typeof document === 'undefined') return;
  watching = true;
  document.fonts?.addEventListener('loadingdone', invalidate);
  // The appearance settings set the UI font as a custom property on the root.
  new MutationObserver(invalidate).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
}

function uiFontFamily(): string {
  const family = getComputedStyle(document.documentElement).getPropertyValue('--patterm-ui-font-family').trim();
  return family || 'Inter, ui-sans-serif, system-ui, sans-serif';
}

export function ringCountFit(text: string, weight = 600): RingCountFit {
  // Read the version so callers in a computed re-run after a font change.
  void ringFontVersion.value;
  watchFont();
  const family = typeof document === 'undefined' ? '' : uiFontFamily();
  const key = `${family}|${weight}|${text}`;
  const cached = cache.get(key);
  if (cached) return cached;
  context ??= typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  let fit: RingCountFit = { size: SIZE, baseline: BOX / 2 + (0.727 * SIZE) / 2 };
  if (context) {
    context.font = `${weight} ${PROBE}px ${family}`;
    const digitHeight = context.measureText('0123456789').actualBoundingBoxAscent / PROBE;
    const width = context.measureText(text).width / PROBE;
    const size = width * SIZE > MAX_WIDTH ? MAX_WIDTH / width : SIZE;
    if (digitHeight > 0) fit = { size, baseline: BOX / 2 + (digitHeight * size) / 2 };
  }
  cache.set(key, fit);
  return fit;
}
