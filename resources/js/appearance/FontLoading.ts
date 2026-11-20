type FontStylesheetLoader = (familyName: string) => Promise<unknown> | null;

let stylesheetLoader: FontStylesheetLoader | null = null;
const loadedStylesheets = new Map<string, Promise<unknown>>();
const resolvedStylesheets = new Set<string>();

// Registered once by the renderer entry point (BundledFontStyles.ts) so only
// the active UI and terminal families inject their @font-face CSS on demand.
export function registerBundledFontLoader(loader: FontStylesheetLoader): void {
  stylesheetLoader = loader;
}

// Loads @font-face stylesheets for any bundled families referenced in `family`.
// Returns null synchronously when nothing needs to be fetched (or in non-DOM
// test environments).
export function ensureBundledFontStyles(family: string): Promise<void> | null {
  if (!stylesheetLoader || typeof document === 'undefined' || !document.head) return null;
  const pending: Promise<unknown>[] = [];
  for (const name of family.split(',').map(unquote)) {
    if (resolvedStylesheets.has(name)) continue;
    let load = loadedStylesheets.get(name);
    if (!load) {
      const started = stylesheetLoader(name);
      if (!started) continue;
      load = started.then(
        () => { resolvedStylesheets.add(name); },
        () => { loadedStylesheets.delete(name); }
      );
      loadedStylesheets.set(name, load);
    }
    pending.push(load);
  }
  return pending.length ? Promise.allSettled(pending).then(() => undefined) : null;
}

// Prefer Latin (and box-drawing) subsets before terminal mount so we do not
// eagerly fetch cyrillic, greek, or vietnamese woff2 files before first paint.
// Faces without a unicodeRange (full fonts or test mocks) always load.
function isEssentialSubset(face: FontFace): boolean {
  const range = (face as { unicodeRange?: string }).unicodeRange;
  if (!range) return true;
  return /\bU\+0*(?:0|20)(?:-[0-9A-Fa-f]+)?\b|\bU\+2500\b/i.test(range);
}

// Load essential subsets and styles of the selected bundled families before
// canvas measurement or rasterisation. CSS text loads subsets on demand; a
// glyph atlas would otherwise keep the fallback glyph it drew while loading.
export async function loadFontFamily(family: string): Promise<void> {
  const stylesheetLoad = ensureBundledFontStyles(family);
  if (stylesheetLoad) await stylesheetLoad;
  if (!document.fonts) return;
  const names = new Set(family.split(',').map(unquote));
  const pending: Promise<FontFace>[] = [];
  document.fonts.forEach((face) => {
    if (names.has(unquote(face.family)) && isEssentialSubset(face)) pending.push(face.load());
  });
  // A missing asset must still allow the terminal to use its fallback font.
  await Promise.allSettled(pending);
}

function unquote(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
}
