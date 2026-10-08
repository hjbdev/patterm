import HighlightWorker from './markdownHighlight.worker.ts?worker';
import { highlightCodeBlocks, type CodeBlock } from './codeHighlight';

// Tokenising the first code block loads Shiki's grammars and WASM engine,
// which held the main thread for about 60 ms when a conversation opened. The
// worker does it instead. Without workers, highlighting runs here as before.
let worker: Worker | null | undefined;
let nextId = 0;
const waiting = new Map<number, (html: (string | null)[]) => void>();

function highlightWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = typeof Worker === 'undefined' ? null : new HighlightWorker();
  } catch {
    worker = null;
  }
  worker?.addEventListener('message', ({ data }: MessageEvent<{ id: number; html: (string | null)[] }>) => {
    waiting.get(data.id)?.(data.html);
    waiting.delete(data.id);
  });
  // A worker that fails to start leaves its blocks plain, and later ones
  // highlight here.
  worker?.addEventListener('error', () => {
    worker?.terminate();
    worker = null;
    for (const resolve of waiting.values()) resolve([]);
    waiting.clear();
  });
  return worker;
}

export function highlightInWorker(blocks: CodeBlock[]): Promise<(string | null)[]> {
  const target = highlightWorker();
  if (!target) return highlightCodeBlocks(blocks);
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    target.postMessage({ id, blocks });
  });
}

// Starts the worker and its highlighter ahead of the first code block. Only a
// worker warms up; without one, nothing loads on the main thread early.
export function warmHighlightWorker(): void {
  highlightWorker()?.postMessage({ warm: true });
}
