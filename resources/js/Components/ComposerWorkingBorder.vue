<template>
  <!-- A comet that runs around the composer's border while the agent works.
       Only transforms and opacity animate, so it runs on the compositor with
       no painting: each straight side is a clip holding a sliding gradient,
       and each corner is the composer's own border arc, faded in and out as
       the comet passes. -->
  <div ref="root" class="composer-comet" aria-hidden="true">
    <template v-for="layer in LAYERS" :key="layer.name">
      <span v-for="side in SIDES" :key="`${layer.name}-${side}`" class="composer-comet-side" :style="sideStyle(layer, side)">
        <span class="composer-comet-bar" :data-bar="`${layer.name}-${side}`" :style="barStyle(layer, side)" />
      </span>
      <span v-for="corner in CORNERS" :key="`${layer.name}-${corner}`" class="composer-comet-corner" :data-corner="`${layer.name}-${corner}`" :style="cornerStyle(layer, corner)" />
    </template>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, type CSSProperties } from 'vue';

// The composer's rounded-xl corner, measured to the middle of its 1px border.
const RADIUS = 11.5;
const QUARTER = (Math.PI * RADIUS) / 2;
// One lap, whatever the composer's size.
const DURATION = 3600;
// Opacity samples per lap for a corner.
const SAMPLES = 240;

interface Layer {
  name: string;
  // Band width, centred on the border.
  width: number;
  // Comet length as a share of the border, and the brightness at its head.
  tail: number;
  peak: number;
}

// A crisp trail on the border, and a short, wider, fainter glow at its head.
const LAYERS: Layer[] = [
  { name: 'trail', width: 1, tail: 0.18, peak: 0.95 },
  { name: 'glow', width: 3, tail: 0.03, peak: 0.25 }
];
type Side = 'top' | 'right' | 'bottom' | 'left';
const SIDES: Side[] = ['top', 'right', 'bottom', 'left'];
type Corner = 'top-right' | 'bottom-right' | 'bottom-left' | 'top-left';
const CORNERS: Corner[] = ['top-right', 'bottom-right', 'bottom-left', 'top-left'];
const HORIZONTAL = new Set<Side>(['top', 'bottom']);
// The comet runs clockwise, so each bar's tail trails towards this end.
const TAIL_END: Record<Side, string> = { top: 'left', right: 'top', bottom: 'right', left: 'bottom' };

const root = ref<HTMLElement>();
let animations: Animation[] = [];
let observer: ResizeObserver | undefined;
// Laps continue from the mount when a resize rebuilds the animations.
let epoch: number | null = null;

// A quadratic fade from the head to nothing at the end of the tail.
function fade(peak: number): string {
  return Array.from({ length: 11 }, (_, step) => `hsl(var(--primary) / ${(peak * (1 - step / 10) ** 2).toFixed(3)}) ${step * 10}%`).join(', ');
}

// Sides cover the straight part of the border, between the corner arcs.
function sideStyle(layer: Layer, side: Side): CSSProperties {
  const band = `${0.5 - layer.width / 2}px`;
  return HORIZONTAL.has(side)
    ? { left: '12px', right: '12px', [side]: band, height: `${layer.width}px` }
    : { top: '12px', bottom: '12px', [side]: band, width: `${layer.width}px` };
}

function barStyle(layer: Layer, side: Side): CSSProperties {
  return {
    [HORIZONTAL.has(side) ? 'height' : 'width']: '100%',
    background: `linear-gradient(to ${TAIL_END[side]}, ${fade(layer.peak)})`
  };
}

// A border arc drawn like the composer's own, so the two match exactly.
function cornerStyle(layer: Layer, corner: Corner): CSSProperties {
  const [vertical, horizontal] = corner.split('-') as ['top' | 'bottom', 'left' | 'right'];
  const size = `${RADIUS + layer.width / 2}px`;
  const outside = `${0.5 - layer.width / 2}px`;
  const capitalised = (value: string): string => value[0]!.toUpperCase() + value.slice(1);
  return {
    [vertical]: outside,
    [horizontal]: outside,
    width: size,
    height: size,
    [`border${capitalised(vertical)}Width`]: `${layer.width}px`,
    [`border${capitalised(horizontal)}Width`]: `${layer.width}px`,
    [`border${capitalised(vertical)}${capitalised(horizontal)}Radius`]: size
  };
}

function build(width: number, height: number): void {
  for (const animation of animations) animation.cancel();
  animations = [];
  const element = root.value;
  // The straight parts of the border's centre line.
  const across = width - 1 - 2 * RADIUS;
  const down = height - 1 - 2 * RADIUS;
  if (!element || across <= 0 || down <= 0) return;
  const lap = 2 * across + 2 * down + 4 * QUARTER;
  // Distance along the border, clockwise from the top side's left end, where
  // each side and each corner begins.
  const sides: Record<Side, { start: number; length: number }> = {
    top: { start: 0, length: across },
    right: { start: across + QUARTER, length: down },
    bottom: { start: across + 2 * QUARTER + down, length: across },
    left: { start: 2 * across + 3 * QUARTER + down, length: down }
  };
  const corners: Record<Corner, number> = {
    'top-right': across,
    'bottom-right': across + QUARTER + down,
    'bottom-left': 2 * across + 2 * QUARTER + down,
    'top-left': 2 * across + 3 * QUARTER + 2 * down
  };
  const run = (target: Element, keyframes: Keyframe[]): void => {
    const animation = target.animate(keyframes, { duration: DURATION, iterations: Infinity, easing: 'linear' });
    animation.startTime = epoch;
    animations.push(animation);
  };
  for (const layer of LAYERS) {
    const tail = layer.tail * lap;
    for (const side of SIDES) {
      const bar = element.querySelector<HTMLElement>(`[data-bar="${layer.name}-${side}"]`);
      if (!bar) continue;
      const { start, length } = sides[side];
      bar.style[HORIZONTAL.has(side) ? 'width' : 'height'] = `${tail}px`;
      // `distance` is how far the head is past the side's start. The bar
      // jumps back a lap once per lap, halfway between its tail leaving the
      // side and its head returning, so the jump never shows.
      const wrap = (length + tail + lap) / 2;
      const first = ((((-start - (wrap - lap)) % lap) + lap) % lap) + wrap - lap;
      const jump = (wrap - first) / lap;
      const axis = HORIZONTAL.has(side) ? 'X' : 'Y';
      // Bars on the bottom and left run backwards along their clip.
      const offset = (distance: number): number => side === 'top' || side === 'right' ? distance - tail : length - distance;
      const at = (progress: number, distance: number): Keyframe => ({ offset: progress, transform: `translate${axis}(${offset(distance)}px)` });
      run(bar, jump < 1
        ? [at(0, first), at(jump, wrap), at(jump, wrap - lap), at(1, first)]
        : [at(0, first), at(1, first + lap)]);
    }
    for (const corner of CORNERS) {
      const arc = element.querySelector(`[data-corner="${layer.name}-${corner}"]`);
      if (!arc) continue;
      const middle = corners[corner] + QUARTER / 2;
      run(arc, Array.from({ length: SAMPLES + 1 }, (_, sample) => {
        // How far the head is past the arc's middle, within half a lap.
        let past = ((((sample / SAMPLES) * lap - middle) % lap) + lap) % lap;
        if (past > lap / 2) past -= lap;
        const opacity = past < -QUARTER / 2 ? 0
          : past < 0 ? layer.peak * (1 + (2 * past) / QUARTER)
            : past < tail ? layer.peak * (1 - past / tail) ** 2 : 0;
        return { offset: sample / SAMPLES, opacity };
      }));
    }
  }
}

onMounted(() => {
  const element = root.value;
  if (!element || typeof element.animate !== 'function' || typeof ResizeObserver === 'undefined') return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const now = document.timeline.currentTime;
  epoch = typeof now === 'number' ? now : 0;
  observer = new ResizeObserver(() => build(element.offsetWidth, element.offsetHeight));
  observer.observe(element);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  for (const animation of animations) animation.cancel();
  animations = [];
});
</script>

<style scoped>
/* Covers the composer's border box. */
.composer-comet {
  position: absolute;
  inset: -1px;
  pointer-events: none;
}

.composer-comet-side {
  position: absolute;
  overflow: hidden;
}

.composer-comet-bar {
  position: absolute;
  top: 0;
  left: 0;
  will-change: transform;
}

.composer-comet-corner {
  position: absolute;
  border: 0 solid hsl(var(--primary));
  opacity: 0;
  /* The transform hint makes the browser round each corner's position to a
     whole pixel, as it does for the moving bars. Without it, at fractional
     zoom the corners keep their subpixel offset and the bars don't, so the
     straight sides drift up to a pixel away from the arcs. */
  will-change: transform, opacity;
}

/* Without motion the border brightens instead. */
@media (prefers-reduced-motion: reduce) {
  .composer-comet {
    border: 1px solid hsl(var(--primary) / 0.3);
    border-radius: 12px;
  }

  .composer-comet > * {
    display: none;
  }
}
</style>
