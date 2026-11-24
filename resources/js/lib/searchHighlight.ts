// Marks search terms in visible text with the CSS Custom Highlight API, without
// changing the DOM, so components keep their own markup and listeners.
// Browsers without the API show results unmarked.
export function highlightTerms(root: HTMLElement | null, terms: string[], name: string): void {
  const highlights = (globalThis.CSS as { highlights?: Map<string, unknown> } | undefined)?.highlights;
  const HighlightType = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!highlights || !HighlightType) return;
  highlights.delete(name);
  if (!root || !terms.length) return;
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.toLocaleLowerCase() ?? '';
    if (!text.trim() || node.parentElement?.closest('[hidden], [style*="display: none"]')) continue;
    for (const term of terms) {
      for (let at = text.indexOf(term); at !== -1; at = text.indexOf(term, at + term.length)) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + term.length);
        ranges.push(range);
      }
    }
  }
  highlights.set(name, new HighlightType(...ranges));
}

export function clearHighlight(name: string): void {
  (globalThis.CSS as { highlights?: Map<string, unknown> } | undefined)?.highlights?.delete(name);
}
