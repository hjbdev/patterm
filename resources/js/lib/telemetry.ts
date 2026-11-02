import type { App } from 'vue';
import type { Router } from 'vue-router';
import components from 'virtual:patterm-components';

// Opt-in usage telemetry from this window: which pages are opened and for
// how long, and which components' controls are clicked. It reports only
// route names, component names, data-feature attributes, and key
// combinations, never text, and counts nothing while telemetry is off.

export interface TelemetrySettings { enabled: boolean; apiKey: string; host: 'us' | 'eu' }

const APP_COMPONENTS = new Set(components);
const CONTROLS = 'button, a[href], summary, select, textarea, input, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="option"], [role="link"], [data-feature]';
const NAMED_KEYS = new Set(['Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space']);
const REPORT_MS = 30_000;

// The app component that rendered each root element. Vue records this only
// in development builds, so a mixin records it here.
const owners = new WeakMap<Element, string>();

let enabled = false;
let clicks: Record<string, number> = {};
let views: Record<string, number> = {};
let seconds: Record<string, number> = {};
// The page on screen, and since when; since is null while the window is hidden.
let page: { name: string; since: number | null } | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let inventorySent = false;

export function installTelemetry(app: App, router: Router): void {
  app.mixin({
    mounted(this: { $: { type: { __name?: string; name?: string } }; $el: unknown }) {
      const name = this.$.type.__name ?? this.$.type.name;
      if (name && APP_COMPONENTS.has(name) && this.$el instanceof Element) owners.set(this.$el, name);
    }
  });
  router.afterEach((to) => {
    if (!enabled) return;
    const name = typeof to.name === 'string' ? to.name : 'unnamed';
    closePage();
    page = { name, since: document.visibilityState === 'hidden' ? null : performance.now() };
    views[name] = (views[name] ?? 0) + 1;
  });
  document.addEventListener('click', onClick, { capture: true, passive: true });
  document.addEventListener('keydown', onKey, { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => {
    closePage();
    if (document.visibilityState === 'hidden') void report();
  });
  window.addEventListener('patterm:telemetry-changed', (event) => setEnabled((event as CustomEvent<TelemetrySettings>).detail.enabled, router));
  void loadTelemetrySettings().then((settings) => setEnabled(settings.enabled, router)).catch(() => undefined);
}

export async function loadTelemetrySettings(): Promise<TelemetrySettings> {
  return await window.patterm.call('settings_telemetry_get', {}) as TelemetrySettings;
}

export async function saveTelemetrySettings(settings: TelemetrySettings): Promise<TelemetrySettings> {
  const saved = await window.patterm.call('settings_telemetry_update', settings) as TelemetrySettings;
  window.dispatchEvent(new CustomEvent('patterm:telemetry-changed', { detail: saved }));
  return saved;
}

export async function sendTelemetryFeedback(feedback: { sentiment: 'like' | 'dislike'; feature?: string; note: string }): Promise<boolean> {
  const result = await window.patterm.call('telemetry_feedback', feedback) as { accepted: boolean };
  return result.accepted;
}

// The feature a control belongs to: its nearest data-feature attribute, or
// else the app component that rendered it and the kind of control.
export function featureFor(target: Element): string | null {
  const control = target.closest(CONTROLS);
  if (!control) return null;
  const tagged = control.closest<HTMLElement>('[data-feature]')?.dataset.feature;
  if (tagged && /^[A-Za-z0-9_.:/+-]{1,120}$/.test(tagged)) return tagged;
  let owner: string | undefined;
  for (let node: Element | null = control; node && !owner; node = node.parentElement) owner = owners.get(node);
  const kind = control.getAttribute('role') ?? control.tagName.toLowerCase();
  return `${owner ?? 'App'}:${kind.replace(/[^a-z]/g, '')}`;
}

function onClick(event: MouseEvent): void {
  if (!enabled || !(event.target instanceof Element)) return;
  const feature = featureFor(event.target);
  if (feature) clicks[feature] = (clicks[feature] ?? 0) + 1;
}

// Shortcuts only: a key pressed with Ctrl, Alt, or Meta.
function onKey(event: KeyboardEvent): void {
  if (!enabled || !(event.ctrlKey || event.altKey || event.metaKey) || ['Control', 'Alt', 'Meta', 'Shift'].includes(event.key)) return;
  const key = event.key === ' ' ? 'Space' : event.key.length === 1 && /[a-z0-9]/i.test(event.key) ? event.key.toLowerCase() : NAMED_KEYS.has(event.key) ? event.key : null;
  if (!key) return;
  const combo = `key:${[event.ctrlKey && 'ctrl', event.altKey && 'alt', event.metaKey && 'meta', event.shiftKey && 'shift', key].filter(Boolean).join('+')}`;
  clicks[combo] = (clicks[combo] ?? 0) + 1;
}

function setEnabled(next: boolean, router: Router): void {
  if (next === enabled) return;
  enabled = next;
  clicks = {}; views = {}; seconds = {};
  page = null;
  if (timer) clearInterval(timer);
  timer = null;
  if (!enabled) return;
  const name = router.currentRoute.value.name;
  page = { name: typeof name === 'string' ? name : 'unnamed', since: document.visibilityState === 'hidden' ? null : performance.now() };
  views[page.name] = 1;
  timer = setInterval(() => { closePage(); void report(); }, REPORT_MS);
}

// Adds the time on the current page so far, and counts on from now only
// while the window is visible.
function closePage(): void {
  if (!page) return;
  const now = performance.now();
  if (page.since !== null) seconds[page.name] = (seconds[page.name] ?? 0) + (now - page.since) / 1000;
  page.since = document.visibilityState === 'hidden' ? null : now;
}

async function report(): Promise<void> {
  if (!enabled) return;
  const payload = {
    app_version: __PATTERM_VERSION__,
    clicks,
    views,
    seconds: Object.fromEntries(Object.entries(seconds).map(([name, value]) => [name, Math.min(86_400, Math.round(value))]).filter(([, value]) => Number(value) > 0)),
    ...(inventorySent ? {} : { components })
  };
  clicks = {}; views = {}; seconds = {};
  if (!Object.keys(payload.clicks).length && !Object.keys(payload.views).length && !Object.keys(payload.seconds).length && inventorySent) return;
  try {
    await window.patterm.call('telemetry_record', payload);
    inventorySent = true;
  } catch {
    // Dropped: telemetry is best effort and never retried.
  }
}
