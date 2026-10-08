import { nextTick, onBeforeUnmount, ref } from 'vue';

// Browser-style tab dragging. The dragged tab follows the pointer and the other
// tabs in its group slide aside. Positions are applied as inline transforms
// outside Vue, and the new order is committed once, when the tab is dropped.

export interface DraggableTab {
  key: string;
  // Tabs only move within their group, such as pinned or unpinned tabs.
  group: string;
}

export interface TabStripDragOptions {
  tabs: () => readonly DraggableTab[];
  element: (key: string) => HTMLElement | undefined;
  onDragStart?: () => void;
  // `index` is the dropped tab's position in the strip without it.
  onDrop: (key: string, index: number) => void;
}

const TAB_MOTION_MS = 180;
const TAB_MOTION_EASING = 'cubic-bezier(0.2, 0, 0, 1)';
const DRAG_THRESHOLD_PX = 6;
const AUTOSCROLL_EDGE_PX = 48;
const AUTOSCROLL_MAX_STEP_PX = 16;

interface Slot {
  key: string;
  element: HTMLElement;
  // Untransformed position in the scroller's content space.
  left: number;
  width: number;
}

interface ActiveDrag {
  clientX: number;
  slots: Slot[];
  index: number;
  target: number;
  groupStart: number;
  gap: number;
  grabOffset: number;
  scroller: HTMLElement | null;
  frameId: number;
}

// One press on a tab, from pointerdown until the pointer is released.
interface Gesture {
  key: string;
  pointerId: number;
  startX: number;
  startY: number;
  captureTarget: HTMLElement;
  drag: ActiveDrag | null;
  // Set once a drag starts, even if it is cancelled before release.
  dragged: boolean;
}

export function useTabStripDrag(options: TabStripDragOptions) {
  const draggingKey = ref<string | null>(null);
  let gesture: Gesture | null = null;
  let dragGeneration = 0;
  let suppressedClickKey: string | null = null;

  function onPointerDown(event: PointerEvent, key: string): void {
    if (event.button !== 0 || !event.isPrimary || !(event.currentTarget instanceof HTMLElement)) return;
    endGesture(false);
    gesture = {
      key,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      captureTarget: event.currentTarget,
      drag: null,
      dragged: false
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);
  }

  // Swallows the click that ends a drag so the tab is not also selected.
  function consumeClick(event: MouseEvent, key: string): void {
    if (suppressedClickKey !== key) return;
    suppressedClickKey = null;
    event.preventDefault();
    event.stopPropagation();
  }

  // Returns a dragged tab to its place. The press still ends on release.
  function cancel(): void {
    if (gesture?.drag) stopDrag(gesture, false);
  }

  function handlePointerMove(event: PointerEvent): void {
    const current = gesture;
    if (!current || event.pointerId !== current.pointerId || (current.dragged && !current.drag)) return;
    if (current.drag) {
      current.drag.clientX = event.clientX;
      event.preventDefault();
      return;
    }
    if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < DRAG_THRESHOLD_PX) return;
    current.drag = startDrag(current, event.clientX);
    if (!current.drag) {
      endGesture(false);
      return;
    }
    current.dragged = true;
    event.preventDefault();
  }

  function handlePointerUp(event: PointerEvent): void {
    if (gesture?.pointerId === event.pointerId) endGesture(true);
  }

  function handlePointerCancel(event: PointerEvent): void {
    if (gesture?.pointerId === event.pointerId) endGesture(false);
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  }

  function handleBlur(): void {
    endGesture(false);
  }

  function startDrag(current: Gesture, clientX: number): ActiveDrag | null {
    const tabs = options.tabs();
    const group = tabs.find((tab) => tab.key === current.key)?.group;
    const groupTabs = tabs.filter((tab) => tab.group === group);
    const elements = groupTabs.map((tab) => options.element(tab.key));
    if (groupTabs.length < 2 || !elements.every((element): element is HTMLElement => Boolean(element))) return null;

    // Land any tab still settling from an earlier move before measuring.
    for (const element of elements) {
      for (const animation of element.getAnimations()) animation.finish();
    }
    const scroller = scrollParent(elements[0]!);
    const origin = scrollOrigin(scroller);
    const slots = groupTabs.map((tab, index) => {
      const element = elements[index]!;
      const rect = element.getBoundingClientRect();
      return { key: tab.key, element, left: rect.left - origin, width: rect.width };
    });
    const index = slots.findIndex((slot) => slot.key === current.key);
    const dragged = slots[index]!;
    for (const slot of slots) {
      slot.element.style.willChange = 'transform';
      slot.element.style.transition = slot === dragged ? 'none' : `transform ${tabMotionMs()}ms ${TAB_MOTION_EASING}`;
    }
    try {
      current.captureTarget.setPointerCapture(current.pointerId);
    } catch {
      // The pointer is already gone; the window listeners still end the press.
    }

    const drag: ActiveDrag = {
      clientX,
      slots,
      index,
      target: index,
      groupStart: tabs.findIndex((tab) => tab.group === group),
      gap: Number.parseFloat(getComputedStyle(elements[0]!.parentElement ?? elements[0]!).columnGap) || 0,
      grabOffset: current.startX - origin - dragged.left,
      scroller,
      frameId: 0
    };
    dragGeneration += 1;
    draggingKey.value = current.key;
    options.onDragStart?.();
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('blur', handleBlur);
    const renderFrame = (): void => {
      if (current.drag !== drag) return;
      autoscroll(drag);
      layoutDrag(drag);
      drag.frameId = window.requestAnimationFrame(renderFrame);
    };
    drag.frameId = window.requestAnimationFrame(renderFrame);
    return drag;
  }

  function stopDrag(current: Gesture, commit: boolean): void {
    const drag = current.drag;
    if (!drag) return;
    current.drag = null;
    window.cancelAnimationFrame(drag.frameId);
    window.removeEventListener('keydown', handleKeyDown, true);
    window.removeEventListener('blur', handleBlur);
    if (current.captureTarget.hasPointerCapture(current.pointerId)) {
      current.captureTarget.releasePointerCapture(current.pointerId);
    }
    if (commit) layoutDrag(drag);

    const generation = dragGeneration;
    const dragged = drag.slots[drag.index]!.element;
    const moved = commit && drag.target !== drag.index;
    void animateTabMoves(drag.slots.map((slot) => slot.element), () => {
      for (const slot of drag.slots) {
        slot.element.style.removeProperty('transform');
        slot.element.style.removeProperty('transition');
        slot.element.style.removeProperty('will-change');
      }
      if (moved) options.onDrop(current.key, drag.groupStart + drag.target);
    }).then(async () => {
      await Promise.allSettled(dragged.getAnimations().map((animation) => animation.finished));
      // Keep the tab raised until it lands, unless another drag has begun.
      if (generation === dragGeneration) draggingKey.value = null;
    });
  }

  function endGesture(commit: boolean): void {
    const current = gesture;
    gesture = null;
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
    window.removeEventListener('pointercancel', handlePointerCancel);
    if (!current) return;
    stopDrag(current, commit);
    if (!current.dragged) return;
    suppressedClickKey = current.key;
    window.setTimeout(() => {
      if (suppressedClickKey === current.key) suppressedClickKey = null;
    }, 100);
  }

  onBeforeUnmount(() => endGesture(false));

  return { draggingKey, onPointerDown, consumeClick, cancel };
}

// Runs `commit`, then slides the elements from where they were drawn to their
// new layout positions.
export async function animateTabMoves(elements: readonly HTMLElement[], commit: () => void): Promise<void> {
  const before = elements.map((element) => element.getBoundingClientRect().left);
  commit();
  const duration = tabMotionMs();
  if (duration === 0) return;
  await nextTick();
  elements.forEach((element, index) => {
    const delta = before[index]! - element.getBoundingClientRect().left;
    if (!element.isConnected || Math.abs(delta) < 0.5) return;
    element.animate(
      [{ transform: `translateX(${delta}px)` }, { transform: 'translateX(0)' }],
      { duration, easing: TAB_MOTION_EASING }
    );
  });
}

function tabMotionMs(): number {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : TAB_MOTION_MS;
}

function layoutDrag(drag: ActiveDrag): void {
  const dragged = drag.slots[drag.index]!;
  const first = drag.slots[0]!;
  const last = drag.slots[drag.slots.length - 1]!;
  const pointerX = drag.clientX - scrollOrigin(drag.scroller);
  const left = clamp(pointerX - drag.grabOffset, first.left, last.left + last.width - dragged.width);
  dragged.element.style.transform = `translateX(${left - dragged.left}px)`;

  // The dragged tab takes whichever slot its left edge is closest to.
  const others = drag.slots.filter((slot) => slot !== dragged);
  let target = 0;
  let closest = Number.POSITIVE_INFINITY;
  let x = first.left;
  for (let index = 0; index <= others.length; index += 1) {
    const distance = Math.abs(left - x);
    if (distance < closest) {
      closest = distance;
      target = index;
    }
    x += (others[index]?.width ?? 0) + drag.gap;
  }
  if (target === drag.target) return;

  drag.target = target;
  x = first.left;
  others.forEach((slot, index) => {
    if (index === target) x += dragged.width + drag.gap;
    const shift = x - slot.left;
    slot.element.style.transform = Math.abs(shift) < 0.5 ? '' : `translateX(${shift}px)`;
    x += slot.width + drag.gap;
  });
}

function autoscroll(drag: ActiveDrag): void {
  const scroller = drag.scroller;
  if (!scroller || scroller.scrollWidth <= scroller.clientWidth) return;
  const rect = scroller.getBoundingClientRect();
  const before = rect.left + AUTOSCROLL_EDGE_PX - drag.clientX;
  const after = drag.clientX - (rect.right - AUTOSCROLL_EDGE_PX);
  const strength = before > 0 ? -Math.min(before / AUTOSCROLL_EDGE_PX, 1) : after > 0 ? Math.min(after / AUTOSCROLL_EDGE_PX, 1) : 0;
  if (strength === 0) return;
  scroller.scrollLeft += Math.sign(strength) * Math.max(1, Math.round(Math.abs(strength) * AUTOSCROLL_MAX_STEP_PX));
}

// Viewport x of the scroller's content origin. Subtracting it maps viewport
// coordinates into content space, which stays put while the strip scrolls.
function scrollOrigin(scroller: HTMLElement | null): number {
  return scroller ? scroller.getBoundingClientRect().left - scroller.scrollLeft : 0;
}

function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const { overflowX } = getComputedStyle(parent);
    if (overflowX === 'auto' || overflowX === 'scroll') return parent;
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
