// A profile's face: the little character that stands for a harness preset in
// the launch menu and settings. Every part is an enum, so a stored look can
// only name parts the renderer knows how to draw. No zod here: the renderer
// imports these lists, and the schema lives with the presets.
export const FACE_HUES = ['red', 'orange', 'amber', 'yellow', 'lime', 'green', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'pink'] as const;
export const FACE_COLORS = [...FACE_HUES, 'white', 'graphite'] as const;
export const FACE_SHAPES = ['circle', 'squircle', 'egg', 'pill', 'tall', 'ghost', 'blob', 'hex', 'drop'] as const;
export const FACE_FINISHES = ['soft', 'flat', 'glossy', 'glow'] as const;
export const FACE_MARKINGS = ['none', 'freckles', 'spot', 'stripe', 'split', 'belly'] as const;
export const FACE_EYES = ['dots', 'wide', 'sparkle', 'happy', 'line', 'sleepy', 'wink', 'angry', 'glasses', 'shades', 'visor', 'cyclops'] as const;
export const FACE_MOUTHS = ['none', 'smile', 'grin', 'open', 'flat', 'cat', 'tongue', 'fangs'] as const;
export const FACE_HATS = ['none', 'antenna', 'ears', 'bunny', 'horns', 'sprout', 'tuft', 'cap', 'beanie', 'crown', 'halo', 'party', 'phones'] as const;
export const FACE_IDLES = ['still', 'blink', 'glance', 'bob'] as const;

export type FaceColor = (typeof FACE_COLORS)[number];
export type FaceShape = (typeof FACE_SHAPES)[number];
export type FaceHat = (typeof FACE_HATS)[number];

export interface ProfileLook {
  color: FaceColor;
  shape: FaceShape;
  finish: (typeof FACE_FINISHES)[number];
  marking: (typeof FACE_MARKINGS)[number];
  eyes: (typeof FACE_EYES)[number];
  mouth: (typeof FACE_MOUTHS)[number];
  cheeks: boolean;
  hat: FaceHat;
  accent: FaceColor;
  idle: (typeof FACE_IDLES)[number];
}
