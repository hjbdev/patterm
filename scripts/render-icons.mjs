// Regenerate committed app icons after editing public/icon.svg.
// Requires the rsvg-convert command (librsvg); it is not needed to build the app.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const source = fs.readFileSync(new URL('../public/icon.svg', import.meta.url), 'utf8');
const output = new URL('../public/icons/', import.meta.url);
const render = (size, svg = source) => execFileSync('rsvg-convert', ['--width', String(size), '--height', String(size)], { input: svg });
for (const [name, size] of [['icon-192', 192], ['icon-512', 512], ['apple-touch-icon', 180]]) {
  fs.writeFileSync(new URL(`${name}.png`, output), render(size));
}
fs.writeFileSync(new URL('icon-maskable-512.png', output), render(512, source.replace('rx="104"', 'rx="0"')));

// Windows Vista and later support PNG images inside ICO files. Include small
// sizes as well as 256px so the shell can select the right image for each scale.
const sizes = [16, 32, 48, 64, 128, 256];
const directory = Buffer.alloc(6 + sizes.length * 16);
directory.writeUInt16LE(1, 2); // ICO, not CUR.
directory.writeUInt16LE(sizes.length, 4);
const images = sizes.map((size) => render(size));
let offset = directory.length;
images.forEach((png, index) => {
  const entry = 6 + index * 16;
  directory[entry] = directory[entry + 1] = sizes[index] % 256;
  directory.writeUInt16LE(1, entry + 4); // Planes.
  directory.writeUInt16LE(32, entry + 6); // RGBA.
  directory.writeUInt32LE(png.length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += png.length;
});
fs.writeFileSync(new URL('icon.ico', output), Buffer.concat([directory, ...images]));
