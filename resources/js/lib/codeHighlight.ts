export interface CodeBlock { code: string; lang: string }

// Highlighted HTML for each block, or null to keep it as escaped plain code.
// Shiki loads only the grammars these blocks use. The build resolves `shiki` to
// ./shiki.ts, so only its languages highlight.
export async function highlightCodeBlocks(blocks: CodeBlock[]): Promise<(string | null)[]> {
  try {
    const { codeToHtml, bundledLanguages } = await import('shiki');
    return await Promise.all(blocks.map(async ({ code, lang }) => {
      if (!Object.hasOwn(bundledLanguages, lang)) return null;
      try {
        return await codeToHtml(code, {
          lang,
          theme: 'github-dark',
          transformers: [{ pre(node) { delete node.properties.style; } }]
        });
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
