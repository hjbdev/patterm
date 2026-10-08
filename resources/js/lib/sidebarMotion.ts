import { nextTick } from 'vue';

// Motion for the sidebar, timed like the tab strip's. Everything settles in
// under 200 ms and is skipped when the system asks for reduced motion.
export const SIDEBAR_MOTION: KeyframeAnimationOptions = { duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' };

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Where rows are now, to slide them from after a change.
export function rowTops(elements: Iterable<HTMLElement>): Map<HTMLElement, number> {
  return new Map([...elements].map((row) => [row, row.getBoundingClientRect().top]));
}

// Slides rows from the tops measured before a change to where they are now.
// A slide still running is replaced from wherever it had got to, and longer
// trips take a little longer so rows crossing the list stay easy to follow.
export function slideFrom(before: ReadonlyMap<HTMLElement, number>): void {
  if (reducedMotion()) return;
  for (const [row, top] of before) {
    if (!row.isConnected) continue;
    for (const animation of row.getAnimations()) if (animation.id === SLIDE_ID) animation.cancel();
    const delta = top - row.getBoundingClientRect().top;
    if (Math.abs(delta) < 0.5) continue;
    row.animate([{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }], { ...SIDEBAR_MOTION, id: SLIDE_ID, duration: Math.min(320, 180 + Math.abs(delta) / 4) });
  }
}
const SLIDE_ID = 'sidebar-slide';

// Rows slide from where they were to where `commit` puts them. Measure before
// clearing a drag transform, so a dropped row glides from the drop point.
export async function animateRowMoves(elements: Iterable<HTMLElement>, commit: () => void): Promise<void> {
  const before = rowTops(elements);
  commit();
  if (reducedMotion()) return;
  await nextTick();
  slideFrom(before);
}

// Transition hooks: things entering or leaving the list grow from or shrink
// to nothing, margins included, so nothing below them jumps.
export function expandIn(element: Element, done: () => void): void {
  const target = element as HTMLElement;
  if (reducedMotion()) return done();
  const style = getComputedStyle(target);
  const end = { height: `${target.offsetHeight}px`, marginTop: style.marginTop, marginBottom: style.marginBottom, opacity: 1 };
  target.style.overflow = 'hidden';
  const animation = target.animate([{ height: '0px', marginTop: '0px', marginBottom: '0px', opacity: 0 }, end], SIDEBAR_MOTION);
  animation.onfinish = animation.oncancel = () => {
    target.style.overflow = '';
    done();
  };
}

export function collapseOut(element: Element, done: () => void): void {
  const target = element as HTMLElement;
  if (reducedMotion()) return done();
  // Start from wherever an unfinished expand left it.
  const style = getComputedStyle(target);
  const start = { height: `${target.getBoundingClientRect().height}px`, marginTop: style.marginTop, marginBottom: style.marginBottom, opacity: Number(style.opacity) };
  for (const animation of target.getAnimations()) animation.cancel();
  target.style.overflow = 'hidden';
  const animation = target.animate([start, { height: '0px', marginTop: '0px', marginBottom: '0px', opacity: 0 }], SIDEBAR_MOTION);
  animation.onfinish = animation.oncancel = () => done();
}

// The sidebar's movable blocks: agent families and top-level processes.
export function sidebarBlocks(root: ParentNode = document): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[data-sidebar-block]')];
}
