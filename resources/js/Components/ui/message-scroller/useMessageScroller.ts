import type { ComputedRef, InjectionKey, Ref, ShallowRef } from "vue"
import { computed, inject, onMounted, onScopeDispose, provide, shallowRef, watch } from "vue"

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export type MessageScrollerDefaultScrollPosition = "start" | "end"
export type MessageScrollerButtonDirection = "start" | "end"

export interface MessageScrollerScrollable {
  start: boolean
  end: boolean
}

export interface MessageScrollerProviderProps {
  autoScroll?: boolean | undefined
  defaultScrollPosition?: MessageScrollerDefaultScrollPosition | undefined
  scrollEdgeThreshold?: number | undefined
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_SCROLL_EDGE_THRESHOLD = 8
const SCROLL_EPSILON = 0.5
const AUTOSCROLLING_TIMEOUT = 180
// Time constant for gliding to the live edge. Each frame closes
// 1 - e^(-dt/τ) of the remaining distance, so a new row settles in ~250ms and
// a continuously growing reply is followed without a per-update jump.
const GLIDE_TIME_CONSTANT = 70
// Growth further than this many viewport heights from the live edge jumps
// instead of gliding, so a large catch-up does not render every row on the way.
const GLIDE_MAX_VIEWPORTS = 2
// Within this distance of the end counts as at the end, so the transcript
// keeps following without the reader landing on the last pixel.
const FOLLOW_DISTANCE = 80
// Input that cannot move the transcript, such as a wheel over the top of a
// view that does not scroll yet, gives up its pause after this long.
const INTENT_LAPSE = 250
// Without scrollend, a scroll counts as finished after this quiet gap. With
// it, a longer gap backs it up: Chrome can fire a scroll's last event after
// its scrollend.
const SCROLL_END_FALLBACK = 150
const SCROLL_END_BACKSTOP = 400

// Keys that move the view away from the live edge. Home and End are handled
// by the scroller itself; PageDown, ArrowDown and Space move towards the end,
// so they keep following.
const UPWARD_SCROLL_KEYS = new Set([
  "ArrowUp",
  "PageUp",
])

const EMPTY_SCROLLABLE: MessageScrollerScrollable = { start: false, end: false }

function scrollableEqual(a: MessageScrollerScrollable, b: MessageScrollerScrollable) {
  return a.start === b.start && a.end === b.end
}

function maxScrollTop(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.clientHeight)
}

// -----------------------------------------------------------------------------
// Engine
// -----------------------------------------------------------------------------

export interface MessageScrollerContext {
  autoscrolling: Readonly<ShallowRef<boolean>>
  scrollable: Readonly<ShallowRef<MessageScrollerScrollable>>
  scrollableAttr: ComputedRef<string | undefined>
  handleResize: (options?: { glide?: boolean }) => void
  handleScroll: () => void
  handleScrollEnd: () => void
  isFollowing: () => boolean
  noteProgrammaticScroll: (from?: number) => void
  releaseHold: () => void
  scrollToEnd: (options?: { behavior?: ScrollBehavior }) => boolean
  scrollToStart: (options?: { behavior?: ScrollBehavior }) => boolean
  setPointerHeld: (held: boolean) => void
  setViewportElement: (element: HTMLElement | null) => void
  userScrollIntent: (options?: { sticky?: boolean, scrollbar?: boolean }) => void
}

export type RegisterMessage = (
  messageId: string,
  element: HTMLElement | null,
  previousElement: HTMLElement | null,
) => void

const CONTEXT_KEY: InjectionKey<MessageScrollerContext> = Symbol("MessageScrollerContext")
const REGISTER_KEY: InjectionKey<RegisterMessage> = Symbol("MessageScrollerRegister")

function createEngine(props: MessageScrollerProviderProps) {
  const autoScroll = () => props.autoScroll ?? false
  const defaultScrollPosition = () => props.defaultScrollPosition ?? "end"
  const scrollEdgeThreshold = () => props.scrollEdgeThreshold ?? DEFAULT_SCROLL_EDGE_THRESHOLD
  const scrollEndSupported = typeof window !== "undefined" && "onscrollend" in window

  let viewport: HTMLElement | null = null
  let following = autoScroll()
  let lastScrollTop = 0
  let lastDistance = 0
  let lastClientHeight = 0
  // Where the reader last asked to leave the live edge. Until the reader moves
  // the view away from it, a scroll event (such as one the glide queued before
  // the reader's own scroll) cannot resume following.
  let holdScrollTop: number | null = null
  let holdTimeout: number | null = null
  // How far the reader has scrolled up since leaving the end. Output arriving
  // during the scroll moves the end further away, so a short scroll up from
  // the end is judged by the reader's own movement.
  let travelledFromEnd: number | null = null
  // Where the reader last came to rest inside the end zone while following,
  // until the view next moves to the end. A slow trackpad scroll arrives as
  // many short scrolls, each settling back into following, and their travel
  // must add up.
  let restingDistance = 0
  // The position the scroller, or the virtualiser through it, last wrote. A
  // scroll event that lands exactly there is not the reader's.
  let writtenScrollTop: number | null = null
  let scrolling = false
  let scrollEndTimeout: number | null = null
  // A pointer pressed on the content, such as while selecting text, holds the
  // glide so the text does not slide under it.
  let pointerHeld = false
  let defaultScrollPositionApplied = false
  let stateFrame: number | null = null
  let autoscrollingTimeout: number | null = null
  let glideFrame: number | null = null
  let glideTime = 0
  // The first content a mount shows (including a cached transcript painted
  // before its refresh) lands at the end at once; only later growth glides.
  let settledOnContent = false
  const messageElements = new Map<string, HTMLElement>()

  const autoscrolling = shallowRef(false)
  const scrollable = shallowRef<MessageScrollerScrollable>(EMPTY_SCROLLABLE)
  const scrollableAttr = computed(() => {
    const attr = [scrollable.value.start && "start", scrollable.value.end && "end"]
      .filter(Boolean)
      .join(" ")
    return attr || undefined
  })

  // A hidden viewport (display: none) measures nothing, which would read as
  // sitting at the end.
  function visibleViewport(): HTMLElement | null {
    return viewport && viewport.clientHeight > 0 ? viewport : null
  }

  function distanceFromEnd(element: HTMLElement): number {
    return maxScrollTop(element) - element.scrollTop
  }

  // --- scroll state ----------------------------------------------------------

  function commitScrollState() {
    const element = visibleViewport()
    if (!element)
      return
    const threshold = scrollEdgeThreshold()
    const next = {
      start: element.scrollTop > threshold,
      end: !following && distanceFromEnd(element) > threshold,
    }
    if (!scrollableEqual(scrollable.value, next))
      scrollable.value = next
  }

  function scheduleStateCommit() {
    if (stateFrame === null) {
      stateFrame = window.requestAnimationFrame(() => {
        stateFrame = null
        commitScrollState()
      })
    }
  }

  function pause(travelled: number | null) {
    cancelGlide()
    if (following)
      travelledFromEnd = travelled
    following = false
  }

  function resume(resting = 0) {
    following = true
    travelledFromEnd = null
    restingDistance = resting
  }

  function clearHold() {
    holdScrollTop = null
    if (holdTimeout !== null) {
      window.clearTimeout(holdTimeout)
      holdTimeout = null
    }
  }

  // Resume following once the view has come to rest near the end. A scroll
  // still in progress, such as a key or wheel animation that has only just
  // left the end, or a scrollbar thumb still held, is not at rest.
  function settle() {
    const element = visibleViewport()
    if (element && !following && !scrolling && !pointerHeld && holdScrollTop === null && autoScroll()) {
      const distance = distanceFromEnd(element)
      const reach = Math.min(distance, travelledFromEnd ?? Number.POSITIVE_INFINITY)
      travelledFromEnd = null
      if (reach <= FOLLOW_DISTANCE) {
        resume(distance)
        // Output that arrived during the scroll took the end out of reach.
        if (distance > FOLLOW_DISTANCE)
          followEnd(true)
      }
    }
    commitScrollState()
  }

  function handleScroll() {
    const element = visibleViewport()
    if (!element)
      return
    const scrollTop = element.scrollTop
    const distance = distanceFromEnd(element)
    const programmatic = writtenScrollTop !== null && Math.abs(scrollTop - writtenScrollTop) <= 1
    writtenScrollTop = null
    if (holdScrollTop !== null && !programmatic && Math.abs(scrollTop - holdScrollTop) > SCROLL_EPSILON)
      clearHold()
    const movedUp = scrollTop < lastScrollTop - SCROLL_EPSILON
    // The browser clamps the view when the viewport grows, such as when the
    // composer empties after a send, and new rows may land in the same frame.
    const resized = element.clientHeight !== lastClientHeight
    const reader = !programmatic && !resized
    // The reader moved up, away from the end. The virtualiser correcting for a
    // row above, or the browser clamping after the content shrank, also moves
    // the view up, but leaves it as far from the end as it was.
    if (following && reader && movedUp && distance > lastDistance + SCROLL_EPSILON)
      pause(lastScrollTop - scrollTop)
    else if (!following && !programmatic && !movedUp && holdScrollTop === null && autoScroll() && distance <= FOLLOW_DISTANCE)
      resume(distance)
    else if (travelledFromEnd !== null && reader)
      travelledFromEnd += lastScrollTop - scrollTop
    // Scrolling back towards the end while following brings the resting place
    // with it. Output only moves the end away, so it never adds to it.
    if (following && reader)
      restingDistance = Math.min(restingDistance, distance)
    lastScrollTop = scrollTop
    lastDistance = distance
    lastClientHeight = element.clientHeight
    scrolling = true
    if (scrollEndTimeout !== null)
      window.clearTimeout(scrollEndTimeout)
    scrollEndTimeout = window.setTimeout(handleScrollEnd, scrollEndSupported ? SCROLL_END_BACKSTOP : SCROLL_END_FALLBACK)
    commitScrollState()
  }

  function handleScrollEnd() {
    if (scrollEndTimeout !== null) {
      window.clearTimeout(scrollEndTimeout)
      scrollEndTimeout = null
    }
    scrolling = false
    settle()
  }

  // --- imperative scroll primitives ------------------------------------------

  function setAutoscrolling(active: boolean) {
    if (autoscrollingTimeout !== null) {
      window.clearTimeout(autoscrollingTimeout)
      autoscrollingTimeout = null
    }
    if (autoscrolling.value !== active)
      autoscrolling.value = active
    if (active) {
      autoscrollingTimeout = window.setTimeout(() => {
        autoscrollingTimeout = null
        autoscrolling.value = false
      }, AUTOSCROLLING_TIMEOUT)
    }
  }

  // A write from `from` moves the view without the reader. Their next scroll
  // is measured from where the write put it, so a correction whose scroll
  // event is still to come is not counted as theirs.
  function noteProgrammaticScroll(from?: number) {
    if (!viewport)
      return
    writtenScrollTop = viewport.scrollTop
    if (from !== undefined)
      lastScrollTop += viewport.scrollTop - from
  }

  function scrollTo(
    top: number,
    { behavior = "auto", autoscrolling: isAutoscrolling = false }: { behavior?: ScrollBehavior, autoscrolling?: boolean } = {},
  ) {
    if (!viewport)
      return
    cancelGlide()
    const target = Math.max(0, top)
    const from = viewport.scrollTop
    if (Math.abs(from - target) <= SCROLL_EPSILON) {
      viewport.scrollTop = target
      // A clamp may already have moved the view here; its scroll event is
      // still to come and is not the reader's.
      noteProgrammaticScroll(from)
      commitScrollState()
      return
    }
    if (isAutoscrolling)
      setAutoscrolling(true)
    viewport.scrollTo({ top: target, behavior })
    if (behavior !== "smooth")
      noteProgrammaticScroll(from)
    scheduleStateCommit()
  }

  function cancelGlide() {
    if (glideFrame !== null) {
      window.cancelAnimationFrame(glideFrame)
      glideFrame = null
    }
  }

  function glideStep(now: number) {
    glideFrame = null
    if (!viewport || !following || pointerHeld)
      return
    const target = maxScrollTop(viewport)
    const remaining = target - viewport.scrollTop
    if (remaining <= SCROLL_EPSILON) {
      if (remaining < -SCROLL_EPSILON)
        viewport.scrollTop = target
      commitScrollState()
      return
    }
    const elapsed = Math.min(64, now - glideTime)
    glideTime = now
    const step = remaining * (1 - Math.exp(-elapsed / GLIDE_TIME_CONSTANT))
    setAutoscrolling(true)
    const from = viewport.scrollTop
    viewport.scrollTop += Math.max(1, step)
    noteProgrammaticScroll(from)
    glideFrame = window.requestAnimationFrame(glideStep)
  }

  // Follow the live edge frame by frame instead of snapping. The target is
  // re-read every frame, so growth during the glide extends it smoothly.
  function glideToEnd(): boolean {
    if (!viewport)
      return false
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
      return scrollToEnd({ behavior: "auto" })
    following = true
    restingDistance = 0
    if (glideFrame === null) {
      glideTime = performance.now()
      glideFrame = window.requestAnimationFrame(glideStep)
    }
    return true
  }

  // Follow growth at the live edge: glide for live output, jump for the first
  // content of a mount and for catch-ups too far away to glide through.
  function followEnd(glide: boolean): boolean {
    if (!viewport)
      return false
    const distance = distanceFromEnd(viewport)
    const followed = glide && settledOnContent && distance <= viewport.clientHeight * GLIDE_MAX_VIEWPORTS
      ? glideToEnd()
      : scrollToEnd({ behavior: "auto" })
    if (messageElements.size > 0)
      settledOnContent = true
    return followed
  }

  function scrollToStart({ behavior = "auto" }: { behavior?: ScrollBehavior } = {}): boolean {
    if (!viewport)
      return false
    clearHold()
    following = false
    travelledFromEnd = null
    scrollTo(0, { behavior })
    return true
  }

  function scrollToEnd({ behavior = "auto" }: { behavior?: ScrollBehavior } = {}): boolean {
    if (!viewport)
      return false
    clearHold()
    following = autoScroll()
    travelledFromEnd = null
    restingDistance = 0
    scrollTo(maxScrollTop(viewport), { autoscrolling: true, behavior })
    return true
  }

  // --- default scroll position -----------------------------------------------

  function applyDefaultScrollPosition(): boolean {
    if (defaultScrollPositionApplied)
      return false
    const applied = defaultScrollPosition() === "end"
      ? scrollToEnd({ behavior: "auto" })
      : scrollToStart({ behavior: "auto" })
    if (applied)
      defaultScrollPositionApplied = true
    return applied
  }

  // --- resize handling --------------------------------------------------------

  function handleResize({ glide = false }: { glide?: boolean } = {}) {
    if (!visibleViewport())
      return
    if (following && autoScroll()) {
      if (pointerHeld)
        commitScrollState()
      else
        followEnd(glide)
      return
    }
    // Content that shrank back towards the reader, such as a row they closed,
    // can bring the end back within reach.
    settle()
  }

  const registerMessage: RegisterMessage = (messageId, element, previousElement) => {
    if (element) {
      messageElements.set(messageId, element)
      return
    }
    if (previousElement && messageElements.get(messageId) === previousElement)
      messageElements.delete(messageId)
  }

  // --- user intent + element setters -----------------------------------------

  // Reader input that moves the view up stops following. A sticky pause, such
  // as opening a row to read it, lasts until the reader scrolls; any other
  // pause lapses if the input never moved the view.
  function userScrollIntent({ sticky = false, scrollbar = false }: { sticky?: boolean, scrollbar?: boolean } = {}) {
    // Opening a row to read it is not a short scroll that the end can take
    // back, and neither is dragging the scrollbar, which picks a position.
    const leaving = following
    pause(sticky || scrollbar ? null : restingDistance)
    clearHold()
    holdScrollTop = viewport?.scrollTop ?? 0
    // Measure the reader's scroll from here, not from a glide step whose scroll
    // event is still to come. Only the input that leaves the end does: a
    // trackpad's later wheel events arrive after the scroll they caused, and
    // that movement is the reader's.
    if (leaving)
      lastScrollTop = holdScrollTop
    if (!sticky) {
      holdTimeout = window.setTimeout(() => {
        holdTimeout = null
        holdScrollTop = null
        settle()
      }, INTENT_LAPSE)
    }
    commitScrollState()
  }

  function setPointerHeld(held: boolean) {
    if (pointerHeld === held)
      return
    pointerHeld = held
    if (held) {
      cancelGlide()
      return
    }
    settle()
    if (following && autoScroll())
      followEnd(true)
  }

  function setViewportElement(element: HTMLElement | null) {
    viewport = element
    if (element) {
      lastScrollTop = element.scrollTop
      lastDistance = distanceFromEnd(element)
      lastClientHeight = element.clientHeight
    }
  }

  function onAutoScrollChange() {
    if (autoScroll() && following && messageElements.size > 0) {
      scrollToEnd({ behavior: "auto" })
      return
    }
    commitScrollState()
  }

  function destroy() {
    cancelGlide()
    clearHold()
    if (stateFrame !== null) {
      window.cancelAnimationFrame(stateFrame)
      stateFrame = null
    }
    if (autoscrollingTimeout !== null) {
      window.clearTimeout(autoscrollingTimeout)
      autoscrollingTimeout = null
    }
    if (scrollEndTimeout !== null) {
      window.clearTimeout(scrollEndTimeout)
      scrollEndTimeout = null
    }
  }

  const context: MessageScrollerContext = {
    autoscrolling,
    scrollable,
    scrollableAttr,
    handleResize,
    handleScroll,
    handleScrollEnd,
    isFollowing: () => following,
    noteProgrammaticScroll,
    releaseHold: clearHold,
    scrollToEnd,
    scrollToStart,
    setPointerHeld,
    setViewportElement,
    userScrollIntent,
  }

  return {
    context,
    registerMessage,
    applyDefaultScrollPosition,
    commitScrollState,
    onAutoScrollChange,
    destroy,
  }
}

// -----------------------------------------------------------------------------
// Provider wiring (provide/inject)
// -----------------------------------------------------------------------------

export function provideMessageScroller(props: MessageScrollerProviderProps) {
  const engine = createEngine(props)
  provide(CONTEXT_KEY, engine.context)
  provide(REGISTER_KEY, engine.registerMessage)

  watch(() => props.autoScroll ?? false, () => engine.onAutoScrollChange())

  onMounted(() => {
    // The viewport attaches in MessageScrollerViewport's onMounted, before
    // this one runs.
    engine.applyDefaultScrollPosition()
    engine.commitScrollState()
  })

  onScopeDispose(() => engine.destroy())

  return engine
}

export function useMessageScrollerContext(): MessageScrollerContext {
  const context = inject(CONTEXT_KEY, null)
  if (!context)
    throw new Error("useMessageScroller must be used within a MessageScroller.")
  return context
}

export function useMessageScrollerRegister(): RegisterMessage {
  const register = inject(REGISTER_KEY, null)
  if (!register)
    throw new Error("MessageScrollerItem must be used within a MessageScroller.")
  return register
}

// -----------------------------------------------------------------------------
// Public composables
// -----------------------------------------------------------------------------

export function useMessageScroller() {
  const { scrollToEnd, scrollToStart } = useMessageScrollerContext()
  return { scrollToEnd, scrollToStart }
}

export function useMessageScrollerScrollable(): Ref<MessageScrollerScrollable> {
  const { scrollable } = useMessageScrollerContext()
  return computed(() => scrollable.value)
}

export { UPWARD_SCROLL_KEYS }
