export interface CodeBlock { code: string; lang: string }

// Realm-local (worker or fallback), never persisted. Keys/results retain user
// code; the byte budget estimates UTF-16 strings, not Map/engine overhead.
// The theme and transformer below are fixed; include them in the key if that changes.
const HIGHLIGHT_CACHE_ENTRIES = 64;
const HIGHLIGHT_CACHE_BYTES = 4 * 1024 * 1024;
const highlightCache = new Map<string, { html: string; bytes: number }>();
let highlightCacheBytes = 0;

function cachedBlock(key: string): string | undefined {
  const entry = highlightCache.get(key);
  if (!entry) return undefined;
  highlightCache.delete(key);
  highlightCache.set(key, entry);
  return entry.html;
}

function rememberBlock(key: string, html: string): void {
  const bytes = 2 * (key.length + html.length);
  if (bytes > HIGHLIGHT_CACHE_BYTES) return;
  const previous = highlightCache.get(key);
  if (previous) {
    highlightCache.delete(key);
    highlightCacheBytes -= previous.bytes;
  }
  while (highlightCache.size >= HIGHLIGHT_CACHE_ENTRIES || highlightCacheBytes + bytes > HIGHLIGHT_CACHE_BYTES) {
    const oldest = highlightCache.keys().next().value!;
    const entry = highlightCache.get(oldest)!;
    highlightCache.delete(oldest);
    highlightCacheBytes -= entry.bytes;
  }
  highlightCache.set(key, { html, bytes });
  highlightCacheBytes += bytes;
}

// Highlighted HTML for each block, or null to keep it as escaped plain code.
// Shiki loads only the grammars these blocks use. The build resolves `shiki` to
// ./shiki.ts, so only its languages highlight.
export async function highlightCodeBlocks(blocks: CodeBlock[]): Promise<(string | null)[]> {
  try {
    const { codeToHtml, bundledLanguages } = await import('shiki');
    return await Promise.all(blocks.map(async ({ code, lang }) => {
      if (!Object.hasOwn(bundledLanguages, lang)) return null;
      const key = JSON.stringify([lang, code]);
      const cached = cachedBlock(key);
      if (cached !== undefined) return cached;
      try {
        const html = await codeToHtml(code, {
          lang,
          theme: 'github-dark',
          transformers: [{ pre(node) { delete node.properties.style; } }]
        });
        if (typeof html === 'string') rememberBlock(key, html);
        return html;
      } catch { return null; /* Keep escaped plain code if a grammar fails to load. */ }
    }));
  } catch {
    // Markdown remains usable if the highlighter cannot load.
    return blocks.map(() => null);
  }
}

// Loads the engine, theme, and the grammars agents use most, so the first
// code block highlights without waiting for them.
export async function warmCodeHighlighter(): Promise<void> {
  try {
    const { getSingletonHighlighter } = await import('shiki');
    await getSingletonHighlighter({ themes: ['github-dark'], langs: ['typescript', 'javascript', 'json', 'shellscript'] });
  } catch { /* Highlighting loads what it needs later. */ }
}
