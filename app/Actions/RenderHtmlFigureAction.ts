import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathContains } from '../Platform/PathIdentity';
import { figureImagePaths, figureToken, formatInputErrors, htmlRenderInput } from '../Services/HtmlFigure';
import type { TranscriptImageStore } from '../Services/TranscriptImageStore';

export interface FigureCaller {
  cwd: string | null;
  project_path: string | null;
}

// Checks an agent's page and stores the local images it shows. The page
// itself stays in the harness's own transcript as the tool call's input; the
// reply carries the stored copies so the renderer never reads agent paths.
export class RenderHtmlFigureAction {
  constructor(private readonly images: Pick<TranscriptImageStore, 'fromFile'> | undefined) {}

  execute(raw: unknown, caller: FigureCaller): { ok: true; ref: string; shown: string; images?: Record<string, string> } {
    const parsed = htmlRenderInput.safeParse(raw);
    if (!parsed.success) throw rejected(formatInputErrors(parsed.error));
    const { images, errors } = storeImages(this.images, parsed.data.html, caller);
    if (errors.length) throw rejected(errors);
    // Pages appear only where the reply places this token. Agents otherwise
    // restate what they drew in prose.
    const ref = figureToken(parsed.data.id ?? `fig_${randomBytes(3).toString('hex')}`);
    return { ok: true, ref, shown: `Not shown yet. Put ${ref} on its own line in your reply where it belongs and write around it; do not describe what the page already shows.`, ...(Object.keys(images).length ? { images } : {}) };
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

function callerFile(requested: string, caller: FigureCaller): string | null {
  const roots = [caller.cwd, caller.project_path].filter((root): root is string => Boolean(root));
  if (!roots.length) return null;
  const file = path.resolve(caller.cwd ?? roots[0]!, requested);
  try {
    const real = fs.realpathSync(file);
    return roots.some((root) => pathContains(fs.realpathSync(root), real)) ? real : null;
  } catch {
    return null;
  }
}

function rejected(errors: string[]): Error {
  return new Error(`html_render: nothing was rendered. Fix these and call again:\n${errors.map((error) => `- ${error}`).join('\n')}`);
}
