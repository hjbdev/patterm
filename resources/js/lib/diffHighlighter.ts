import { parseDiffFromFile, type FileContents } from '@pierre/diffs';
import { getOrCreateWorkerPoolSingleton, type WorkerPoolManager } from '@pierre/diffs/worker';
import PierreWorker from '@pierre/diffs/worker/worker.js?worker';
import type { WorktreeDiffFile, WorktreeDiffFileContents } from './worktreeDiff';

// Shiki tokenises whole files, which takes the main thread hundreds of
// milliseconds for a large one. Pierre's workers do it instead: the diff draws
// as plain text at once and the colours follow. Without workers, Pierre
// highlights on the main thread as before.
export const DIFF_THEME = 'pierre-dark';
export const DIFF_LINE_DIFF_TYPE = 'word-alt';

let pool: WorkerPoolManager | null | undefined;

export function diffHighlighterPool(): WorkerPoolManager | undefined {
  if (pool === undefined) {
    try {
      pool = typeof Worker === 'undefined' ? null : getOrCreateWorkerPoolSingleton({
        poolOptions: { workerFactory: () => new PierreWorker(), poolSize: 2 },
        // The WASM engine tokenises about a third faster than Shiki's JavaScript one.
        highlighterOptions: { theme: DIFF_THEME, lineDiffType: DIFF_LINE_DIFF_TYPE, preferredHighlighter: 'shiki-wasm' }
      });
    } catch {
      pool = null;
    }
  }
  return pool ?? undefined;
}

// Cache keys tie Pierre's highlight cache to file versions, so a file primed
// before it opens renders with its colours straight away.
export function diffFileContents(worktreeId: string, baseCommit: string, file: WorktreeDiffFile, contents: WorktreeDiffFileContents): { oldFile: FileContents; newFile: FileContents } {
  const oldName = contents.previousPath ?? contents.path;
  return {
    oldFile: { name: oldName, contents: contents.oldContents ?? '', cacheKey: `${worktreeId}:${baseCommit}:${oldName}` },
    newFile: { name: contents.path, contents: contents.newContents ?? '', cacheKey: `${worktreeId}:${contents.path}:${file.version}` }
  };
}

export function primeDiffHighlight(files: { oldFile: FileContents; newFile: FileContents }): void {
  const workers = diffHighlighterPool();
  if (!workers?.isWorkingPool()) return;
  try {
    workers.primeDiffHighlightCache(parseDiffFromFile(files.oldFile, files.newFile));
  } catch { /* The file reports its own error when it opens. */ }
}
