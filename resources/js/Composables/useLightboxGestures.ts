import { computed, ref, type Ref } from 'vue';

// Touch gestures for the image lightbox: pinch or double-tap to zoom, drag to
// pan a zoomed image, swipe sideways to step through the gallery, swipe down
// to close and tap to toggle the overlay controls. Mouse input is left alone.

const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2.5;
const TAP_SLOP = 10;
const DOUBLE_TAP_MS = 280;
const SWIPE_RATIO = 0.18;
const FLICK_VELOCITY = 0.45;
const DISMISS_DISTANCE = 110;
const SETTLE_MS = 180;

interface Point { x: number; y: number }

export function useLightboxGestures(stage: Ref<HTMLElement | null>, image: Ref<HTMLElement | null>, options: {
  canStep: () => boolean;
  onStep: (delta: number) => void;
  onDismiss: () => void;
  onTap: () => void;
}) {
  const scale = ref(1);
  const pan = ref<Point>({ x: 0, y: 0 });
  const drag = ref<Point>({ x: 0, y: 0 });
  const active = ref(false);
  const pointers = new Map<number, Point>();
  let axis: 'x' | 'y' | null = null;
  let start: Point = { x: 0, y: 0 };
  let startPan: Point = { x: 0, y: 0 };
  let startTime = 0;
  let moved = false;
  // Set when a pinch at 1x leaves one finger down, so it can't start a swipe.
  let inert = false;
  // A slide owns `drag` from the swipe until the next image settles.
  let sliding = false;
  let pinch: { distance: number; scale: number; anchor: Point } | null = null;
  let lastTap: { time: number; point: Point } | null = null;
  let tapTimer: ReturnType<typeof setTimeout> | undefined;
  let stepTimer: ReturnType<typeof setTimeout> | undefined;

  const imageStyle = computed(() => ({
    transform: `translate3d(${pan.value.x + drag.value.x}px, ${pan.value.y + drag.value.y}px, 0) scale(${scale.value})`,
    transition: active.value ? 'none' : `transform ${SETTLE_MS}ms ease-out`,
  }));
  // Fades the viewer while it is pulled down to close.
  const backdropOpacity = computed(() => Math.max(0.25, 1 - Math.max(0, drag.value.y) / 400));

  function centre(): Point {
    const rect = stage.value?.getBoundingClientRect();
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : { x: 0, y: 0 };
  }

  function pair(): [Point, Point] {
    const [a, b] = [...pointers.values()];
    return [a ?? start, b ?? a ?? start];
  }

  function midpoint(): Point {
    const [a, b] = pair();
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function spread(): number {
    const [a, b] = pair();
    return Math.hypot(a.x - b.x, a.y - b.y) || 1;
  }

  // Keeps a zoomed image covering the stage instead of sliding off it.
  function clampPan(next: Point, atScale: number): Point {
    const box = stage.value?.getBoundingClientRect();
    const img = image.value;
    if (!box || !img) return next;
    const limitX = Math.max(0, (img.offsetWidth * atScale - box.width) / 2);
    const limitY = Math.max(0, (img.offsetHeight * atScale - box.height) / 2);
    return { x: Math.min(limitX, Math.max(-limitX, next.x)), y: Math.min(limitY, Math.max(-limitY, next.y)) };
  }

  // Zooms so the image point under `screen` stays under it.
  function zoomAt(screen: Point, nextScale: number, from: { scale: number; pan: Point; anchor: Point } = { scale: scale.value, pan: pan.value, anchor: screen }): void {
    const origin = centre();
    const content = { x: (from.anchor.x - origin.x - from.pan.x) / from.scale, y: (from.anchor.y - origin.y - from.pan.y) / from.scale };
    scale.value = nextScale;
    pan.value = { x: screen.x - origin.x - content.x * nextScale, y: screen.y - origin.y - content.y * nextScale };
  }

  function reset(): void {
    clearTimeout(tapTimer);
    clearTimeout(stepTimer);
    sliding = false;
    pointers.clear();
    pinch = null;
    lastTap = null;
    active.value = false;
    scale.value = 1;
    pan.value = { x: 0, y: 0 };
    drag.value = { x: 0, y: 0 };
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.pointerType === 'mouse') return;
    stage.value?.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    active.value = true;
    if (pointers.size === 2) {
      drag.value = { x: 0, y: 0 };
      pinch = { distance: spread(), scale: scale.value, anchor: midpoint() };
      startPan = pan.value;
      moved = true;
    } else if (pointers.size === 1) {
      start = { x: event.clientX, y: event.clientY };
      startPan = pan.value;
      startTime = performance.now();
      axis = null;
      moved = false;
      inert = false;
    }
  }

  function onPointerMove(event: PointerEvent): void {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch && pointers.size >= 2) {
      const next = Math.min(MAX_SCALE, Math.max(1, pinch.scale * spread() / pinch.distance));
      zoomAt(midpoint(), next, { scale: pinch.scale, pan: startPan, anchor: pinch.anchor });
      return;
    }
    if (pinch || inert || pointers.size !== 1) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!moved && Math.hypot(dx, dy) < TAP_SLOP) return;
    moved = true;
    if (scale.value > 1) {
      pan.value = clampPan({ x: startPan.x + dx, y: startPan.y + dy }, scale.value);
      return;
    }
    if (sliding) return;
    axis ??= Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    // A lone image resists sideways drags so it still feels attached.
    if (axis === 'x') drag.value = { x: options.canStep() ? dx : dx / 4, y: 0 };
    else drag.value = { x: 0, y: Math.max(0, dy) };
  }

  function onPointerUp(event: PointerEvent): void {
    if (!pointers.delete(event.pointerId)) return;
    if (pinch) return endPinch();
    if (pointers.size > 0) return;
    active.value = false;
    if (!moved) return tap({ x: event.clientX, y: event.clientY });
    if (sliding) return;
    const width = stage.value?.clientWidth ?? 1;
    const elapsed = Math.max(1, performance.now() - startTime);
    const { x, y } = drag.value;
    if (axis === 'x' && options.canStep() && (Math.abs(x) > width * SWIPE_RATIO || Math.abs(x) / elapsed > FLICK_VELOCITY)) {
      slide(x < 0 ? 1 : -1, width);
    } else if (axis === 'y' && (y > DISMISS_DISTANCE || y / elapsed > FLICK_VELOCITY)) {
      options.onDismiss();
    } else {
      drag.value = { x: 0, y: 0 };
    }
  }

  // A finger still down after a pinch carries on as a pan.
  function endPinch(): void {
    if (pointers.size > 1) return;
    pinch = null;
    if (scale.value < 1.05) {
      scale.value = 1;
      pan.value = { x: 0, y: 0 };
    } else {
      pan.value = clampPan(pan.value, scale.value);
    }
    const [rest] = pointers.values();
    if (!rest) {
      active.value = false;
      return;
    }
    start = rest;
    startPan = pan.value;
    axis = null;
    inert = scale.value === 1;
  }

  // An interrupted touch settles back without tapping, stepping or closing.
  function onPointerCancel(event: PointerEvent): void {
    if (!pointers.delete(event.pointerId)) return;
    if (pinch) return endPinch();
    if (pointers.size > 0) return;
    active.value = false;
    drag.value = { x: 0, y: 0 };
  }

  // Slides the current image out, then brings the next one in from the
  // opposite edge.
  function slide(delta: number, width: number): void {
    if (sliding) return;
    sliding = true;
    drag.value = { x: -delta * width, y: 0 };
    stepTimer = setTimeout(() => {
      options.onStep(delta);
      scale.value = 1;
      pan.value = { x: 0, y: 0 };
      active.value = true;
      drag.value = { x: delta * width, y: 0 };
      requestAnimationFrame(() => requestAnimationFrame(() => {
        active.value = false;
        drag.value = { x: 0, y: 0 };
        sliding = false;
      }));
    }, SETTLE_MS);
  }

  function tap(point: Point): void {
    const now = performance.now();
    if (lastTap && now - lastTap.time < DOUBLE_TAP_MS && Math.hypot(point.x - lastTap.point.x, point.y - lastTap.point.y) < TAP_SLOP * 3) {
      clearTimeout(tapTimer);
      lastTap = null;
      if (scale.value > 1) {
        scale.value = 1;
        pan.value = { x: 0, y: 0 };
      } else {
        zoomAt(point, DOUBLE_TAP_SCALE);
        pan.value = clampPan(pan.value, DOUBLE_TAP_SCALE);
      }
      return;
    }
    lastTap = { time: now, point };
    tapTimer = setTimeout(() => { lastTap = null; options.onTap(); }, DOUBLE_TAP_MS);
  }

  return {
    imageStyle,
    backdropOpacity,
    reset,
    handlers: { pointerdown: onPointerDown, pointermove: onPointerMove, pointerup: onPointerUp, pointercancel: onPointerCancel },
  };
}
