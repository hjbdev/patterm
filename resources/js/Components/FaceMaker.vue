<template>
  <div class="space-y-1">
    <SettingsChoice v-model="part" :options="PARTS" aria-label="Face part" segmented />
    <div class="divide-y divide-border">
      <div v-for="row in rows" :key="row.key" class="flex items-start gap-3 py-2">
        <span class="w-16 shrink-0 pt-2 text-xs text-muted-foreground">{{ row.label }}</span>
        <div class="flex min-w-0 flex-wrap gap-0.5" role="radiogroup" :aria-label="row.label">
          <button
            v-for="option in row.options"
            :key="String(option)"
            type="button"
            role="radio"
            :aria-checked="look[row.key] === option"
            :aria-label="`${row.label} ${optionLabel(option)}`"
            :title="optionLabel(option)"
            :class="cn('flex items-center justify-center rounded-md outline-none hover:bg-muted/60 focus-visible:ring-1 focus-visible:ring-ring', row.swatch ? 'h-8 w-8' : 'h-10 w-10', look[row.key] === option && 'bg-white/[0.1] ring-1 ring-inset ring-white/[0.16]')"
            @click="set(row.key, option)"
          >
            <span v-if="row.swatch" class="h-[18px] w-[18px] rounded-full" :style="{ background: swatch(option as FaceColor) }" />
            <ProfileFace v-else :look="{ ...look, [row.key]: option }" :size="24" :motion="row.key === 'idle'" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { cn } from '@/lib/utils';
import { FACE_COLORS, FACE_EYES, FACE_FINISHES, FACE_HATS, FACE_IDLES, FACE_MARKINGS, FACE_MOUTHS, FACE_SHAPES, facePalette, type FaceColor, type ProfileLook } from '../lib/faces';
import ProfileFace from './ProfileFace.vue';
import SettingsChoice from './settings/SettingsChoice.vue';

type Part = 'body' | 'face' | 'hat' | 'motion';
type Key = keyof ProfileLook;
interface Row { key: Key; label: string; options: readonly (string | boolean)[]; swatch?: boolean }

const look = defineModel<ProfileLook>({ required: true });
const part = ref<Part>('body');

const PARTS: Array<{ value: Part; label: string }> = [
  { value: 'body', label: 'Body' },
  { value: 'face', label: 'Face' },
  { value: 'hat', label: 'Hat' },
  { value: 'motion', label: 'Motion' }
];

const ROWS: Record<Part, Row[]> = {
  body: [
    { key: 'color', label: 'Colour', options: FACE_COLORS, swatch: true },
    { key: 'shape', label: 'Shape', options: FACE_SHAPES },
    { key: 'finish', label: 'Finish', options: FACE_FINISHES },
    { key: 'marking', label: 'Marking', options: FACE_MARKINGS }
  ],
  face: [
    { key: 'eyes', label: 'Eyes', options: FACE_EYES },
    { key: 'mouth', label: 'Mouth', options: FACE_MOUTHS },
    { key: 'cheeks', label: 'Cheeks', options: [false, true] }
  ],
  // The hat has its own colour, so two pink profiles still differ at a glance.
  hat: [
    { key: 'hat', label: 'Hat', options: FACE_HATS },
    { key: 'accent', label: 'Accent', options: FACE_COLORS, swatch: true }
  ],
  motion: [
    { key: 'idle', label: 'Idle', options: FACE_IDLES }
  ]
};
const rows = computed(() => ROWS[part.value]);

function set(key: Key, value: string | boolean): void {
  look.value = { ...look.value, [key]: value };
}

function optionLabel(option: string | boolean): string {
  return option === true ? 'on' : option === false ? 'off' : option;
}

function swatch(color: FaceColor): string {
  const palette = facePalette(color);
  return `radial-gradient(circle at 36% 30%, ${palette.top}, ${palette.bot})`;
}
</script>
