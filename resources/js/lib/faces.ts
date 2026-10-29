import {
  FACE_COLORS,
  FACE_EYES,
  FACE_FINISHES,
  FACE_HATS,
  FACE_HUES,
  FACE_IDLES,
  FACE_MARKINGS,
  FACE_MOUTHS,
  FACE_SHAPES,
  type FaceColor,
  type FaceHat,
  type FaceShape,
  type ProfileLook
} from '../../../app/Harness/ProfileLook';

export { FACE_COLORS, FACE_EYES, FACE_FINISHES, FACE_HATS, FACE_IDLES, FACE_MARKINGS, FACE_MOUTHS, FACE_SHAPES, type FaceColor, type ProfileLook };

// Faces are drawn in a 24-unit box as SVG markup built from enum parts only,
// so the markup never carries user text.

interface Palette { top: string; bot: string; flat: string; dark: string; eye: string; acc: string; acc2: string; glow: string; halo: string }

// One lightness and chroma recipe across hues, so no colour shouts louder
// than another; white and graphite are the neutrals.
const HUE_ANGLES: Record<(typeof FACE_HUES)[number], number> = { red: 25, orange: 50, amber: 78, yellow: 102, lime: 128, green: 150, teal: 180, cyan: 205, sky: 232, blue: 258, indigo: 280, violet: 300, purple: 318, pink: 345 };

export function facePalette(color: FaceColor): Palette {
  if (color === 'white') return { top: 'oklch(.98 0 0)', bot: 'oklch(.76 0 0)', flat: 'oklch(.9 0 0)', dark: 'oklch(.62 0 0)', eye: 'oklch(.2 0 0)', acc: 'oklch(.95 0 0)', acc2: 'oklch(.72 0 0)', glow: 'oklch(.95 0 0 / .45)', halo: 'oklch(.8 0 0 / .14)' };
  if (color === 'graphite') return { top: 'oklch(.6 0 0)', bot: 'oklch(.37 0 0)', flat: 'oklch(.48 0 0)', dark: 'oklch(.3 0 0)', eye: 'oklch(.97 0 0)', acc: 'oklch(.42 0 0)', acc2: 'oklch(.68 0 0)', glow: 'oklch(.6 0 0 / .5)', halo: 'oklch(.5 0 0 / .16)' };
  const h = HUE_ANGLES[color];
  return { top: `oklch(.91 .1 ${h})`, bot: `oklch(.7 .17 ${h})`, flat: `oklch(.8 .15 ${h})`, dark: `oklch(.6 .17 ${h})`, eye: `oklch(.24 .05 ${h})`, acc: `oklch(.76 .17 ${h})`, acc2: `oklch(.93 .07 ${h})`, glow: `oklch(.75 .18 ${h} / .6)`, halo: `oklch(.6 .16 ${h} / .2)` };
}

interface Shape { top: number; eye: number; dx: number; mouth?: number; d: (fill: string) => string }

const SHAPES: Record<FaceShape, Shape> = {
  circle: { top: 2, eye: 11.5, dx: 3.6, d: (f) => `<circle cx="12" cy="12" r="10" fill="${f}"/>` },
  squircle: { top: 2.5, eye: 11.6, dx: 3.6, d: (f) => `<rect x="2.5" y="2.5" width="19" height="19" rx="6.5" fill="${f}"/>` },
  egg: { top: 2.2, eye: 12.3, dx: 3.5, d: (f) => `<path d="M12 2.2c5 0 9 4.6 9 10.3 0 5.1-4 9.3-9 9.3s-9-4.2-9-9.3C3 6.8 7 2.2 12 2.2z" fill="${f}"/>` },
  pill: { top: 5, eye: 11.4, dx: 4.4, mouth: 3.6, d: (f) => `<rect x="1.5" y="5" width="21" height="14" rx="7" fill="${f}"/>` },
  tall: { top: 2, eye: 10.4, dx: 3.3, d: (f) => `<rect x="4.5" y="2" width="15" height="20" rx="7.5" fill="${f}"/>` },
  ghost: { top: 3, eye: 10.8, dx: 3.4, d: (f) => `<path d="M4 11a8 8 0 0 1 16 0v10l-2.67-2-2.67 2L12 19l-2.67 2-2.66-2L4 21z" fill="${f}" stroke="${f}" stroke-width="1.2" stroke-linejoin="round"/>` },
  blob: { top: 2.5, eye: 11.6, dx: 3.6, d: (f) => `<path d="M12 2.5c4.2 0 6.4 2.2 7.6 4.6 1.3 2.6 2.2 5.6.9 8.6-1.4 3.3-4.6 5.8-8.6 5.8s-7.6-1.8-9-4.9c-1.3-2.9-.8-6.4 1-9 1.8-2.7 4.3-5.1 8.1-5.1z" fill="${f}"/>` },
  hex: { top: 2, eye: 11.6, dx: 3.5, d: (f) => `<path d="M12 3.2 19.8 7.6v8.8L12 20.8 4.2 16.4V7.6z" fill="${f}" stroke="${f}" stroke-width="2.6" stroke-linejoin="round"/>` },
  drop: { top: 2.5, eye: 13.8, dx: 3.2, mouth: 3.5, d: (f) => `<path d="M12 2.5c3 3.6 8 8.2 8 12.2a8 8 0 0 1-16 0c0-4 5-8.6 8-12.2z" fill="${f}"/>` }
};

// Where hats sit on each shape, measured once from the shapes' outlines
// (isPointInFill in a browser) so faces render without the DOM:
// - brim: the head's edges 4.6 units above the eyes, for caps and beanies.
// - seatCrown, seatParty: the first height where the head is wide enough to
//   hold a crown or a party hat.
// - ears, bunny: shoulder points, with the outline's outward tilt in degrees.
// - eyeLeft, eyeRight: the head's edges at eye height, for headphones.
// - fit: for a hat that pokes outside the box, [scale, seat, baseline] that
//   shrink the face while keeping its body on the same baseline.
interface Pair { y: number; left: number; right: number; tiltLeft: number; tiltRight: number }
interface Anchors {
  top: number; brim: number; brimLeft: number; brimRight: number; brimHalf: number; seatCrown: number; seatParty: number; eyeLeft: number; eyeRight: number;
  ears: Pair; bunny: Pair; fit: Partial<Record<FaceHat, [number, number, number]>>;
}

const ANCHORS: Record<FaceShape, Anchors> = {
  circle: { top: 2, brim: 6.9, brimLeft: 3.399, brimRight: 20.601, brimHalf: 8.601, seatCrown: 3.1, seatParty: 2.55, eyeLeft: 2.012, eyeRight: 21.988,
    ears: { y: 4, left: 6, right: 18, tiltLeft: -36.6, tiltRight: 36.6 },
    bunny: { y: 3.35, left: 6.988, right: 17.012, tiltLeft: -29.501, tiltRight: 29.501 },
    fit: { antenna:[0.936,23.6,22.8],ears:[1,23.249,22.8],bunny:[0.827,23.6,22.8],horns:[0.989,23.6,22.8],sprout:[0.94,23.6,22.8],tuft:[1,23.4,22.8],beanie:[0.965,23.6,22.8],crown:[1,23.2,22.8],halo:[0.982,23.6,22.8],party:[0.888,23.6,22.8] } },
  squircle: { top: 2.5, brim: 7, brimLeft: 2.815, brimRight: 21.185, brimHalf: 9.185, seatCrown: 2.75, seatParty: 2.55, eyeLeft: 2.5, eyeRight: 21.5,
    ears: { y: 3.1, left: 6.287, right: 17.713, tiltLeft: -19.048, tiltRight: 19.048 },
    bunny: { y: 2.75, left: 7.214, right: 16.786, tiltLeft: -18.257, tiltRight: 18.257 },
    fit: { antenna:[0.973,23.6,22.3],ears:[1,23.291,22.3],bunny:[0.825,23.6,22.3],horns:[0.976,23.6,22.3],sprout:[0.977,23.6,22.3],tuft:[1,22.4,22.3],beanie:[1,23.5,22.3],crown:[1,23.05,22.3],halo:[1,23.05,22.3],party:[0.904,23.6,22.3] } },
  egg: { top: 2.2, brim: 7.7, brimLeft: 4.027, brimRight: 19.973, brimHalf: 7.973, seatCrown: 3.6, seatParty: 2.9, eyeLeft: 3.002, eyeRight: 20.998,
    ears: { y: 4.25, left: 6.594, right: 17.406, tiltLeft: -40.356, tiltRight: 40.356 },
    bunny: { y: 3.6, left: 7.455, right: 16.545, tiltLeft: -33.142, tiltRight: 33.142 },
    fit: { antenna:[0.951,23.6,22.6],ears:[1,22.864,22.6],bunny:[0.839,23.6,22.6],horns:[1,23.442,22.6],sprout:[0.954,23.6,22.6],tuft:[1,23,22.6],beanie:[0.98,23.6,22.6],halo:[0.998,23.6,22.6],party:[0.906,23.6,22.6] } },
  pill: { top: 5, brim: 6.8, brimLeft: 3.816, brimRight: 20.184, brimHalf: 8.184, seatCrown: 5.15, seatParty: 5, eyeLeft: 1.527, eyeRight: 22.473,
    ears: { y: 5.6, left: 5.68, right: 18.32, tiltLeft: -18.33, tiltRight: 18.33 },
    bunny: { y: 5.25, left: 6.646, right: 17.354, tiltLeft: -17.6, tiltRight: 17.6 },
    fit: { bunny:[0.988,23.6,19.8],party:[1,21.3,19.8] } },
  tall: { top: 2, brim: 5.8, brimLeft: 5.477, brimRight: 18.523, brimHalf: 6.523, seatCrown: 3.5, seatParty: 2.75, eyeLeft: 4.5, eyeRight: 19.5,
    ears: { y: 3.5, left: 7.5, right: 16.5, tiltLeft: -36.382, tiltRight: 36.382 },
    bunny: { y: 3.05, left: 8.177, right: 15.823, tiltLeft: -29.674, tiltRight: 29.674 },
    fit: { antenna:[0.936,23.6,22.8],ears:[0.994,23.6,22.8],bunny:[0.819,23.6,22.8],horns:[0.969,23.6,22.8],sprout:[0.94,23.6,22.8],tuft:[1,23.4,22.8],beanie:[0.965,23.6,22.8],halo:[0.982,23.6,22.8],party:[0.894,23.6,22.8] } },
  ghost: { top: 2.4, brim: 6.2, brimLeft: 4.848, brimRight: 19.152, brimHalf: 7.152, seatCrown: 3.7, seatParty: 3, eyeLeft: 3.402, eyeRight: 20.598,
    ears: { y: 4.15, left: 6.79, right: 17.21, tiltLeft: -37.484, tiltRight: 37.484 },
    bunny: { y: 3.55, left: 7.666, right: 16.334, tiltLeft: -29.886, tiltRight: 29.886 },
    fit: { antenna:[0.988,23.6,21.8],ears:[1,22.115,21.8],bunny:[0.861,23.6,21.8],horns:[1,22.74,21.8],sprout:[0.992,23.6,21.8],tuft:[1,22,21.8],beanie:[1,23.1,21.8],halo:[1,22.65,21.8],party:[0.936,23.6,21.8] } },
  blob: { top: 2.5, brim: 7, brimLeft: 4.316, brimRight: 19.549, brimHalf: 7.617, seatCrown: 3.75, seatParty: 3.1, eyeLeft: 2.293, eyeRight: 21.072,
    ears: { y: 4.6, left: 6.481, right: 17.783, tiltLeft: -40.233, tiltRight: 43.001 },
    bunny: { y: 3.9, left: 7.404, right: 16.92, tiltLeft: -33.142, tiltRight: 33.977 },
    fit: { antenna:[0.973,23.6,22.3],bunny:[0.856,23.6,22.3],horns:[1,22.792,22.3],sprout:[0.977,23.6,22.3],tuft:[1,22.4,22.3],beanie:[1,23.5,22.3],halo:[1,23.05,22.3],party:[0.923,23.6,22.3] } },
  hex: { top: 1.9, brim: 7, brimLeft: 3.047, brimRight: 20.953, brimHalf: 8.953, seatCrown: 4.25, seatParty: 3.55, eyeLeft: 2.9, eyeRight: 21.1,
    ears: { y: 4.8, left: 6.518, right: 17.482, tiltLeft: -29.427, tiltRight: 29.427 },
    bunny: { y: 4.3, left: 7.404, right: 16.596, tiltLeft: -29.429, tiltRight: 29.429 },
    fit: { antenna:[0.977,23.6,21.6],bunny:[0.89,23.6,21.6],horns:[1,21.868,21.6],sprout:[0.981,23.6,21.6],tuft:[1,22.3,21.6],beanie:[1,23.4,21.6],halo:[1,22.95,21.6],party:[0.963,23.6,21.6] } },
  drop: { top: 2.5, brim: 9.2, brimLeft: 6.314, brimRight: 17.686, brimHalf: 5.686, seatCrown: 7.7, seatParty: 6.15, eyeLeft: 4.081, eyeRight: 19.919,
    ears: { y: 8, left: 7.229, right: 16.771, tiltLeft: -51.354, tiltRight: 51.354 },
    bunny: { y: 7.05, left: 8.012, right: 15.988, tiltLeft: -49.798, tiltRight: 49.798 },
    fit: { antenna:[0.929,23.6,23.5],bunny:[0.918,23.6,23.5],sprout:[0.933,23.6,23.5],tuft:[1,23.6,23.5],beanie:[0.958,23.6,23.5],halo:[0.975,23.6,23.5],party:[0.99,23.6,23.5] } }
};

function eyesMarkup(kind: ProfileLook['eyes'], c: Palette, y: number, dx: number): string {
  const L = 12 - dx, R = 12 + dx, E = c.eye, W = '#fff';
  const dot = (x: number, r = 1.6) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${E}"/>`;
  const caret = (x: number) => `<path d="M${x - 1.7} ${y + .8}q1.7-2.4 3.4 0" fill="none" stroke="${E}" stroke-width="1.5" stroke-linecap="round"/>`;
  const eyes: Record<ProfileLook['eyes'], string> = {
    dots: dot(L) + dot(R),
    wide: `<ellipse cx="${L}" cy="${y}" rx="1.35" ry="2.1" fill="${E}"/><ellipse cx="${R}" cy="${y}" rx="1.35" ry="2.1" fill="${E}"/>`,
    sparkle: dot(L, 2.05) + dot(R, 2.05) + `<circle cx="${L + .75}" cy="${y - .75}" r=".72" fill="${W}"/><circle cx="${R + .75}" cy="${y - .75}" r=".72" fill="${W}"/>`,
    happy: caret(L) + caret(R),
    line: `<path d="M${L - 1.6} ${y}h3.2M${R - 1.6} ${y}h3.2" stroke="${E}" stroke-width="1.6" stroke-linecap="round"/>`,
    sleepy: `<path d="M${L - 1.9} ${y - .3}a1.9 1.9 0 0 0 3.8 0zM${R - 1.9} ${y - .3}a1.9 1.9 0 0 0 3.8 0z" fill="${E}"/><path d="M${L - 2.1} ${y - .3}h4.2M${R - 2.1} ${y - .3}h4.2" stroke="${E}" stroke-width=".9" stroke-linecap="round"/>`,
    wink: dot(L) + caret(R),
    angry: dot(L) + dot(R) + `<path d="M${L - 1.9} ${y - 3.2}l3.2 1.2M${R + 1.9} ${y - 3.2}l-3.2 1.2" stroke="${E}" stroke-width="1.2" stroke-linecap="round"/>`,
    glasses: `<circle cx="${L}" cy="${y}" r="2.5" fill="none" stroke="${E}" stroke-width="1.1"/><circle cx="${R}" cy="${y}" r="2.5" fill="none" stroke="${E}" stroke-width="1.1"/><path d="M${L + 2.5} ${y}H${R - 2.5}" stroke="${E}" stroke-width="1.1"/>` + dot(L, .95) + dot(R, .95),
    shades: `<rect x="${L - 2.5}" y="${y - 1.6}" width="5" height="3.2" rx="1.3" fill="${E}"/><rect x="${R - 2.5}" y="${y - 1.6}" width="5" height="3.2" rx="1.3" fill="${E}"/><path d="M${L + 2.4} ${y - .9}H${R - 2.4}" stroke="${E}" stroke-width="1"/><path d="M${L - 1.5} ${y - .7}h1.2M${R - 1.5} ${y - .7}h1.2" stroke="${W}" stroke-width=".6" stroke-linecap="round" opacity=".6"/>`,
    visor: `<rect x="${L - 2.4}" y="${y - 1.6}" width="${2 * dx + 4.8}" height="3.2" rx="1.6" fill="${E}"/><circle cx="${R + .4}" cy="${y - .3}" r=".65" fill="${c.top}"/>`,
    cyclops: `<circle cx="12" cy="${y}" r="2.3" fill="${E}"/><circle cx="12.8" cy="${y - .8}" r=".7" fill="${W}"/>`
  };
  return `<g class="profile-face-eyes">${eyes[kind]}</g>`;
}

function mouthMarkup(kind: ProfileLook['mouth'], m: number, c: Palette): string {
  const E = c.eye, stroke = `stroke="${E}" stroke-width="1.1" fill="none" stroke-linecap="round"`;
  const smile = `<path d="M10.3 ${m - .4}q1.7 1.6 3.4 0" ${stroke}/>`;
  const mouths: Record<ProfileLook['mouth'], string> = {
    none: '',
    smile,
    grin: `<path d="M9.9 ${m - .8}h4.2a2.1 2.1 0 0 1-4.2 0z" fill="${E}"/>`,
    open: `<ellipse cx="12" cy="${m}" rx="1" ry="1.25" fill="${E}"/>`,
    flat: `<path d="M10.6 ${m}h2.8" ${stroke}/>`,
    cat: `<path d="M9.9 ${m - .6}q1.05 1.3 2.1 0q1.05 1.3 2.1 0" ${stroke}/>`,
    tongue: smile + `<path d="M11.3 ${m + .35}q.7 1.9 1.4 0z" fill="oklch(.7 .17 15)"/>`,
    fangs: smile + `<path d="M10.9 ${m + .15}l.4.9.4-.75zM12.3 ${m + .3}l.4.75.4-.9z" fill="#fff"/>`
  };
  return mouths[kind];
}

function markingMarkup(kind: ProfileLook['marking'], c: Palette, top: number, y: number, dx: number): string {
  const D = c.dark, L = 12 - dx, R = 12 + dx;
  const freckles = (x: number, s: number) => [[0, 2.3], [s * 1.1, 3.1], [s * -.9, 3.3]].map(([ox, oy]) => `<circle cx="${x + ox!}" cy="${y + oy!}" r=".42" fill="${D}"/>`).join('');
  const markings: Record<ProfileLook['marking'], string> = {
    none: '',
    freckles: freckles(L - .6, -1) + freckles(R + .6, 1),
    spot: `<circle cx="17.2" cy="${top + 3.8}" r="3.9" fill="${D}" opacity=".8"/>`,
    stripe: `<rect x="0" y="${top + 2.3}" width="24" height="2.3" fill="${D}" opacity=".8"/>`,
    split: `<rect x="12" y="0" width="12" height="24" fill="${D}" opacity=".55"/>`,
    belly: `<ellipse cx="12" cy="20.6" rx="6.6" ry="4.6" fill="${c.acc2}" opacity=".9"/>`
  };
  return markings[kind];
}

// Ears, horns and bunny ears hang off both shoulders: drawn pointing up in
// local space, mirrored for the right side and tilted with the outline.
function pair(at: Pair, lean: number, draw: string): string {
  return [[at.left, at.tiltLeft, 1], [at.right, at.tiltRight, -1]]
    .map(([x, tilt, flip]) => `<g transform="translate(${x} ${at.y}) rotate(${(tilt! * lean).toFixed(1)}) scale(${flip} 1)">${draw}</g>`)
    .join('');
}

// Returns [behind the head, in front of it].
function hatMarkup(hat: FaceHat, shape: FaceShape, a: Palette, c: Palette): [string, string] {
  const A = a.acc, A2 = a.acc2, E = c.eye, B = c.bot, g = ANCHORS[shape], T = g.top, eye = SHAPES[shape].eye;
  const b = g.brim, bl = g.brimLeft, br = g.brimRight, cx = (bl + br) / 2;
  const dome = (lift: number) => {
    const rx = (br - bl) / 2 + .35, ry = b - T + 1.4 + lift;
    return { ry, d: `M${bl - .35} ${b}A${rx} ${ry} 0 0 1 ${br + .35} ${b}Z` };
  };
  switch (hat) {
    case 'none': return ['', ''];
    case 'antenna': return ['', `<path d="M12 ${T + .6}V${T - 2.6}" stroke="${E}" stroke-width="1.1" stroke-linecap="round"/><circle cx="12" cy="${T - 3.5}" r="1.6" fill="${A}"/>`];
    case 'ears': return [pair(g.ears, .45, `<path d="M-2.3 3L-.7-4.2L3.6 2.6Z" fill="${B}" stroke="${B}" stroke-width="1.4" stroke-linejoin="round"/><path d="M-1.3 1.2L-.5-2.4L1.65 1Z" fill="${A}"/>`), ''];
    case 'bunny': return [pair(g.bunny, .3, `<ellipse cx="0" cy="-4.4" rx="2" ry="5.4" fill="${B}"/><ellipse cx="0" cy="-3.8" rx=".95" ry="3.6" fill="${A}"/>`), ''];
    case 'horns': return [pair(g.ears, .45, `<path d="M-1.6 1.4C-2-1.4-1.3-3.6.7-5.4.2-3.3.7-1.4 1.8 1.1Z" fill="${A}"/>`), ''];
    case 'sprout': return ['', `<path d="M12 ${T + .6}V${T - 2.4}" stroke="${A}" stroke-width="1.1" stroke-linecap="round"/><path d="M12 ${T - 2}c-.5-1.9-2.3-2.7-3.9-2.3.3 1.7 2.1 2.6 3.9 2.3zM12 ${T - 2.4}c.4-2 2.2-2.9 4-2.5-.4 1.8-2.2 2.8-4 2.5z" fill="${A}"/>`];
    case 'tuft': return ['', `<path d="M10.4 ${T + .9}q-.8-2.4.4-3.9M12 ${T + .7}q-.2-2.8 1.4-3.9M13.6 ${T + .9}q.5-2 2-2.6" stroke="${A}" stroke-width="1.25" fill="none" stroke-linecap="round"/>`];
    case 'cap': {
      const m = dome(0);
      return ['', `<path d="${m.d}" fill="${A}"/><path d="M${cx} ${b}H${br + 2.4}" stroke="${A}" stroke-width="1.8" stroke-linecap="round"/><circle cx="${cx}" cy="${b - m.ry + .6}" r=".75" fill="${A2}"/>`];
    }
    case 'beanie': {
      const m = dome(.5);
      return ['', `<path d="${m.d}" fill="${A}"/><rect x="${bl - .8}" y="${b - 1.7}" width="${br - bl + 1.6}" height="2.5" rx="1.25" fill="${A2}"/><circle cx="${cx}" cy="${b - m.ry - .7}" r="1.7" fill="${A2}"/>`];
    }
    case 'crown': {
      const y = g.seatCrown + .9, x = cx - 12;
      return ['', `<path d="M${7.2 + x} ${y}L${7.4 + x} ${y - 4.2}L${9.7 + x} ${y - 2.2}L${12 + x} ${y - 5}L${14.3 + x} ${y - 2.2}L${16.6 + x} ${y - 4.2}L${16.8 + x} ${y}z" fill="${A}" stroke="${A}" stroke-width=".9" stroke-linejoin="round"/><circle cx="${12 + x}" cy="${y - 1.2}" r=".75" fill="${A2}"/>`];
    }
    case 'halo': {
      const rx = Math.min(6, Math.max(4, g.brimHalf * .62));
      return ['', `<ellipse cx="12" cy="${T - 2.5}" rx="${rx}" ry="1.35" fill="none" stroke="${A}" stroke-width="1.3"/>`];
    }
    case 'party': {
      const y = g.seatParty + .9;
      return ['', `<path d="M${cx} ${y - 6.6}L${cx + 3.3} ${y}H${cx - 3.3}z" fill="${A}" stroke="${A}" stroke-width=".9" stroke-linejoin="round"/><path d="M${cx - 1.7} ${y - 3}h3.4" stroke="${A2}" stroke-width="1"/><circle cx="${cx}" cy="${y - 6.8}" r="1.2" fill="${A2}"/>`];
    }
    case 'phones': {
      const l = g.eyeLeft, r = g.eyeRight, cy = (T - 1.1 - .25 * (eye - 1)) / .75;
      return ['', `<path d="M${l} ${eye - 1}C${l} ${cy} ${r} ${cy} ${r} ${eye - 1}" fill="none" stroke="${A}" stroke-width="1.5"/><rect x="${l - 1.9}" y="${eye - 1.8}" width="3.4" height="5.6" rx="1.6" fill="${A}"/><rect x="${r - 1.5}" y="${eye - 1.8}" width="3.4" height="5.6" rx="1.6" fill="${A}"/>`];
    }
  }
}

export interface FaceMarkup {
  // The SVG's children, for a 0 0 24 24 view box.
  body: string;
  // A drop-shadow filter for the glow finish.
  filter: string | null;
}

// `id` keeps gradient and clip references unique on a page. Below 20 px,
// mouths, cheeks and most markings drop out, so colour, shape and hat carry
// the difference.
export function faceMarkup(look: ProfileLook, size: number, id: string): FaceMarkup {
  const c = facePalette(look.color), a = facePalette(look.accent), sh = SHAPES[look.shape], tiny = size < 20;
  const T = sh.top, y = sh.eye, dx = sh.dx;
  const paint = look.finish === 'flat' ? c.flat : `url(#${id}-g)`;
  const [back, front] = hatMarkup(look.hat, look.shape, a, c);
  const fitted = ANCHORS[look.shape].fit[look.hat];
  const fit = fitted ? ` transform="translate(12 ${fitted[1]}) scale(${fitted[0]}) translate(-12 ${-fitted[2]})"` : '';
  const mark = tiny && look.marking !== 'split' ? '' : markingMarkup(look.marking, c, T, y, dx);
  const gloss = look.finish === 'glossy' ? `<ellipse cx="8.2" cy="${T + 4.4}" rx="3.1" ry="1.5" fill="#fff" opacity=".55" transform="rotate(-32 8.2 ${T + 4.4})"/>` : '';
  const clip = mark || gloss ? `<g clip-path="url(#${id}-c)">${mark}${gloss}</g>` : '';
  const cheeks = look.cheeks && !tiny ? `<ellipse cx="${12 - dx - 1.1}" cy="${y + 2.5}" rx="1.5" ry=".9" fill="oklch(.72 .17 12 / .5)"/><ellipse cx="${12 + dx + 1.1}" cy="${y + 2.5}" rx="1.5" ry=".9" fill="oklch(.72 .17 12 / .5)"/>` : '';
  const mouth = tiny ? '' : mouthMarkup(look.mouth, y + (sh.mouth ?? 4.2), c);
  const defs = `<defs><radialGradient id="${id}-g" cx="36%" cy="28%" r="80%"><stop offset="0" stop-color="${c.top}"/><stop offset="1" stop-color="${c.bot}"/></radialGradient><clipPath id="${id}-c">${sh.d('#000')}</clipPath></defs>`;
  return {
    body: `${defs}<g${fit}>${back}${sh.d(paint)}${clip}${cheeks}${eyesMarkup(look.eyes, c, y, dx)}${mouth}${front}</g>`,
    filter: look.finish === 'glow' ? `drop-shadow(0 0 ${Math.max(3, size * .16).toFixed(1)}px ${c.glow})` : null
  };
}

// Seeded, so a profile without a saved face always gets the same one.
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = state + 0x6D2B79F5 | 0;
    let t = Math.imul(state ^ state >>> 15, 1 | state);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function hash(text: string): number {
  let value = 2166136261;
  for (let index = 0; index < text.length; index++) value = Math.imul(value ^ text.charCodeAt(index), 16777619);
  return value >>> 0;
}

function pick<T>(next: () => number, options: readonly T[]): T {
  return options[Math.floor(next() * options.length)]!;
}

export function randomLook(seed: number): ProfileLook {
  const next = random(seed);
  return {
    color: next() < .1 ? pick(next, ['white', 'graphite'] as const) : pick(next, FACE_HUES),
    shape: pick(next, FACE_SHAPES),
    finish: next() < .55 ? 'soft' : pick(next, FACE_FINISHES),
    marking: next() < .65 ? 'none' : pick(next, FACE_MARKINGS.slice(1)),
    eyes: pick(next, FACE_EYES),
    mouth: next() < .3 ? 'none' : pick(next, FACE_MOUTHS.slice(1)),
    cheeks: next() < .35,
    hat: next() < .35 ? 'none' : pick(next, FACE_HATS.slice(1)),
    accent: pick(next, FACE_HUES),
    idle: pick(next, FACE_IDLES)
  };
}

// The plain CLIs' seeded presets start with a designed face.
const SEEDED_LOOKS: Record<string, ProfileLook> = {
  preset_default_claude: { color: 'orange', shape: 'circle', finish: 'soft', marking: 'none', eyes: 'dots', mouth: 'smile', cheeks: true, hat: 'none', accent: 'amber', idle: 'blink' },
  preset_default_codex: { color: 'sky', shape: 'squircle', finish: 'glossy', marking: 'none', eyes: 'wide', mouth: 'flat', cheeks: false, hat: 'antenna', accent: 'amber', idle: 'glance' },
  preset_default_opencode: { color: 'graphite', shape: 'hex', finish: 'flat', marking: 'none', eyes: 'visor', mouth: 'none', cheeks: false, hat: 'phones', accent: 'cyan', idle: 'still' }
};

export function lookFor(profile: { id: string; look?: ProfileLook | null }): ProfileLook {
  return profile.look ?? SEEDED_LOOKS[profile.id] ?? randomLook(hash(profile.id));
}
