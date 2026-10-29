// A bot's picture is a small square like a project logo: big enough for the
// 96 px preview on 2x screens' half size, small enough to ride along with
// every bot.
const PICTURE_SIZE = 96;

// Crops any image the browser can decode to its centre square and returns a
// WebP data URL, which keeps transparency and stays small.
export async function botPicture(source: string): Promise<string> {
  const image = new Image();
  image.decoding = 'async';
  image.src = source;
  await image.decode();
  const width = image.naturalWidth || PICTURE_SIZE;
  const height = image.naturalHeight || PICTURE_SIZE;
  const side = Math.min(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = PICTURE_SIZE;
  canvas.height = PICTURE_SIZE;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not draw the picture');
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, (width - side) / 2, (height - side) / 2, side, side, 0, 0, PICTURE_SIZE, PICTURE_SIZE);
  return canvas.toDataURL('image/webp', 0.9);
}
