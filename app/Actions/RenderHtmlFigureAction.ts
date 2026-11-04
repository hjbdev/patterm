import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathContains } from '../Platform/PathIdentity';
import { MAX_FIGURE_VIDEO_BYTES, type FigureVideoStore } from '../Services/FigureVideoStore';
import { figureImagePaths, figureToken, figureVideoPaths, formatInputErrors, htmlRenderInput } from '../Services/HtmlFigure';
import type { TranscriptImageStore } from '../Services/TranscriptImageStore';

export interface FigureCaller {
  cwd: string | null;
  project_path: string | null;
}

export type FigureVideos = Pick<FigureVideoStore, 'fromFile'>;

// Checks an agent's page and stores the local images and videos it shows. The page
// itself stays in the harness's own transcript as the tool call's input; the
// reply carries the stored copies so the renderer never reads agent paths.
export class RenderHtmlFigureAction {
  constructor(
    private readonly images: Pick<TranscriptImageStore, 'fromFile'> | undefined,
    private readonly videos?: FigureVideos | undefined
  ) {}

  async execute(raw: unknown, caller: FigureCaller): Promise<{ ok: true; ref: string; shown: string; images?: Record<string, string>; videos?: Record<string, string> }> {
    const parsed = htmlRenderInput.safeParse(raw);
    if (!parsed.success) throw rejected(formatInputErrors(parsed.error));
    const { images, errors } = storeImages(this.images, parsed.data.html, caller);
    const stored = await storeVideos(this.videos, parsed.data.html, caller);
    errors.push(...stored.errors);
    if (errors.length) throw rejected(errors);
    // Pages appear only where the reply places this token. Agents otherwise
    // restate what they drew in prose.
    const ref = figureToken(parsed.data.id ?? `fig_${randomBytes(3).toString('hex')}`);
    return { ok: true, ref, shown: `Not shown yet. Put ${ref} on its own line in your reply where it belongs and write around it; do not describe what the page already shows.`, ...(Object.keys(images).length ? { images } : {}), ...(Object.keys(stored.videos).length ? { videos: stored.videos } : {}) };
  }
}

export function storeImages(store: Pick<TranscriptImageStore, 'fromFile'> | undefined, page: string, caller: FigureCaller): { images: Record<string, string>; errors: string[] } {
  const images: Record<string, string> = {};
  const errors: string[] = [];
  for (const requested of figureImagePaths(page)) {
    if (!store) { errors.push(`"${requested}": local images are unavailable here`); continue; }
    const file = callerFile(requested, caller);
    if (!file) { errors.push(`"${requested}" must be an existing file inside your working directory or the project`); continue; }
    const stored = store.fromFile(file);
    if (!stored) { errors.push(`"${requested}" is not a PNG, JPEG, GIF or WebP image under 10 MB`); continue; }
    images[requested] = stored.sha256;
  }
  return { images, errors };
}

export async function storeVideos(store: FigureVideos | undefined, page: string, caller: FigureCaller): Promise<{ videos: Record<string, string>; errors: string[] }> {
  const videos: Record<string, string> = {};
  const errors: string[] = [];
  // The roots are resolved once, before any video is opened.
  const roots = realRoots(caller);
  for (const requested of figureVideoPaths(page)) {
    if (!store) { errors.push(`"${requested}": local videos are unavailable here`); continue; }
    const file = callerFile(requested, caller);
    if (!file) { errors.push(`"${requested}" must be an existing file inside your working directory or the project`); continue; }
    const stored = await store.fromFile(file, (real) => roots.some((root) => pathContains(root, real)));
    if (!stored) { errors.push(`"${requested}" is not an MP4 or WebM video under ${MAX_FIGURE_VIDEO_BYTES / 1024 / 1024} MB`); continue; }
    videos[requested] = stored.sha256;
  }
  return { videos, errors };
}

function callerFile(requested: string, caller: FigureCaller): string | null {
  const roots = callerRoots(caller);
  if (!roots.length) return null;
  try {
    const real = fs.realpathSync(path.resolve(caller.cwd ?? roots[0]!, requested));
    return insideCaller(real, caller) ? real : null;
  } catch {
    return null;
  }
}

function callerRoots(caller: FigureCaller): string[] {
  return [caller.cwd, caller.project_path].filter((root): root is string => Boolean(root));
}

function realRoots(caller: FigureCaller): string[] {
  return callerRoots(caller).flatMap((root) => {
    try { return [fs.realpathSync(root)]; } catch { return []; }
  });
}

function insideCaller(real: string, caller: FigureCaller): boolean {
  return realRoots(caller).some((root) => pathContains(root, real));
}

function rejected(errors: string[]): Error {
  return new Error(`html_render: nothing was rendered. Fix these and call again:\n${errors.map((error) => `- ${error}`).join('\n')}`);
}
