import { watch } from 'vue';
import { faceMarkup } from './faces';
import { readBots, type Bot } from './bots';
import { topicGeneration } from './serverQuery';

// Push notifications from a bot show its avatar, like a contact's photo in a
// text. The service worker (public/sw.js) can't draw faces, so the app draws
// each bot's avatar into a cache on this device and the worker reads it from
// there. Bots with Patterm's mark keep the app icon.
const CACHE = 'patterm-push-avatars';
const SIZE = 192;
// Kept on each entry so an unchanged avatar isn't drawn again.
const LOOK_HEADER = 'x-patterm-avatar';

export function startPushAvatars(): void {
  if (window.patterm.runtime !== 'browser' || !('caches' in window) || !('serviceWorker' in navigator)) return;
  let running = Promise.resolve();
  const sync = () => {
    running = running.then(async () => syncPushAvatars((await readBots()).bots)).catch((error: unknown) => {
      console.warn('Bot notification pictures were not updated', error);
    });
  };
  watch(() => topicGeneration('settings'), sync, { immediate: true });
}

export function pushAvatarPath(botId: string): string {
  return `/push-avatars/${encodeURIComponent(botId)}.png`;
}

// One bot's unreadable picture leaves that bot on the app icon; the others
// still get theirs, and removed bots are still dropped.
export async function syncPushAvatars(bots: Bot[], draw: (bot: Bot) => Promise<Blob | null> = drawAvatar): Promise<void> {
  const cache = await caches.open(CACHE);
  const wanted = new Set<string>();
  for (const bot of bots) {
    if (bot.avatar.kind === 'mark') continue;
    const path = pushAvatarPath(bot.id);
    wanted.add(new URL(path, location.origin).href);
    const look = lookKey(JSON.stringify(bot.avatar));
    try {
      if ((await cache.match(path))?.headers.get(LOOK_HEADER) === look) continue;
      const png = await draw(bot);
      if (png) await cache.put(path, new Response(png, { headers: { 'content-type': 'image/png', [LOOK_HEADER]: look } }));
      else await cache.delete(path);
    } catch (error) {
      await cache.delete(path).catch(() => false);
      console.warn(`The notification picture for ${bot.name} was not drawn`, error);
    }
  }
  for (const request of await cache.keys()) if (!wanted.has(request.url)) await cache.delete(request);
}

// Headers carry only ASCII; pictures and emoji aren't.
function lookKey(look: string): string {
  let value = 2166136261;
  for (let index = 0; index < look.length; index++) value = Math.imul(value ^ look.charCodeAt(index), 16777619);
  return `${(value >>> 0).toString(36)}-${look.length}`;
}

async function drawAvatar(bot: Bot): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const context = canvas.getContext('2d');
  if (!context) return null;
  // Android crops large icons to a circle; a dark disc keeps faces and emoji
  // readable on a light or dark shade.
  context.fillStyle = '#27272a';
  context.beginPath();
  context.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2);
  context.fill();
  const { avatar } = bot;
  if (avatar.kind === 'picture' && avatar.picture) {
    const image = await loadImage(avatar.picture);
    const scale = Math.max(SIZE / image.naturalWidth, SIZE / image.naturalHeight);
    const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
    context.drawImage(image, (SIZE - width) / 2, (SIZE - height) / 2, width, height);
  } else if (avatar.kind === 'emoji' && avatar.emoji) {
    context.font = `${Math.round(SIZE * 0.6)}px 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(avatar.emoji, SIZE / 2, SIZE * 0.54);
  } else {
    // A padded view box leaves room for hats that rise above the face.
    const { body } = faceMarkup(avatar.look, SIZE, 'push-face');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-3 -3 30 30" width="${SIZE}" height="${SIZE}">${body}</svg>`;
    context.drawImage(await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`), 0, 0, SIZE, SIZE);
  }
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = src;
  await image.decode();
  return image;
}
