// The user's typefaces as data URLs for agent pages. Each face is its own
// chunk, loaded the first time a page needs it.

import { figureFontsFor, figureFontStyle } from '../../../app/Services/HtmlFigure';
import type { FontSettings } from '../../../app/Services/FontFamilies';

const FACES = import.meta.glob<string>(['../assets/fonts/*/*-latin-{4,5,6,7}00-normal.woff2', '../assets/fonts/*/*-latin-ext-{4,5,6,7}00-normal.woff2'], { query: '?inline', import: 'default' });
const PREFIX = '../assets/fonts/';
const loaded = new Map<string, Promise<string | null>>();

function face(file: string): Promise<string | null> {
  let url = loaded.get(file);
  if (!url) {
    const load = FACES[`${PREFIX}${file}`];
    url = load ? load().catch(() => null) : Promise.resolve(null);
    loaded.set(file, url);
  }
  return url;
}

export async function figureFontStyleFor(settings: FontSettings): Promise<string> {
  const urls = new Map<string, string>();
  await Promise.all(figureFontsFor(settings).files.map(async (file) => {
    const url = await face(file);
    if (url) urls.set(file, url);
  }));
  return figureFontStyle(settings, (file) => urls.get(file) ?? null);
}
