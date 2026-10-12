// Load every subset and style of the selected bundled families before canvas
// measurement or rasterisation. CSS text loads subsets on demand; a glyph atlas
// would otherwise keep the fallback glyph it drew while a subset was loading.
export async function loadFontFamily(family: string): Promise<void> {
  if (!document.fonts) return;
  const names = new Set(family.split(',').map(unquote));
  const pending: Promise<FontFace>[] = [];
  document.fonts.forEach((face) => {
    if (names.has(unquote(face.family))) pending.push(face.load());
  });
  // A missing asset must still allow the terminal to use its fallback font.
  await Promise.allSettled(pending);
}

function unquote(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
}
