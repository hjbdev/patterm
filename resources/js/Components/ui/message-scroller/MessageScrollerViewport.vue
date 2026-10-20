<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { onBeforeUnmount, onMounted, useTemplateRef } from "vue"
import { cn } from "@/lib/utils"
import { UPWARD_SCROLL_KEYS, useMessageScrollerContext } from "./useMessageScroller"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()

const {
  autoscrolling,
  handleResize,
  handleScroll,
  handleScrollEnd,
  scrollableAttr,
  scrollToEnd,
  scrollToStart,
  setPointerHeld,
  setViewportElement,
  userScrollIntent,
} = useMessageScrollerContext()

const viewportEl = useTemplateRef<HTMLElement>("viewport")
defineExpose({ viewportElement: () => viewportEl.value })

// Input over the top of the transcript cannot move it up.
function canScrollUp(): boolean {
  return (viewportEl.value?.scrollTop ?? 0) > 0
}

function onKeyDown(event: KeyboardEvent) {
  if (event.defaultPrevented || editable(event.target))
    return
  // Home and End go straight to either end. The browser's own animated
  // scroll stops short on a virtualised transcript, as rows measure on the
  // way, and can leave focus on a row that is then unmounted.
  if (event.key === "Home" || event.key === "End") {
    event.preventDefault()
    const viewport = viewportEl.value
    if (viewport && document.activeElement !== viewport)
      viewport.focus({ preventScroll: true })
    if (event.key === "Home")
      scrollToStart()
    else
      scrollToEnd()
    return
  }
  // Space on a button presses it instead of scrolling.
  const scrollsUp = UPWARD_SCROLL_KEYS.has(event.key)
    || (event.key === " " && event.shiftKey && !(event.target instanceof HTMLButtonElement))
  if (scrollsUp && canScrollUp())
    userScrollIntent()
}

function editable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)
}

// A downward nudge at the live edge, a sideways trackpad swipe, a zoom
// gesture, or a scroll inside an expanded tool output cannot move the
// transcript up, so it is not the reader leaving the live edge.
function onWheel(event: WheelEvent) {
  if (event.ctrlKey || event.deltaY >= 0 || Math.abs(event.deltaX) > Math.abs(event.deltaY))
    return
  if (canScrollUp() && !nestedScrollerTakes(event.target))
    userScrollIntent()
}

let touchY: number | null = null
let touchTarget: EventTarget | null = null

// Touch events keep going to the element a touch started on, even after it
// leaves the document, as the elements of a streaming reply do on every
// update. Listen on that element rather than waiting for them to bubble.
function onTouchStart(event: TouchEvent) {
  stopTouch()
  touchY = event.touches[0]?.clientY ?? null
  touchTarget = event.target
  touchTarget?.addEventListener("touchmove", onTouchMove as EventListener, { passive: true })
  touchTarget?.addEventListener("touchend", stopTouch)
  touchTarget?.addEventListener("touchcancel", stopTouch)
}

function stopTouch() {
  touchTarget?.removeEventListener("touchmove", onTouchMove as EventListener)
  touchTarget?.removeEventListener("touchend", stopTouch)
  touchTarget?.removeEventListener("touchcancel", stopTouch)
  touchTarget = null
}

function onTouchMove(event: TouchEvent) {
  const y = event.touches[0]?.clientY
  if (y === undefined || touchY === null)
    return
  const draggedDown = y > touchY
  touchY = y
  if (draggedDown && canScrollUp() && !nestedScrollerTakes(event.target))
    userScrollIntent()
}

// True when an element between the target and the viewport can still scroll
// up, so it takes the gesture instead of the transcript.
function nestedScrollerTakes(target: EventTarget | null): boolean {
  const viewport = viewportEl.value
  for (let element = target instanceof Element ? target : null; element && element !== viewport; element = element.parentElement) {
    if (element instanceof HTMLElement && element.scrollTop > 0 && element.scrollHeight > element.clientHeight) {
      const overflow = window.getComputedStyle(element).overflowY
      if (overflow === "auto" || overflow === "scroll")
        return true
    }
  }
  return false
}

// A scrollbar drag fires no wheel, touch, or key event. The classic scrollbar
// sits past clientWidth on the viewport itself. A press on the scrollbar or on
// the content, such as selecting text, holds the glide until it is released,
// so neither the thumb nor the text moves under the pointer.
function onPointerDown(event: PointerEvent) {
  const viewport = viewportEl.value
  if (!viewport)
    return
  if (event.target === viewport && event.offsetX >= viewport.clientWidth)
    userScrollIntent({ scrollbar: true })
  else if (event.button !== 0 || event.pointerType === "touch")
    return
  setPointerHeld(true)
  window.addEventListener("pointerup", releasePointer, true)
  window.addEventListener("pointercancel", releasePointer, true)
  window.addEventListener("blur", releasePointer)
}

function releasePointer() {
  window.removeEventListener("pointerup", releasePointer, true)
  window.removeEventListener("pointercancel", releasePointer, true)
  window.removeEventListener("blur", releasePointer)
  setPointerHeld(false)
}

let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  const viewport = viewportEl.value
  setViewportElement(viewport)
  if (!viewport || typeof ResizeObserver === "undefined")
    return
  // Before paint, so a viewport that shrinks under a growing composer or a
  // permission prompt never shows a frame with the end hidden.
  resizeObserver = new ResizeObserver(() => handleResize())
  resizeObserver.observe(viewport)
})

onBeforeUnmount(() => {
  stopTouch()
  releasePointer()
  resizeObserver?.disconnect()
  resizeObserver = null
  setViewportElement(null)
})
</script>

<template>
  <div
    ref="viewport"
    data-slot="message-scroller-viewport"
    role="region"
    aria-label="Messages"
    :tabindex="0"
    :data-scrollable="scrollableAttr"
    :data-autoscrolling="autoscrolling ? '' : undefined"
    :class="cn(
      'size-full min-h-0 min-w-0 outline-none [scrollbar-width:thin] [scrollbar-gutter:stable] overflow-y-auto overscroll-contain [contain:content]',
      props.class,
    )"
    @scroll="handleScroll()"
    @scrollend="handleScrollEnd()"
    @wheel="onWheel"
    @touchstart="onTouchStart"
    @keydown="onKeyDown"
    @pointerdown="onPointerDown"
  >
    <slot />
  </div>
</template>
