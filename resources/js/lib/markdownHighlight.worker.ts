import { highlightCodeBlocks, warmCodeHighlighter, type CodeBlock } from './codeHighlight';

self.addEventListener('message', async ({ data }: MessageEvent<{ id: number; blocks: CodeBlock[] } | { warm: true }>) => {
  if ('warm' in data) return void warmCodeHighlighter();
  self.postMessage({ id: data.id, html: await highlightCodeBlocks(data.blocks) });
});
