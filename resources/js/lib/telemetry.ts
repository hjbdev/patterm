import type { App, ComponentInternalInstance, ComponentPublicInstance } from 'vue';
import type { Router } from 'vue-router';
import components from 'virtual:patterm-components';
import { commandKind } from './commandKind';

// Opt-in usage telemetry from this window: which pages are opened and for
// how long, and which components' controls are clicked. It reports only
// route names, component names, data-feature attributes, and key
// combinations, never text, and counts nothing while telemetry is off.

export interface TelemetrySettings { enabled: boolean; apiKey: string; host: 'us' | 'eu'; epoch?: string | null }

const APP_COMPONENTS = new Set(components);
const CONTROLS = 'button, a[href], summary, select, textarea, input, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="option"], [role="link"], [data-feature]';
const NAMED_KEYS = new Set(['Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space']);
const REPORT_MS = 30_000;

// The nearest app component above each component's root element. Vue
// records the owner only in development builds, so a mixin records it here.
// Walking components rather than the DOM reaches dialogs and menus that
// render elsewhere in the page.
const owners = new WeakMap<Element, string>();

// The opt-in this window counts for, or null while telemetry is off. The
// server refuses counts sent with any other epoch.
let epoch: string | null = null;
let clicks: Record<string, number> = {};
let commands: Record<string, number> = {};
let views: Record<string, number> = {};
let seconds: Record<string, number> = {};
// The page on screen, and since when; since is null while the window is hidden.
let page: { name: string; since: number | null } | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let inventorySent = false;

export function installTelemetry(app: App, router: Router): void {
  app.mixin({
    // Children mount first, so a root element shared with a parent keeps the
    // child's more specific owner.
    mounted(this: ComponentPublicInstance) {
      if (!(this.$el instanceof Element) || owners.has(this.$el)) return;
      const owner = appOwner(this.$);
      if (owner) owners.set(this.$el, owner);
    }
  });
  router.afterEach((to, _from, failure) => {
    if (!epoch || failure) return;
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
  // Consent can change in another window, so every settings change and
  // reconnection rereads it.
  refresh = () => { void loadTelemetrySettings().then((settings) => apply(settings, router)).catch(() => undefined); };
  window.addEventListener('patterm:telemetry-changed', (event) => apply((event as CustomEvent<TelemetrySettings>).detail, router));
  window.patterm.onDataChanged?.((topics) => { if (topics.includes('settings')) refresh(); });
  window.patterm.onConnectionChanged?.((state) => { if (state === 'connected') refresh(); });
  refresh();
}

let refresh = (): void => undefined;

// Counts a command palette command by kind.
export function countCommand(id: string): void {
  if (!epoch) return;
  const kind = commandKind(id);
  commands[kind] = (commands[kind] ?? 0) + 1;
}

function appOwner(instance: ComponentInternalInstance): string | null {
  for (let current: ComponentInternalInstance | null = instance; current; current = current.parent) {
    const type = current.type as { __name?: string; name?: string };
    const name = type.__name ?? type.name;
    if (name && APP_COMPONENTS.has(name)) return name;
  }
  return null;
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
  if (!epoch || !(event.target instanceof Element)) return;
  const feature = featureFor(event.target);
  if (feature) clicks[feature] = (clicks[feature] ?? 0) + 1;
}

// Shortcuts only: a key pressed with Ctrl, Alt, or Meta.
function onKey(event: KeyboardEvent): void {
  if (!epoch || !(event.ctrlKey || event.altKey || event.metaKey) || ['Control', 'Alt', 'Meta', 'Shift'].includes(event.key)) return;
  const key = event.key === ' ' ? 'Space' : event.key.length === 1 && /[a-z0-9]/i.test(event.key) ? event.key.toLowerCase() : NAMED_KEYS.has(event.key) ? event.key : null;
  if (!key) return;
  const combo = `key:${[event.ctrlKey && 'ctrl', event.altKey && 'alt', event.metaKey && 'meta', event.shiftKey && 'shift', key].filter(Boolean).join('+')}`;
  clicks[combo] = (clicks[combo] ?? 0) + 1;
}

// Starts counting afresh for a new opt-in, or stops while telemetry is off.
// Nothing counted under one epoch is sent under another.
function apply(settings: TelemetrySettings, router: Router): void {
  const next = settings.enabled ? settings.epoch ?? null : null;
  if (next === epoch) return;
  epoch = next;
  clicks = {}; commands = {}; views = {}; seconds = {};
  page = null;
  inventorySent = false;
  if (timer) clearInterval(timer);
  timer = null;
  if (!epoch) return;
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
  if (!epoch) return;
  const payload = {
    epoch,
    app_version: __PATTERM_VERSION__,
    clicks,
    commands,
    views,
    seconds: Object.fromEntries(Object.entries(seconds).map(([name, value]) => [name, Math.min(86_400, Math.round(value))]).filter(([, value]) => Number(value) > 0)),
    ...(inventorySent ? {} : { components })
  };
  clicks = {}; commands = {}; views = {}; seconds = {};
  if (!Object.keys(payload.clicks).length && !Object.keys(payload.commands).length && !Object.keys(payload.views).length && !Object.keys(payload.seconds).length && inventorySent) return;
  try {
    const result = await window.patterm.call('telemetry_record', payload) as { accepted: boolean };
    // Refused: telemetry was turned off or on again elsewhere.
    if (!result.accepted) refresh();
    else inventorySent = true;
  } catch {
    // Dropped: telemetry is best effort and never retried.
  }
}
