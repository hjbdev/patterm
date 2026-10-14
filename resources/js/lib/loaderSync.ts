// Every loader (status rings, comets, count shimmers) runs on the document's
// clock, so loaders with the same period move in step across tabs, rows and
// projects. A CSS animation starts when its element mounts, so matching
// durations isn't enough: each one is pinned to the clock as it starts.
// Loaders mark themselves by naming their keyframes `loader-…`; scoped styles
// add a suffix, so the name is matched by prefix.

const LOADER = /^loader-/;

function pin(animation: Animation): void {
  if (typeof CSSAnimation !== 'undefined' && animation instanceof CSSAnimation && LOADER.test(animation.animationName)) animation.startTime = 0;
}

export function syncLoaders(): void {
  if (typeof document === 'undefined' || typeof document.getAnimations !== 'function') return;
  document.getAnimations().forEach(pin);
  document.addEventListener('animationstart', (event) => {
    if (event.target instanceof Element) event.target.getAnimations().forEach(pin);
  }, true);
}
