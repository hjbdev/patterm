// Stored logos are small squares so they can ride along with every project
// summary. 64 px stays sharp at the 32 px the largest tile draws on 2x screens.
const LOGO_SIZE = 64;

// Draws any image the browser can decode (SVG, ICO, PNG, JPEG, WebP, GIF)
// centred into a transparent square and returns it as a PNG data URL.
export async function rasterizeLogo(source: string): Promise<string> {
  const image = new Image();
  image.decoding = 'async';
  image.src = darkSvg(source);
  await image.decode();
  const width = image.naturalWidth || LOGO_SIZE;
  const height = image.naturalHeight || LOGO_SIZE;
  const scale = LOGO_SIZE / Math.max(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = LOGO_SIZE;
  canvas.height = LOGO_SIZE;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not draw the logo');
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, (LOGO_SIZE - width * scale) / 2, (LOGO_SIZE - height * scale) / 2, width * scale, height * scale);
  return canvas.toDataURL('image/png');
}

// Patterm is always dark, but an <img> follows the OS colour scheme. Favicons
// that adapt to it are drawn in their dark variant, which suits Patterm.
export function darkSvg(source: string): string {
  const match = /^data:image\/svg\+xml(?:;charset=[\w-]+)?;base64,(.*)$/.exec(source);
  if (!match) return source;
  const text = new TextDecoder().decode(Uint8Array.from(atob(match[1]!), (char) => char.charCodeAt(0)));
  if (!text.includes('prefers-color-scheme')) return source;
  // Swap in features that are always true or always false, so compound
  // queries such as `screen and (prefers-color-scheme: dark)` stay valid.
  const dark = text
    .replace(/\(\s*prefers-color-scheme\s*:\s*dark\s*\)/g, '(min-width: 0px)')
    .replace(/\(\s*prefers-color-scheme\s*:\s*light\s*\)/g, '(max-width: 0px)');
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(dark)}`;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}

// A muted, stable tint per project for its monogram tile.
export function monogramHue(seed: string): number {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return hash % 360;
}

export function monogram(name: string): string {
  return ([...name.trim()].find((char) => /[\p{L}\p{N}]/u.test(char)) ?? '?').toUpperCase();
}
