import MarkdownIt from 'markdown-it';
import { splitProcessMentions } from './agentMentions';
import type { CodeBlock } from './codeHighlight';

// html:false keeps raw HTML in source inert (rendered as escaped text), and
// markdown-it's default link validation rejects dangerous URL schemes.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

// Antigravity cites source files with file: URLs. Parse those references, but
// render them as inert labels rather than exposing navigation or local images.
const isFileUrl = (url: string) => /^file:/i.test(url.trim());
const validateLink = md.validateLink;
md.validateLink = (url) => isFileUrl(url) || validateLink(url);
md.core.ruler.push('file_references', (state) => {
  for (const block of state.tokens) {
    const fileLinks: boolean[] = [];
    for (const token of block.children ?? []) {
      if (token.type === 'link_open') {
        const href = token.attrGet('href') ?? '';
        const fileLink = isFileUrl(href);
        fileLinks.push(fileLink);
        if (fileLink) {
          // Keep the link token type so the mentions rule leaves its label alone.
          token.tag = 'span';
          token.attrs = [['title', href]];
        }
      } else if (token.type === 'link_close') {
        if (fileLinks.pop()) token.tag = 'span';
      } else if (token.type === 'image' && isFileUrl(token.attrGet('src') ?? '')) {
        token.type = 'text';
        token.tag = '';
        token.attrs = null;
        token.children = null;
      }
    }
  }
});

// Web links open out-of-process. The main process intercepts target=_blank
// (setWindowOpenHandler) and routes http(s) to the OS browser, so links never
// navigate the SPA away. rel hardens against opener access.
const defaultLinkOpen =
  md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (token?.tag === 'span') return self.renderToken(tokens, idx, options);
  if (token) {
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener noreferrer');
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

const defaultFence = md.renderer.rules.fence!;
// The wrapper holds the Markdown component's copy button outside the
// scrolling <pre>, so it stays put when long lines scroll sideways.
md.renderer.rules.fence = (tokens, index, options, env, self) =>
  `<div class="code-block">${tokens[index]?.meta?.highlightedHtml ?? defaultFence(tokens, index, options, env, self)}</div>`;

// Wrap tables in a scrolling container so wide tables scroll sideways while
// keeping normal table layout, and can break out wider than prose.
const defaultTableOpen =
  md.renderer.rules.table_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
const defaultTableClose =
  md.renderer.rules.table_close ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.table_open = (tokens, idx, options, env, self) =>
  `<div class="markdown-table">${defaultTableOpen(tokens, idx, options, env, self)}`;
md.renderer.rules.table_close = (tokens, idx, options, env, self) =>
  `${defaultTableClose(tokens, idx, options, env, self)}</div>`;

// Mark paragraphs that hold only a standalone image (or linked image) so
// conversations can break them out wider than prose without touching inline icons.
md.core.ruler.push('standalone_images', (state) => {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length - 2; i++) {
    const open = tokens[i];
    const inline = tokens[i + 1];
    const close = tokens[i + 2];
    if (open?.type !== 'paragraph_open' || inline?.type !== 'inline' || close?.type !== 'paragraph_close') continue;
    const meaningful = (inline.children ?? []).filter((token) => !(token.type === 'text' && !token.content.trim()));
    const standalone = (meaningful.length === 1 && meaningful[0]?.type === 'image')
      || (meaningful.length === 3 && meaningful[0]?.type === 'link_open' && meaningful[1]?.type === 'image' && meaningful[2]?.type === 'link_close');
    if (standalone) open.attrJoin('class', 'markdown-image');
  }
});

// Process IDs and launch tokens become empty placeholders that the Markdown
// component fills with chips. Text in links stays as it is, and code only
// when the whole span is a single mention. text_join has merged the brackets
// of a launch token back into one text token by now. While a reply streams,
// a process ID at its very end may still be gaining digits, so `holdTrailing`
// leaves it as text until the reply stops changing.
export interface MarkdownOptions { mentions?: boolean; holdTrailing?: boolean }

const isMention = (part: { processId?: string | undefined; launch?: unknown; figure?: string | undefined }) => Boolean(part.processId || part.launch || part.figure);

md.core.ruler.push('mentions', (state) => {
  const { mentions, holdTrailing } = state.env as MarkdownOptions;
  if (!mentions) return;
  const lastInline = state.tokens.filter((token) => token.type === 'inline').at(-1);
  for (const block of state.tokens) {
    if (block.type !== 'inline' || !block.children) continue;
    let linkDepth = 0;
    const last = block.children.length - 1;
    block.children = block.children.flatMap((token, index) => {
      if (token.type === 'link_open') linkDepth += 1;
      if (token.type === 'link_close') linkDepth -= 1;
      if (linkDepth || (token.type !== 'text' && token.type !== 'code_inline')) return [token];
      const parts = splitProcessMentions(token.content);
      if (!parts.some(isMention) || (token.type === 'code_inline' && parts.length > 1)) return [token];
      const held = holdTrailing && block === lastInline && index === last && token.type === 'text' ? parts.at(-1) : undefined;
      return parts.map((part) => {
        const next = new state.Token(isMention(part) && !(part === held && part.processId) ? 'mention' : 'text', '', 0);
        next.content = part.text;
        return next;
      });
    });
  }
});

md.renderer.rules.mention = (tokens, index) => `<span data-mention="${md.utils.escapeHtml(tokens[index]!.content)}"></span>`;

export function renderPlainMarkdown(source: string, options: MarkdownOptions = {}): string {
  return md.render(source, { ...options });
}

// Highlighted Markdown for recently shown messages, so a message that
// mounts again (switching conversations, virtual rows scrolling back) shows
// its colours at once instead of plain code first.
const highlightedCache = new Map<string, { html: string; bytes: number }>();
const HIGHLIGHTED_CACHE_SIZE = 200;
const HIGHLIGHTED_CACHE_BYTES = 8 * 1024 * 1024;
let highlightedCacheBytes = 0;
const cacheKey = (source: string, options: MarkdownOptions) => `${options.mentions ? 1 : 0}${options.holdTrailing ? 1 : 0}${source}`;

export function cachedMarkdown(source: string, options: MarkdownOptions = {}): string | undefined {
  const key = cacheKey(source, options);
  const entry = highlightedCache.get(key);
  if (entry === undefined) return undefined;
  highlightedCache.delete(key);
  highlightedCache.set(key, entry);
  return entry.html;
}

function rememberMarkdown(key: string, html: string): void {
  const bytes = 2 * (key.length + html.length);
  if (bytes > HIGHLIGHTED_CACHE_BYTES) return;
  const previous = highlightedCache.get(key);
  if (previous) {
    highlightedCache.delete(key);
    highlightedCacheBytes -= previous.bytes;
  }
  while (highlightedCache.size >= HIGHLIGHTED_CACHE_SIZE || highlightedCacheBytes + bytes > HIGHLIGHTED_CACHE_BYTES) {
    const oldest = highlightedCache.keys().next().value!;
    const entry = highlightedCache.get(oldest)!;
    highlightedCache.delete(oldest);
    highlightedCacheBytes -= entry.bytes;
  }
  highlightedCache.set(key, { html, bytes });
  highlightedCacheBytes += bytes;
}

const REFERENCE_LINK_DEF = /^\s{0,3}\[[^\]\n]+\]:/m;
const LIST_ITEM_START = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s/;
const BLOCKQUOTE_START = /^\s{0,3}>/;
const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;

// Splits a streaming Markdown document into completed top-level leading blocks
// and a live tail block, only at safe blank-line boundaries outside open code
// fences, lists, blockquotes, and reference-link documents. Completed blocks
// can be parsed and highlighted once and never re-parsed as new tokens stream.
export function splitStableMarkdownBlocks(source: string): { stable: string[]; tail: string } {
  if (!source || !source.includes('\n\n') && !source.includes('\r\n\r\n')) {
    return { stable: [], tail: source };
  }
  if (REFERENCE_LINK_DEF.test(source)) {
    return { stable: [], tail: source };
  }
  const lines = source.split('\n');
  const stable: string[] = [];
  let blockStart = 0;
  let fenceChar = '';
  let fenceLen = 0;
  let lastNonBlank = '';
  let inList = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const trimmed = line.trim();

    if (fenceChar) {
      const closeMatch = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
      if (closeMatch && closeMatch[1]![0] === fenceChar && closeMatch[1]!.length >= fenceLen) {
        fenceChar = '';
        fenceLen = 0;
      }
      if (trimmed) lastNonBlank = line;
      continue;
    }

    const openMatch = line.match(FENCE_OPEN);
    if (openMatch) {
      const marker = openMatch[1]!;
      // Backtick info strings cannot contain backticks per CommonMark.
      if (marker[0] !== '`' || !line.slice(line.indexOf(marker) + marker.length).includes('`')) {
        fenceChar = marker[0]!;
        fenceLen = marker.length;
        lastNonBlank = line;
        continue;
      }
    }

    if (trimmed === '') {
      // Find the next non-blank line to decide if this blank line is a safe
      // top-level block boundary.
      let nextIdx = i + 1;
      while (nextIdx < lines.length && lines[nextIdx]!.trim() === '') nextIdx++;
      if (nextIdx >= lines.length) {
        // Trailing blank lines stay attached to the tail block so nothing is
        // split until content actually follows.
        break;
      }
      const nextRaw = lines[nextIdx]!;
      const nextLine = nextRaw.endsWith('\r') ? nextRaw.slice(0, -1) : nextRaw;
      const indented = nextLine.startsWith(' ') || nextLine.startsWith('\t');
      const continuesList = inList && LIST_ITEM_START.test(nextLine);
      const continuesQuote = BLOCKQUOTE_START.test(lastNonBlank) && BLOCKQUOTE_START.test(nextLine);
      if (!indented && !continuesList && !continuesQuote && i > blockStart) {
        const chunk = lines.slice(blockStart, i).join('\n');
        if (chunk.trim()) stable.push(chunk);
        blockStart = nextIdx;
        lastNonBlank = '';
        inList = false;
        i = nextIdx - 1;
      }
      continue;
    }

    if (!inList && LIST_ITEM_START.test(line)) inList = true;
    lastNonBlank = line;
  }

  if (!stable.length) return { stable: [], tail: source };
  const tail = lines.slice(blockStart).join('\n');
  return { stable, tail };
}

export async function renderMarkdown(source: string, options: MarkdownOptions = {}, highlight?: (blocks: CodeBlock[]) => Promise<(string | null)[]>): Promise<string> {
  const env = { ...options };
  const tokens = md.parse(source, env);
  let complete = true;
  // Keep large pasted files readable without running a grammar over them.
  const fences = tokens.filter((token) => token.type === 'fence' && token.info.trim() && token.content.length <= 20_000);
  if (fences.length) {
    const runHighlight = highlight ?? (await import('./codeHighlight.js')).highlightCodeBlocks;
    const html = await runHighlight(fences.map((token) => ({
      code: token.content.replace(/\n$/, ''),
      lang: token.info.trim().split(/\s+/)[0]!.toLowerCase()
    })));
    // A highlighter that failed returns nothing; keep those blocks plain but uncached.
    complete = html.length === fences.length;
    fences.forEach((token, index) => {
      const highlightedHtml = html[index];
      if (highlightedHtml) token.meta = { highlightedHtml };
    });
  }
  const rendered = md.renderer.render(tokens, md.options, env);
  if (!complete) return rendered;
  rememberMarkdown(cacheKey(source, options), rendered);
  return rendered;
}
