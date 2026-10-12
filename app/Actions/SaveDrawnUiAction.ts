import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathContains } from '../Platform/PathIdentity';
import { figureToken, parseDrawnUi } from '../Services/DrawnUi';
import type { TranscriptImageStore } from '../Services/TranscriptImageStore';

export interface DrawnUiCaller {
  cwd: string | null;
  project_path: string | null;
}

// Checks an agent's figure and stores the screenshots it names. The figure
// itself stays in the harness's own transcript as the tool call's input; the
// reply carries the stored copies so the renderer never reads agent paths.
export class SaveDrawnUiAction {
  constructor(private readonly images: Pick<TranscriptImageStore, 'fromFile'> | undefined) {}

  execute(raw: unknown, caller: DrawnUiCaller): { ok: true; ref: string; shown: string; images?: Record<string, string> } {
    const parsed = parseDrawnUi(raw);
    if (!parsed.ok) throw rejected(parsed.errors);
    const images: Record<string, string> = {};
    const errors: string[] = [];
    parsed.value.sections.forEach((section, index) => {
      if (section.figure.type !== 'image') return;
      const where = `sections[${index}].figure.path`;
      if (!this.images) { errors.push(`${where}: screenshots are unavailable here`); return; }
      const file = this.allowedFile(section.figure.path, caller);
      if (!file) { errors.push(`${where}: "${section.figure.path}" must be an existing file inside your working directory or the project`); return; }
      const stored = this.images.fromFile(file);
      if (!stored) { errors.push(`${where}: "${section.figure.path}" is not a PNG, JPEG, GIF or WebP image under 10 MB`); return; }
      images[section.figure.path] = stored.sha256;
    });
    if (errors.length) throw rejected(errors);
    // Figures appear only where the reply places this token. Agents otherwise
    // restate what they drew in prose.
    const ref = figureToken(parsed.value.id ?? `fig_${randomBytes(3).toString('hex')}`);
    return { ok: true, ref, shown: `Not shown yet. Put ${ref} on its own line in your reply where it belongs and write around it; do not describe what it already shows.`, ...(Object.keys(images).length ? { images } : {}) };
  }

  private allowedFile(requested: string, caller: DrawnUiCaller): string | null {
    const roots = [caller.cwd, caller.project_path].filter((root): root is string => Boolean(root));
    if (!roots.length) return null;
    const file = path.resolve(caller.cwd ?? roots[0]!, requested);
    try {
      const real = fs.realpathSync(file);
      return roots.some((root) => {
        const base = fs.realpathSync(root);
        return pathContains(base, real);
      }) ? real : null;
    } catch {
      return null;
    }
  }
}

function rejected(errors: string[]): Error {
  return new Error(`ui_save: nothing was saved. Fix these and call again:\n${errors.map((error) => `- ${error}`).join('\n')}`);
}
