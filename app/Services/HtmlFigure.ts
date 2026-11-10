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

// Saved templates are named like status-cards/verdict: lowercase words with
// hyphens, in up to four parts.
export const FIGURE_TEMPLATE_NAME = '[a-z0-9][a-z0-9-]{0,39}(?:/[a-z0-9][a-z0-9-]{0,39}){0,3}';
export const figureTemplateName = z.string().max(120).regex(new RegExp(`^${FIGURE_TEMPLATE_NAME}$`), 'use lowercase letters, digits and -, in parts split by /, such as status-cards/verdict');
export const MAX_FIGURE_DATA_CHARS = 128_000;

// A page is either the agent's own html, or a saved template and the data
// it draws, checked against the template's schema before anything shows.
export const htmlRenderInput = z.object({
  id: z.string().regex(new RegExp(`^${FIGURE_ID}$`), 'use letters, digits, _ and -, up to 48').optional(),
  title: z.string().trim().min(1).max(200),
  html: html.optional(),
  template: figureTemplateName.optional(),
  version: z.number().int().min(1).optional(),
  data: z.unknown().optional(),
  height: z.number().int().optional()
}).strict().superRefine((input, context) => {
  if (input.html !== undefined && input.template !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['template'], message: 'send html or template, not both' });
  else if (input.html === undefined && input.template === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['html'], message: 'send the page as html, or name a saved template with its data' });
  if (input.template === undefined && (input.data !== undefined || input.version !== undefined)) context.addIssue({ code: z.ZodIssueCode.custom, path: [input.data !== undefined ? 'data' : 'version'], message: 'data and version go with template' });
  if (input.template !== undefined && input.data === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['data'], message: 'send the data the template draws' });
});
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

export const FIGURE_LAYOUT_GUIDE = 'The page sits inside the reply, on the transcript background: no page background, no outer padding, no card or title banner (the title is shown for you), and fluid width (the column is 320 to 900 px). Give charts a fixed pixel height; never use 100vh. Never set preserveAspectRatio="none": it stretches text. Size SVG to its width (redraw on resize) and keep labels inside it. Boxes that need their own surface use var(--muted) or a 1px var(--border) with border-radius var(--radius) and 16px padding. Keep text 13 to 14 px; use muted text, not colour, for secondary detail.';
export const FIGURE_THEME_GUIDE = `Theme variables are set on :root: ${Object.keys(FIGURE_THEME).join(', ')}. Use --chart-1..6 for series in order, --success/--warning/--destructive only for good/warn/bad meaning, --accent for one highlight. Tables, links and code already follow the theme.`;
export const FIGURE_BRIDGE_GUIDE = 'To ask the user, call patterm.answer(id, { label, value }) (or an array of { item, label, value }) in the handler of their click; it sends at once, and only during a click or key press in the page. The pick reaches you as "Answer to <id>: <label> (<value>)", so end your turn to wait. The promise rejects if it was not sent. patterm.answered(id) gives the earlier answer text or null and patterm.canAnswer says whether this window may answer; patterm.onChange(fn) runs when either changes. Clicked http(s) links open in the browser once the user confirms.';

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

// The page runs in this frame's document, written in once the host sends it,
// with any videos it plays as Blobs; blob: URLs belong to the origin that
// made them, so the frame makes its own.
// Its own policy lets the page run inline and CDN scripts; the sandbox gives
// it an opaque origin, so it cannot reach Patterm's API, storage or window.
// It shares Patterm's dark scheme: a frame in another scheme gets an opaque
// backdrop, which flashes white until the page is written in.
export const FIGURE_FRAME_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="dark"><script>
addEventListener('message', function render(event) {
  if (event.source !== parent || !event.data || event.data.source !== 'patterm-host' || event.data.type !== 'render') return;
  removeEventListener('message', render);
  var html = String(event.data.html);
  var media = event.data.media || {};
  for (var placeholder in media) {
    if (media[placeholder] instanceof Blob) html = html.split(placeholder).join(URL.createObjectURL(media[placeholder]));
  }
  document.open();
  document.write(html);
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
// exposes the answer bridge, and a template's data.
const bootstrap = (data: string) => `(function () {
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
  // An SVG stretched to the frame distorts its text and dots, and pages are
  // wider or narrower than their author assumed, so drawings with text keep
  // their shape and fit instead.
  function unstretch() {
    var drawings = document.getElementsByTagName('svg');
    for (var i = 0; i < drawings.length; i++) {
      var svg = drawings[i];
      if (/^\s*none\s*$/i.test(svg.getAttribute('preserveAspectRatio') || '') && svg.getElementsByTagName('text').length) svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    }
  }
  new MutationObserver(unstretch).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['preserveAspectRatio'] });
  document.addEventListener('DOMContentLoaded', function () { if (document.body) observer.observe(document.body); unstretch(); report(); });
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
    onChange: function (listener) { listeners.push(listener); },
    data: ${data}
  });
})();`;

// The agent's page with the theme and bootstrap first in <head>, so its own
// rules and scripts follow them. A template's data is also patterm.data.
export function prepareFigureHtml(page: string, fontCss = ''): string {
  return insertHead(page, figureHead(fontCss, 'null'));
}

function figureHead(fontCss: string, data: string): string {
  return `<style id="patterm-theme">${BASE_CSS}</style>${fontCss ? `<style id="patterm-fonts">${fontCss}</style>` : ''}<script>${bootstrap(data)}</script>`;
}

function insertHead(page: string, head: string): string {
  const opening = /<head\b[^>]*>/i.exec(page);
  if (opening) return page.slice(0, opening.index + opening[0].length) + head + page.slice(opening.index + opening[0].length);
  const html = /<html\b[^>]*>/i.exec(page);
  if (html) return `${page.slice(0, html.index + html[0].length)}<head>${head}</head>${page.slice(html.index + html[0].length)}`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(page);
  return doctype ? `${doctype[0]}<head>${head}</head>${page.slice(doctype[0].length)}` : `<!doctype html><head>${head}</head>${page}`;
}

/* ---------- templates ---------- */

// JSON that is also safe inside a <script>: nothing in it can close the tag.
function scriptJson(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

// A saved template's page drawing this data. Nothing is searched for in the
// page, where comments, scripts and text such as a <textarea> can hold
// lookalike tags: Patterm's theme, bootstrap and the data block, in the
// <script type="application/json" id="data"> the status cards read, go
// before the page. The parser puts them in <head>, ignores the page's own
// doctype and <head> tag, and merges its <html> attributes, so the data is
// the first element with that id and getElementById finds it. A sample
// block in the page stays below it, unread. Templates always draw in
// standards mode. The data is also patterm.data.
export function prepareTemplateHtml(page: string, data: unknown, fontCss = ''): string {
  const json = scriptJson(data);
  return `<!doctype html>${figureHead(fontCss, json)}<script type="application/json" id="data">${json}</script>${page}`;
}

/* ---------- local images and videos ---------- */

const IMG_SRC = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"']+)\2/gi;
const VIDEO_POSTER = /(<video\b[^>]*?\bposter\s*=\s*)(["'])([^"']+)\2/gi;
const CSS_URL = /(url\(\s*)(["']?)([^"')\s]+)\2(\s*\))/gi;
const VIDEO_SRC = /(<(?:video|source)\b[^>]*?\bsrc\s*=\s*)(["'])([^"']+)\2/gi;

// A path, not a URL. A Windows drive (C:\ or C:/) looks like a URL scheme.
function isLocalPath(value: string): boolean {
  if (/^[a-z]:[\\/]/i.test(value)) return true;
  return !/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith('//') && !value.startsWith('#');
}

function localPaths(page: string, patterns: RegExp[]): string[] {
  const paths = new Set<string>();
  for (const pattern of patterns) {
    for (const match of page.matchAll(pattern)) if (isLocalPath(match[3]!)) paths.add(match[3]!);
  }
  return [...paths];
}

// Local files a page shows through <img src>, a video's poster or CSS url().
export function figureImagePaths(page: string): string[] {
  return localPaths(page, [IMG_SRC, VIDEO_POSTER, CSS_URL]);
}

// Local files a page plays through <video src> or <source src>.
export function figureVideoPaths(page: string): string[] {
  return localPaths(page, [VIDEO_SRC]);
}

function swapper(urls: ReadonlyMap<string, string>) {
  return (match: string, before: string, quote: string, value: string, after = '') => {
    const url = urls.get(value);
    return url ? `${before}${quote || '"'}${url}${quote || '"'}${after}` : match;
  };
}

// Swaps each stored local path for its data URL; the frame cannot read files.
export function replaceFigureImages(page: string, urls: ReadonlyMap<string, string>): string {
  if (!urls.size) return page;
  const swap = swapper(urls);
  return page
    .replace(IMG_SRC, (match, before: string, quote: string, value: string) => swap(match, before, quote, value))
    .replace(VIDEO_POSTER, (match, before: string, quote: string, value: string) => swap(match, before, quote, value))
    .replace(CSS_URL, (match, before: string, quote: string, value: string, after: string) => swap(match, before, quote, value, after));
}

// Swaps each stored video path for a placeholder. Videos are too large to
// travel inside the page, so the host posts each one to the frame as a Blob
// beside the page, and the frame puts its own blob: URL where the
// placeholder is (see FIGURE_FRAME_HTML).
export function replaceFigureVideos(page: string, placeholders: ReadonlyMap<string, string>): string {
  if (!placeholders.size) return page;
  const swap = swapper(placeholders);
  return page.replace(VIDEO_SRC, (match, before: string, quote: string, value: string) => swap(match, before, quote, value));
}

/* ---------- transcript rows ---------- */

export { figureAnswers, figureAnswerText, figureId, figureToken, figureToolInput, isFigureTool, isSavedFigure } from './TranscriptProjection';

export type FigurePage =
  | { id?: string | undefined; title: string; html: string; height?: number | undefined }
  | { id?: string | undefined; title: string; template: string; data: unknown; height?: number | undefined };

// The page a saved figure's call sent, or null for anything unreadable.
export function figurePage(input: unknown): FigurePage | null {
  const parsed = htmlRenderInput.safeParse(input);
  if (!parsed.success) return null;
  const { id, title, height, html, template, data } = parsed.data;
  const common = { ...(id !== undefined ? { id } : {}), title, ...(height !== undefined ? { height } : {}) };
  if (template !== undefined) return { ...common, template, data };
  return html === undefined ? null : { ...common, html };
}

// The template version a figure drew, as its reply recorded it. The call
// may leave the version out; the reply always says which one it used.
export function figureTemplate(tool: TranscriptTool): { name: string; version: number } | null {
  const name = new RegExp(`^${FIGURE_TEMPLATE_NAME}$`);
  for (const candidate of [tool.result, tool.output, tool.state]) {
    const found = findInReply(candidate, 'template', 0, (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const record = value as Record<string, unknown>;
      return typeof record.name === 'string' && name.test(record.name) && Number.isInteger(record.version) && (record.version as number) > 0 ? { name: record.name, version: record.version as number } : null;
    });
    if (found) return found;
  }
  return null;
}

// The tool's reply maps each image or video path to its stored copy.
// Harnesses keep the reply as structured content, a content array, or plain
// text; Codex keeps the whole content wrapper as JSON text, so the reply is
// escaped one level down.
export function figureImages(tool: TranscriptTool): Record<string, string> {
  return figureMedia(tool, 'images');
}

export function figureVideos(tool: TranscriptTool): Record<string, string> {
  return figureMedia(tool, 'videos');
}

function figureMedia(tool: TranscriptTool, key: 'images' | 'videos'): Record<string, string> {
  const hashes = (media: unknown) => media && typeof media === 'object' && !Array.isArray(media)
    ? Object.fromEntries(Object.entries(media).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && /^[0-9a-f]{64}$/.test(entry[1])))
    : null;
  for (const candidate of [tool.result, tool.output, tool.state]) {
    const found = findInReply(candidate, key, 0, hashes);
    if (found) return found;
  }
  return {};
}

function findInReply<T>(value: unknown, key: string, depth: number, accept: (found: unknown) => T | null): T | null {
  if (depth > 8 || value === null || value === undefined) return null;
  if (typeof value === 'string') {
    if (!value.includes(key)) return null;
    try { return findInReply(JSON.parse(value), key, depth + 1, accept); } catch { return null; }
  }
  if (Array.isArray(value)) {
    for (const item of value) { const found = findInReply(item, key, depth + 1, accept); if (found) return found; }
    return null;
  }
  if (typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const accepted = key in record ? accept(record[key]) : null;
  if (accepted) return accepted;
  for (const nested of ['structuredContent', 'content', 'text', 'result', 'output']) {
    const found = findInReply(record[nested], key, depth + 1, accept);
    if (found) return found;
  }
  return null;
}
