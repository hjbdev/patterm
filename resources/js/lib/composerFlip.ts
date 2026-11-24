// Slides a composer from where it was to where it is now (a FLIP animation),
// as when the first message moves the centred composer to the bottom. The
// card keeps its text size while its box moves and resizes, and a spacer
// holds its place in the layout until it lands.

export interface ComposerPlace {
  rect: DOMRect;
  radius: string;
  background: string;
  border: string;
  // What is left of a slide another view started.
  duration?: number;
}

const DURATION = 520;
const EASING = 'cubic-bezier(.2,.8,.2,1)';

export function composerPlace(element: Element): ComposerPlace {
  const style = getComputedStyle(element);
  return { rect: element.getBoundingClientRect(), radius: style.borderRadius, background: style.backgroundColor, border: style.borderTopColor };
}

export function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Returns the running animation, so a view that closes mid-slide can hand
// the rest of it on.
export function flipComposer(element: HTMLElement, from: ComposerPlace, fadeIn: readonly Element[] = []): Animation | null {
  if (reducedMotion() || typeof element.animate !== 'function') return null;
  const to = composerPlace(element);
  if (!to.rect.width || !from.rect.width) return null;
  if (Math.abs(to.rect.top - from.rect.top) < 1 && Math.abs(to.rect.left - from.rect.left) < 1 && Math.abs(to.rect.width - from.rect.width) < 1 && Math.abs(to.rect.height - from.rect.height) < 1) return null;
  const duration = Math.max(120, from.duration ?? DURATION);

  const spacer = document.createElement('div');
  spacer.style.height = `${element.offsetHeight}px`;
  spacer.setAttribute('aria-hidden', 'true');
  element.before(spacer);
  const inline = element.getAttribute('style');
  Object.assign(element.style, { position: 'fixed', zIndex: '40', margin: '0', boxSizing: 'border-box' });
  const animation = element.animate([
    { left: `${from.rect.left}px`, top: `${from.rect.top}px`, width: `${from.rect.width}px`, height: `${from.rect.height}px`, borderRadius: from.radius, backgroundColor: from.background, borderColor: from.border },
    { left: `${to.rect.left}px`, top: `${to.rect.top}px`, width: `${to.rect.width}px`, height: `${to.rect.height}px`, borderRadius: to.radius, backgroundColor: to.background, borderColor: to.border }
  ], { duration, easing: from.duration ? 'cubic-bezier(.1,.6,.2,1)' : EASING });
  for (const item of fadeIn) item.animate?.([{ opacity: 0 }, { opacity: 0, offset: 0.4 }, { opacity: 1 }], { duration });
  const finish = () => {
    spacer.remove();
    if (inline === null) element.removeAttribute('style');
    else element.setAttribute('style', inline);
  };
  animation.onfinish = finish;
  animation.oncancel = finish;
  return animation;
}

// A composer's place handed from one view to the next, such as from the new
// conversation page to the agent starting from it. It goes stale quickly, so
// a view opened later never slides from an old place.
let handoff: { place: ComposerPlace; at: number } | null = null;

export function handOffComposer(element: Element, duration?: number): void {
  handoff = { place: { ...composerPlace(element), ...(duration ? { duration } : {}) }, at: performance.now() };
}

// A view closing mid-slide hands where the card is now, and the time left.
export function handOffRunningComposer(element: Element, animation: Animation | null): void {
  if (!animation || animation.playState !== 'running') return;
  const timing = animation.effect?.getComputedTiming();
  const left = Number(timing?.duration ?? 0) - Number(timing?.localTime ?? 0);
  if (left > 60) handOffComposer(element, left);
}

export function takeComposerHandoff(): ComposerPlace | null {
  const taken = handoff && performance.now() - handoff.at < 1500 ? handoff.place : null;
  handoff = null;
  return taken;
}
