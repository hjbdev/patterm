import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { sniffMime } from '../Http/UploadService';
import type { DatabaseService } from '../Services/DatabaseService';
import type { TimelineService } from '../Services/TimelineService';

// The renderer scales logos down to a small raster before saving, so stored
// logos stay small enough to ride along with every project summary.
export const MAX_PROJECT_LOGO_BYTES = 64 * 1024;
const MAX_CANDIDATE_BYTES = 512 * 1024;
const MAX_CANDIDATES = 8;
const MAX_SCAN_DEPTH = 4;
const MAX_SCAN_DIRECTORIES = 400;

const LOGO_DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
// Favicons, app icons, and logos, with optional size suffixes like `-192` or
// `-32x32`. Plain `icon_*.svg` UI glyphs are not logos.
const CANDIDATE_NAME = /^(logo|logomark|logo-mark|app-icon|icon|favicon|apple-touch-icon)(?:[-_@.]?(?:\d+(?:x\d+)?|\dx|maskable-\d+))?\.(svg|png|ico|webp)$/i;
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'vendor', 'dist', 'target', 'coverage', 'storage', 'out', 'tmp']);
const NAME_RANK = ['logo', 'logomark', 'logo-mark', 'app-icon', 'icon', 'favicon', 'apple-touch-icon'];
const EXTENSION_RANK = ['svg', 'png', 'webp', 'ico'];
const EXTENSION_MIME: Record<string, string> = { svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp', ico: 'image/x-icon' };

export const projectLogoCandidatesInput = z.object({ project_id: z.string().min(1) });

export const setProjectLogoInput = z.object({
  project_id: z.string().min(1),
  logo: z.string().max(Math.ceil(MAX_PROJECT_LOGO_BYTES * 4 / 3) + 64).nullable(),
  actor_type: z.enum(['user', 'agent', 'system']).default('user'),
  actor_id: z.string().nullable().default(null)
});

export type SetProjectLogoInput = z.infer<typeof setProjectLogoInput>;

export interface ProjectLogoCandidate {
  path: string;
  data_url: string;
}

// Finds image files in a project that look like its logo, and stores the one
// the user picks (or uploads) on the project.
export class ProjectLogoAction {
  constructor(
    private readonly database: DatabaseService,
    private readonly timeline: TimelineService
  ) {}

  candidates(projectId: string): { candidates: ProjectLogoCandidate[] } {
    const root = this.projectPath(projectId);
    const found: string[] = [];
    const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
    let visited = 0;
    while (queue.length && visited < MAX_SCAN_DIRECTORIES) {
      const { directory, depth } = queue.shift()!;
      visited += 1;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          const hidden = entry.name.startsWith('.') && entry.name !== '.github';
          if (depth < MAX_SCAN_DEPTH && !hidden && !SKIPPED_DIRECTORIES.has(entry.name)) queue.push({ directory: full, depth: depth + 1 });
        } else if (entry.isFile() && CANDIDATE_NAME.test(entry.name)) {
          found.push(full);
        }
      }
    }

    // Sizes of one icon look alike, so each directory offers its best file of each kind.
    const candidates: ProjectLogoCandidate[] = [];
    const offered = new Set<string>();
    for (const file of found.sort(compareCandidates)) {
      if (candidates.length >= MAX_CANDIDATES) break;
      const kind = `${path.dirname(file)}\0${CANDIDATE_NAME.exec(path.basename(file))![1]!.toLowerCase()}`;
      if (offered.has(kind)) continue;
      const dataUrl = candidateDataUrl(file);
      if (!dataUrl) continue;
      offered.add(kind);
      candidates.push({ path: path.relative(root, file), data_url: dataUrl });
    }
    return { candidates };
  }

  set(input: SetProjectLogoInput): { project_id: string; logo: string | null } {
    this.projectPath(input.project_id);
    const logo = input.logo === null ? null : validLogo(input.logo);
    this.database.connection
      .prepare(`update projects set logo = ?, updated_at = ? where id = ?`)
      .run(logo, new Date().toISOString(), input.project_id);
    this.timeline.append({
      event_type: logo ? 'project.logo_set' : 'project.logo_removed',
      project_id: input.project_id,
      actor_type: input.actor_type,
      actor_id: input.actor_id,
      metadata: {}
    });
    return { project_id: input.project_id, logo };
  }

  private projectPath(projectId: string): string {
    const row = this.database.connection
      .prepare(`select path from projects where id = ? and kind = 'workspace'`)
      .get(projectId) as { path: string } | undefined;
    if (!row) throw new Error(`unknown project ${projectId}`);
    return row.path;
  }
}

function validLogo(value: string): string {
  const match = LOGO_DATA_URL.exec(value);
  if (!match) throw new Error('Logo must be a PNG, JPEG, or WebP data URL');
  const bytes = Buffer.from(match[2]!, 'base64');
  if (bytes.length > MAX_PROJECT_LOGO_BYTES) throw new Error('Logo must be at most 64 KiB');
  if (sniffMime(bytes) !== match[1]) throw new Error('Logo content does not match its type');
  return value;
}

function candidateDataUrl(file: string): string | null {
  let bytes: Buffer;
  try {
    const stat = fs.statSync(file);
    if (stat.size === 0 || stat.size > MAX_CANDIDATE_BYTES) return null;
    bytes = fs.readFileSync(file);
  } catch {
    return null;
  }
  const extension = path.extname(file).slice(1).toLowerCase();
  const mime = EXTENSION_MIME[extension];
  if (!mime) return null;
  // Content must match the extension, so an empty or mislabelled file is not offered.
  if (extension === 'svg' && !/<svg[\s>]/i.test(bytes.toString('utf8'))) return null;
  if (extension === 'ico' && !(bytes.length >= 4 && bytes.readUInt32BE(0) === 0x00000100)) return null;
  if ((extension === 'png' || extension === 'webp') && sniffMime(bytes) !== mime) return null;
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

// Logos before icons before favicons, vector before raster, larger rasters
// first, and shallower paths before deeper ones.
function compareCandidates(a: string, b: string): number {
  return rank(a) - rank(b) || a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b);
}

function rank(file: string): number {
  const match = CANDIDATE_NAME.exec(path.basename(file))!;
  const size = Number(/(\d+)(?:x\d+)?\.\w+$/.exec(path.basename(file))?.[1] ?? 0);
  return NAME_RANK.indexOf(match[1]!.toLowerCase()) * 100 + EXTENSION_RANK.indexOf(match[2]!.toLowerCase()) * 10 - Math.min(size, 1024) / 1024;
}
