import MarkdownIt from 'markdown-it';
import { splitProcessMentions } from './agentMentions';
import { highlightCodeBlocks, type CodeBlock } from './codeHighlight';

// html:false keeps raw HTML in source inert (rendered as escaped text), and
// markdown-it's default link validation rejects javascript:/data: URIs, so no
// extra sanitiser is needed for agent/user-authored bodies.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

// Force links to open out-of-process. The main process intercepts target=_blank
// (setWindowOpenHandler) and routes http(s) to the OS browser, so links never
// navigate the SPA away. rel hardens against opener access.
const defaultLinkOpen =
  md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
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
const highlightedCache = new Map<string, string>();
const HIGHLIGHTED_CACHE_SIZE = 200;
const cacheKey = (source: string, options: MarkdownOptions) => `${options.mentions ? 1 : 0}${options.holdTrailing ? 1 : 0}${source}`;

export function cachedMarkdown(source: string, options: MarkdownOptions = {}): string | undefined {
  const key = cacheKey(source, options);
  const html = highlightedCache.get(key);
  if (html === undefined) return undefined;
  highlightedCache.delete(key);
  highlightedCache.set(key, html);
  return html;
}

export async function renderMarkdown(source: string, options: MarkdownOptions = {}, highlight: (blocks: CodeBlock[]) => Promise<(string | null)[]> = highlightCodeBlocks): Promise<string> {
  const env = { ...options };
  const tokens = md.parse(source, env);
  let complete = true;
  // Keep large pasted files readable without running a grammar over them.
  const fences = tokens.filter((token) => token.type === 'fence' && token.info.trim() && token.content.length <= 20_000);
  if (fences.length) {
    const html = await highlight(fences.map((token) => ({
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
  const key = cacheKey(source, options);
  highlightedCache.delete(key);
  highlightedCache.set(key, rendered);
  if (highlightedCache.size > HIGHLIGHTED_CACHE_SIZE) highlightedCache.delete(highlightedCache.keys().next().value!);
  return rendered;
}
