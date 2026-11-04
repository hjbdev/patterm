// Wiring for HTML figures: where their frame loads from, and the answer
// channel between the conversation and its pages. Components stay
// presentational; pages themselves run in the sandboxed frame.

import { ref, type ComputedRef, type InjectionKey } from 'vue';
import { APPEARANCE_SETTINGS_CHANGED_EVENT, DEFAULT_APPEARANCE_SETTINGS, lastKnownAppearanceSettings, loadAppearanceSettings } from '../appearance/AppearanceSettings';
import { FIGURE_FRAME_PATH, FIGURE_FRAME_SCHEME } from '../../../app/Services/HtmlFigure';
import type { FontSettings } from '../../../app/Services/FontFamilies';
import type { TranscriptMessage } from '../../../app/Services/TranscriptProjection';
import { transcriptImageData } from './transcriptImages';

// Sending answers belongs to the live conversation. History and other
// read-only transcripts provide nothing, so pages there cannot answer.
export interface FigureAnswerChannel {
  canSend: ComputedRef<boolean>;
  send: (text: string) => Promise<void> | void;
  // Answers waiting in the agent's queue, which the transcript leaves out
  // until they are delivered.
  queued: ComputedRef<Map<string, string>>;
}
export const figureAnswerKey: InjectionKey<FigureAnswerChannel> = Symbol('figureAnswer');
export const figureAnsweredKey: InjectionKey<ComputedRef<Map<string, string>>> = Symbol('figureAnswered');
// Pages a transcript can place inline, by id.
export const figuresKey: InjectionKey<ComputedRef<Map<string, TranscriptMessage>>> = Symbol('figures');

// The browser server serves the frame itself; the desktop app answers its
// own scheme, since a file:// page cannot give a child frame its own policy.
export function figureFrameUrl(): string {
  return window.patterm.runtime === 'browser' ? FIGURE_FRAME_PATH : `${FIGURE_FRAME_SCHEME}://figure/`;
}

// A page can focus its own frame. Done while the user types elsewhere, it
// would catch their next keys, and a key press in the frame lets the page
// answer, so Patterm gives the focus straight back. Tab moves focus on purpose.
let focusGuarded = false;
export function guardFigureFocus(): void {
  if (focusGuarded) return;
  focusGuarded = true;
  let typedAt = -Infinity;
  window.addEventListener('keydown', (event) => { if (event.key !== 'Tab') typedAt = performance.now(); }, true);
  document.addEventListener('focusout', (event) => {
    const left = event.target;
    if (!(left instanceof HTMLElement) || !(left.isContentEditable || left.matches('input, textarea')) || performance.now() - typedAt > TYPING_MS) return;
    setTimeout(() => {
      const taker = document.activeElement;
      if (taker instanceof HTMLIFrameElement && taker.dataset.component === 'html-figure-frame' && left.isConnected) left.focus();
    });
  }, true);
}
const TYPING_MS = 2000;

// A page's stored local images as data URLs; the frame cannot read anything
// from Patterm, so each image travels inside the page.
export async function figureImageUrls(images: Record<string, string>): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  await Promise.all(Object.entries(images).map(async ([requested, sha256]) => {
    try {
      const image = await transcriptImageData(sha256);
      urls.set(requested, `data:${image.mime};base64,${image.data}`);
    } catch {
      // A pruned image stays a broken image in the page.
    }
  }));
  return urls;
}

// A page's stored local videos as Blobs, under fresh placeholders the page
// carries in their place; the frame turns each into its own blob: URL. Recent
// videos stay cached up to a budget, so a page shown again does not fetch
// them again; the newest is always kept.
const VIDEO_CACHE_BYTES = 256 * 1024 * 1024;
const videos = new Map<string, { loading: Promise<Blob>; size: number }>();
function figureVideo(sha256: string): Promise<Blob> {
  const cached = videos.get(sha256);
  if (cached) { videos.delete(sha256); videos.set(sha256, cached); return cached.loading; }
  const entry = { loading: window.patterm.figureVideo?.(sha256) ?? Promise.reject(new Error('Videos are unavailable in this client')), size: 0 };
  videos.set(sha256, entry);
  entry.loading.then((blob) => {
    entry.size = blob.size;
    let total = [...videos.values()].reduce((sum, item) => sum + item.size, 0);
    for (const [key, item] of videos) {
      if (total <= VIDEO_CACHE_BYTES || item === entry) break;
      videos.delete(key);
      total -= item.size;
    }
  }, () => { if (videos.get(sha256) === entry) videos.delete(sha256); });
  return entry.loading;
}

// Unguessable, and available outside secure contexts, unlike randomUUID.
function placeholder(): string {
  return `patterm-video:${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function figureVideoBlobs(stored: Record<string, string>): Promise<{ placeholders: Map<string, string>; media: Map<string, Blob>; missing: number }> {
  const placeholders = new Map<string, string>();
  const media = new Map<string, Blob>();
  let missing = 0;
  await Promise.all(Object.entries(stored).map(async ([requested, sha256]) => {
    try {
      const blob = await figureVideo(sha256);
      const token = placeholder();
      placeholders.set(requested, token);
      media.set(token, blob);
    } catch {
      // A pruned video, or one stored on another host, stays unplayable.
      missing++;
    }
  }));
  return { placeholders, media, missing };
}

// The fonts style for pages in the user's current typefaces. Changing them in
// Settings bumps the version, so shown pages redraw in the new ones.
export const figureFontVersion = ref(0);
const fontKey = (settings: FontSettings) => JSON.stringify([settings.uiFont, settings.terminalFont]);
let shownKey: string | null = null;
window.addEventListener(APPEARANCE_SETTINGS_CHANGED_EVENT, (event) => {
  const key = fontKey((event as CustomEvent<FontSettings>).detail);
  if (shownKey !== null && key !== shownKey) figureFontVersion.value++;
});
const styles = new Map<string, Promise<string>>();
export async function figureFontCss(): Promise<string> {
  const settings = lastKnownAppearanceSettings() ?? await loadAppearanceSettings().catch(() => DEFAULT_APPEARANCE_SETTINGS);
  const key = fontKey(settings);
  shownKey = key;
  let style = styles.get(key);
  if (!style) {
    style = import('./figureFonts').then((module) => module.figureFontStyleFor(settings));
    style.catch(() => styles.delete(key));
    styles.set(key, style);
  }
  return style.catch(() => '');
}
