import { nextTick } from 'vue';
import { START_LOCATION, type RouteLocationNormalized, type Router } from 'vue-router';
import { phoneLayout } from './phoneLayout';

// How deep each page sits on a phone: the list is home, an agent or the
// Library opens over it, and the Library's pages over that. A record opened
// from its page sits one deeper.
const DEPTH: Partial<Record<string, number>> = {
  projects: 0, project: 0,
  agent: 1, process: 1, launch: 1, library: 1,
  worktrees: 2, history: 2, todos: 2, scratchpads: 2, media: 2, routines: 2, usage: 2, settings: 2,
  routineLog: 3
};

function depth(route: RouteLocationNormalized): number | undefined {
  const base = typeof route.name === 'string' ? DEPTH[route.name] : undefined;
  return base !== undefined && route.params.recordId ? base + 1 : base;
}

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Whether the browser animated the back or forward under way itself, as
// Safari does for its edge swipe. Read before the router's own listener,
// which this module is imported ahead of, starts the navigation.
let browserAnimated = false;
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', (event) => { browserAnimated = event.hasUAVisualTransition === true; }, { capture: true });
}

// On a phone, a page opened deeper slides in over the one it came from,
// which drifts left and dims, and going back slides it away again, as in a
// native app. Pages at the same depth, such as one agent to the next, swap
// in place.
export function animatePhoneNavigation(router: Router): void {
  if (!('startViewTransition' in document)) return;
  const shown = new WeakMap<RouteLocationNormalized, () => void>();
  // Claimed as the navigation starts, before any page loads, so one that a
  // slower page supersedes can't take or clear another's claim.
  const animatedByBrowser = new WeakSet<RouteLocationNormalized>();
  let current: ViewTransition | null = null;
  router.beforeEach((to) => {
    if (browserAnimated) animatedByBrowser.add(to);
    browserAnimated = false;
  });
  router.beforeResolve((to, from) => {
    if (!phoneLayout.value || animatedByBrowser.has(to) || from === START_LOCATION || reducedMotion()) return;
    const toDepth = depth(to), fromDepth = depth(from);
    if (toDepth === undefined || fromDepth === undefined || toDepth === fromDepth) return;
    const direction = toDepth > fromDepth ? 'push' : 'pop';
    // The old page is captured first; the navigation then finishes, and the
    // new page is captured once it has rendered.
    return new Promise<void>((resolve) => {
      const rendered = new Promise<void>((done) => {
        // A navigation that throws never reaches afterEach.
        const timeout = setTimeout(done, 1000);
        shown.set(to, () => { clearTimeout(timeout); done(); });
      });
      const root = document.documentElement;
      root.dataset.phoneNavigation = direction;
      // Starting a transition skips the one still running, which rejects its
      // `ready`; the page still updates.
      const transition = current = document.startViewTransition(async () => {
        resolve();
        await rendered;
        await nextTick();
      });
      transition.ready.catch(() => { /* Skipped for a later navigation. */ });
      void transition.finished.finally(() => {
        if (current !== transition) return;
        current = null;
        delete root.dataset.phoneNavigation;
      });
    });
  });
  router.afterEach((to) => { shown.get(to)?.(); });
}
