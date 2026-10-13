// HTML figures: agents write a self-contained page and Patterm shows it in a
// sandboxed frame where the reply places its token. This module is the one
// definition of the tool inputs, the theme and layout cues agents get, and
// the frame a page runs in. It is pure so the MCP tools, the renderer and the
// desktop preview share it.

import { z } from 'zod';
import { resolveTerminalFontFamily, resolveUiFontFamily, type FontSettings } from './FontFamilies';
import { FIGURE_ID, type TranscriptTool } from './TranscriptProjection';

export const HTML_RENDER_TOOL = 'html_render';
export const HTML_PREVIEW_TOOL = 'html_preview';
export const MAX_FIGURE_HTML_CHARS = 512_000;
export const FIGURE_HEIGHT = { min: 80, max: 2000, initial: 240 } as const;
export const PREVIEW_WIDTH = { min: 240, max: 1600, initial: 728 } as const;
// The transcript column; previews default to it.
export const FIGURE_FRAME_SCHEME = 'patterm-frame';
export const FIGURE_FRAME_PATH = '/figure-frame';

const html = z.string().min(1, 'send the page as html').max(MAX_FIGURE_HTML_CHARS, `keep the page under ${MAX_FIGURE_HTML_CHARS} characters`);

export const htmlRenderInput = z.object({
  id: z.string().regex(new RegExp(`^${FIGURE_ID}$`), 'use letters, digits, _ and -, up to 48').optional(),
  title: z.string().trim().min(1).max(200),
  html,
  height: z.number().int().optional()
}).strict();
export type HtmlRenderInput = z.infer<typeof htmlRenderInput>;

export const htmlPreviewInput = z.object({
  html,
  width: z.number().int().min(PREVIEW_WIDTH.min).max(PREVIEW_WIDTH.max).optional()
}).strict();
export type HtmlPreviewInput = z.infer<typeof htmlPreviewInput>;

export function formatInputErrors(error: z.ZodError): string[] {
  return error.issues.slice(0, 8).map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`);
}

export function clampFigureHeight(height: number | undefined): number {
  return Math.min(FIGURE_HEIGHT.max, Math.max(FIGURE_HEIGHT.min, height ?? FIGURE_HEIGHT.initial));
}

/* ---------- theme and cues ---------- */

// Patterm is dark only. Full colours, so pages use var(--x) directly.
export const FIGURE_THEME: Readonly<Record<string, string>> = {
  '--background': 'hsl(0 0% 8.2%)',
  '--foreground': 'hsl(0 0% 98%)',
  '--card': 'hsl(0 0% 8.2%)',
  '--popover': 'hsl(0 0% 11%)',
  '--muted': 'hsl(240 3.7% 15.9%)',
  '--muted-foreground': 'hsl(240 5% 64.9%)',
  '--border': 'hsl(240 3.7% 15.9%)',
  '--primary': 'hsl(0 0% 98%)',
  '--primary-foreground': 'hsl(240 5.9% 10%)',
  '--accent': 'hsl(217 91% 64%)',
  '--success': 'hsl(142 70% 45%)',
  '--warning': 'hsl(38 92% 55%)',
  '--destructive': 'hsl(0 90.6% 70.8%)',
  '--chart-1': 'hsl(217 91% 64%)',
  '--chart-2': 'hsl(173 58% 50%)',
  '--chart-3': 'hsl(38 92% 60%)',
  '--chart-4': 'hsl(262 83% 72%)',
  '--chart-5': 'hsl(330 81% 68%)',
  '--chart-6': 'hsl(142 60% 55%)',
  '--radius': '12px',
  '--font-sans': 'Inter, ui-sans-serif, system-ui, sans-serif',
  '--font-mono': 'ui-monospace, SFMono-Regular, Menlo, "Cascadia Mono", Consolas, monospace'
};

export const FIGURE_LAYOUT_GUIDE = 'The page sits inside the reply, on the transcript background: no page background, no outer padding, no card or title banner (the title is shown for you), and fluid width (the column is 320 to 900 px). Give charts a fixed pixel height; never use 100vh. Boxes that need their own surface use var(--muted) or a 1px var(--border) with border-radius var(--radius) and 16px padding. Keep text 13 to 14 px; use muted text, not colour, for secondary detail.';
export const FIGURE_THEME_GUIDE = `Theme variables are set on :root: ${Object.keys(FIGURE_THEME).join(', ')}. Use --chart-1..6 for series in order, --success/--warning/--destructive only for good/warn/bad meaning, --accent for one highlight. Tables, links and code already follow the theme.`;
export const FIGURE_BRIDGE_GUIDE = 'To ask the user, call patterm.answer(id, { label, value }) (or an array of { item, label, value }) when they pick; Patterm asks them to confirm, and the pick reaches you as "Answer to <id>: <label> (<value>)", so end your turn to wait. The promise settles when they send or cancel. patterm.answered(id) gives the earlier answer text or null and patterm.canAnswer says whether this window may answer; patterm.onChange(fn) runs when either changes. Clicked http(s) links open in the browser once the user confirms.';

// Element defaults sit in :where() so any rule in the page wins.
const BASE_CSS = `:root{color-scheme:dark;${Object.entries(FIGURE_THEME).map(([name, value]) => `${name}:${value}`).join(';')}}
:where(html,body){margin:0;padding:0;background:transparent;color:var(--foreground);font:14px/1.5 var(--font-sans);-webkit-font-smoothing:antialiased}
:where(html){scrollbar-width:none}
:where(table){width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
:where(th){padding:6px 12px 6px 0;border-bottom:1px solid var(--border);color:var(--muted-foreground);font-weight:500;text-align:left}
:where(td){padding:6px 12px 6px 0;border-bottom:1px solid var(--border)}
:where(a){color:var(--accent)}
:where(code,pre,kbd){font-family:var(--font-mono);font-size:12px}
:where(button){font:inherit;color:inherit;background:var(--muted);border:1px solid var(--border);border-radius:8px;padding:4px 10px;cursor:pointer}
:where(button:disabled){opacity:.5;cursor:default}`;

/* ---------- fonts ---------- */

// Pages use the user's interface and terminal typefaces. The frame's opaque
// origin cannot load Patterm's bundled fonts, so a bundled family's Latin
// faces travel inline; system and custom families are installed, and load by
// name. The renderer and the desktop preview read the same files.
export const FIGURE_FONT_SUBSETS = {
  latin: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  'latin-ext': 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF'
} as const;
export type FigureFontSubset = keyof typeof FIGURE_FONT_SUBSETS;
export const FIGURE_SANS_WEIGHTS = [400, 500, 600, 700] as const;
export const FIGURE_MONO_WEIGHTS = [400, 700] as const;
// Vendored under resources/js/assets/fonts/<slug>.
export const BUNDLED_FIGURE_FONTS = ['inter', 'geist', 'fira-sans', 'ibm-plex-sans', 'jetbrains-mono', 'geist-mono', 'fira-code', 'iosevka', 'ibm-plex-mono', 'source-code-pro', 'comic-mono'] as const;

export interface FigureFont { name: string; slug: string; weights: readonly number[] }

// The first bundled family in a font stack, such as "JetBrains Mono" behind an
// installed Nerd Font, so the page still has it when the first is missing.
export function bundledFigureFont(family: string, weights: readonly number[]): FigureFont | null {
  for (const part of family.split(',')) {
    const name = part.trim().replace(/^["']|["']$/g, '');
    const slug = name.toLowerCase().replace(/\s+/g, '-');
    if ((BUNDLED_FIGURE_FONTS as readonly string[]).includes(slug)) return { name, slug, weights };
  }
  return null;
}

// A face's path below the fonts directory.
export function figureFontFile(slug: string, subset: FigureFontSubset, weight: number): string {
  return `${slug}/${slug}-${subset}-${weight}-normal.woff2`;
}

// @font-face rules for each face the source gives as a data URL.
export function figureFontFaces(font: FigureFont, source: (file: string) => string | null): string {
  const rules: string[] = [];
  for (const [subset, range] of Object.entries(FIGURE_FONT_SUBSETS) as Array<[FigureFontSubset, string]>) {
    for (const weight of font.weights) {
      const url = source(figureFontFile(font.slug, subset, weight));
      if (url) rules.push(`@font-face{font-family:${JSON.stringify(font.name)};font-style:normal;font-display:block;font-weight:${weight};src:url(${url}) format('woff2');unicode-range:${range}}`);
    }
  }
  return rules.join('\n');
}

// The families as theme variables, then their faces. A custom family is the
// user's own text, so nothing in it can close the rule or the style.
export function figureFontCss(sans: string, mono: string, faces: string): string {
  const clean = (family: string) => family.replace(/[<>{};\\]/g, '');
  return `:root{--font-sans:${clean(sans)};--font-mono:${clean(mono)}}${faces ? `\n${faces}` : ''}`;
}

// The faces a user's interface and terminal typefaces need inline.
export function figureFontsFor(settings: FontSettings): { sans: string; mono: string; fonts: FigureFont[]; files: string[] } {
  const sans = resolveUiFontFamily(settings);
  const mono = resolveTerminalFontFamily(settings);
  const fonts = [bundledFigureFont(sans, FIGURE_SANS_WEIGHTS), bundledFigureFont(mono, FIGURE_MONO_WEIGHTS)].filter((font): font is FigureFont => font !== null);
  const files = fonts.flatMap((font) => (Object.keys(FIGURE_FONT_SUBSETS) as FigureFontSubset[]).flatMap((subset) => font.weights.map((weight) => figureFontFile(font.slug, subset, weight))));
  return { sans, mono, fonts, files };
}

// The fonts style for a page, from faces already read as data URLs.
export function figureFontStyle(settings: FontSettings, source: (file: string) => string | null): string {
  const { sans, mono, fonts } = figureFontsFor(settings);
  return figureFontCss(sans, mono, fonts.map((font) => figureFontFaces(font, source)).filter(Boolean).join('\n'));
}

/* ---------- frame ---------- */

// The page runs in this frame's document, written in once the host sends it.
// Its own policy lets the page run inline and CDN scripts; the sandbox gives
// it an opaque origin, so it cannot reach Patterm's API, storage or window.
export const FIGURE_FRAME_HTML = `<!doctype html><html><head><meta charset="utf-8"><script>
addEventListener('message', function render(event) {
  if (event.source !== parent || !event.data || event.data.source !== 'patterm-host' || event.data.type !== 'render') return;
  removeEventListener('message', render);
  document.open();
  document.write(event.data.html);
  document.close();
});
parent.postMessage({ source: 'patterm-figure', type: 'ready' }, '*');
</script></head><body></body></html>`;

// No popups: Electron does not hold them to a click, so links go through
// Patterm's own confirm bar. Never allow-same-origin.
export const FIGURE_FRAME_SANDBOX = 'allow-scripts allow-forms';

export function figureFrameCsp(frameAncestors: string | null): string {
  return [
    `sandbox ${FIGURE_FRAME_SANDBOX}`,
    "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'",
    "form-action 'none'",
    "base-uri 'none'",
    ...(frameAncestors ? [`frame-ancestors ${frameAncestors}`] : [])
  ].join('; ');
}

// Runs first in every page: reports its height, hands links to Patterm and
// exposes the answer bridge.
const BOOTSTRAP = `(function () {
  var host = window.parent;
  var state = { answers: {}, canAnswer: false };
  var listeners = [];
  var pending = {};
  var nextRequest = 1;
  var lastHeight = -1;
  function post(message) { message.source = 'patterm-figure'; host.postMessage(message, '*'); }
  function report() {
    var root = document.documentElement;
    var height = Math.ceil(Math.max(root.getBoundingClientRect().height, document.body ? document.body.scrollHeight : 0));
    if (height !== lastHeight) { lastHeight = height; post({ type: 'size', height: height }); }
  }
  var observer = new ResizeObserver(report);
  observer.observe(document.documentElement);
  document.addEventListener('DOMContentLoaded', function () { if (document.body) observer.observe(document.body); report(); });
  addEventListener('load', report);
  // Web links ask Patterm, which shows the address for the user to open;
  // anything else would navigate the frame.
  document.addEventListener('click', function (event) {
    var link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!link || link.getAttribute('href').charAt(0) === '#') return;
    event.preventDefault();
    if (/^https?:/i.test(link.href)) post({ type: 'open-link', url: link.href });
  }, true);
  addEventListener('message', function (event) {
    if (event.source !== host || !event.data || event.data.source !== 'patterm-host') return;
    var data = event.data;
    if (data.type === 'state') {
      state = { answers: data.answers || {}, canAnswer: Boolean(data.canAnswer) };
      listeners.slice().forEach(function (listener) { try { listener(); } catch (error) { console.error(error); } });
    } else if (data.type === 'answer-result' && pending[data.requestId]) {
      var request = pending[data.requestId];
      delete pending[data.requestId];
      if (data.ok) request.resolve(); else request.reject(new Error(data.error || 'The answer was not sent'));
    }
  });
  window.patterm = Object.freeze({
    answer: function (id, picks) {
      return new Promise(function (resolve, reject) {
        var requestId = nextRequest++;
        pending[requestId] = { resolve: resolve, reject: reject };
        post({ type: 'answer', requestId: requestId, id: String(id), picks: JSON.parse(JSON.stringify(Array.isArray(picks) ? picks : [picks])) });
      });
    },
    answered: function (id) { return state.answers[id] || null; },
    get canAnswer() { return state.canAnswer; },
    onChange: function (listener) { listeners.push(listener); }
  });
})();`;

// The agent's page with the theme and bootstrap first in <head>, so its own
// rules and scripts follow them.
export function prepareFigureHtml(page: string, fontCss = ''): string {
  const head = `<style id="patterm-theme">${BASE_CSS}</style>${fontCss ? `<style id="patterm-fonts">${fontCss}</style>` : ''}<script>${BOOTSTRAP}</script>`;
  const opening = /<head\b[^>]*>/i.exec(page);
  if (opening) return page.slice(0, opening.index + opening[0].length) + head + page.slice(opening.index + opening[0].length);
  const html = /<html\b[^>]*>/i.exec(page);
  if (html) return `${page.slice(0, html.index + html[0].length)}<head>${head}</head>${page.slice(html.index + html[0].length)}`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(page);
  return doctype ? `${doctype[0]}<head>${head}</head>${page.slice(doctype[0].length)}` : `<!doctype html><head>${head}</head>${page}`;
}

/* ---------- local images ---------- */

const IMG_SRC = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"']+)\2/gi;
const CSS_URL = /(url\(\s*)(["']?)([^"')\s]+)\2(\s*\))/gi;

// A path, not a URL. A Windows drive (C:\ or C:/) looks like a URL scheme.
function isLocalPath(value: string): boolean {
  if (/^[a-z]:[\\/]/i.test(value)) return true;
  return !/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith('//') && !value.startsWith('#');
}

// Local files a page shows through <img src> or CSS url().
export function figureImagePaths(page: string): string[] {
  const paths = new Set<string>();
  for (const pattern of [IMG_SRC, CSS_URL]) {
    for (const match of page.matchAll(pattern)) if (isLocalPath(match[3]!)) paths.add(match[3]!);
  }
  return [...paths];
}

// Swaps each stored local path for its data URL; the frame cannot read files.
export function replaceFigureImages(page: string, urls: ReadonlyMap<string, string>): string {
  if (!urls.size) return page;
  const swap = (match: string, before: string, quote: string, value: string, after = '') => {
    const url = urls.get(value);
    return url ? `${before}${quote || '"'}${url}${quote || '"'}${after}` : match;
  };
  return page
    .replace(IMG_SRC, (match, before: string, quote: string, value: string) => swap(match, before, quote, value))
    .replace(CSS_URL, (match, before: string, quote: string, value: string, after: string) => swap(match, before, quote, value, after));
}

/* ---------- transcript rows ---------- */

export { figureAnswers, figureAnswerText, figureId, figureToken, figureToolInput, isFigureTool, isSavedFigure } from './TranscriptProjection';

// The page a saved figure's call sent, or null for anything unreadable.
export function figurePage(input: unknown): { title: string; html: string; height?: number | undefined } | null {
  const parsed = htmlRenderInput.safeParse(input);
  return parsed.success ? parsed.data : null;
}

// The tool's reply maps each image path to its stored copy. Harnesses keep the
// reply as structured content, a content array, or plain text; Codex keeps the
// whole content wrapper as JSON text, so the reply is escaped one level down.
export function figureImages(tool: TranscriptTool): Record<string, string> {
  for (const candidate of [tool.result, tool.output, tool.state]) {
    const images = findImages(candidate, 0);
    if (images) return images;
  }
  return {};
}

function findImages(value: unknown, depth: number): Record<string, string> | null {
  if (depth > 8 || value === null || value === undefined) return null;
  if (typeof value === 'string') {
    if (!value.includes('images')) return null;
    try { return findImages(JSON.parse(value), depth + 1); } catch { return null; }
  }
  if (Array.isArray(value)) {
    for (const item of value) { const found = findImages(item, depth + 1); if (found) return found; }
    return null;
  }
  if (typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.images && typeof record.images === 'object' && !Array.isArray(record.images)) {
    return Object.fromEntries(Object.entries(record.images).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && /^[0-9a-f]{64}$/.test(entry[1])));
  }
  for (const key of ['structuredContent', 'content', 'text', 'result', 'output']) {
    const found = findImages(record[key], depth + 1);
    if (found) return found;
  }
  return null;
}
