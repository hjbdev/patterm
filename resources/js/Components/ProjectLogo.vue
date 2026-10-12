<template>
  <img v-if="project.logo" :src="project.logo" alt="" class="shrink-0 rounded-[22%] object-contain" :style="box" draggable="false" />
  <span
    v-else-if="project.kind === 'personal'"
    aria-hidden="true"
    class="inline-flex shrink-0 items-center justify-center rounded-[22%] bg-muted text-muted-foreground"
    :style="box"
  ><UserRound :style="glyph" /></span>
  <span
    v-else
    aria-hidden="true"
    class="inline-flex shrink-0 select-none items-center justify-center rounded-[22%] font-semibold leading-none"
    :style="tile"
  >{{ letter }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { UserRound } from 'lucide-vue-next';
import { monogram, monogramHue } from '../lib/projectLogo';
import type { ProjectSummary } from '../types';

// The project's logo, or a muted monogram tile when it has none. The Personal
// project shows a person instead of a monogram.
const props = withDefaults(defineProps<{ project: Pick<ProjectSummary, 'id' | 'name' | 'logo' | 'kind'>; size?: number }>(), { size: 14 });

const box = computed(() => ({ width: `${props.size}px`, height: `${props.size}px` }));
const glyph = computed(() => ({ width: `${Math.round(props.size * 0.7)}px`, height: `${Math.round(props.size * 0.7)}px` }));
const letter = computed(() => monogram(props.project.name));
const tile = computed(() => {
  const hue = monogramHue(props.project.id);
  return { ...box.value, fontSize: `${Math.round(props.size * 0.6)}px`, backgroundColor: `hsl(${hue} 18% 24%)`, color: `hsl(${hue} 28% 76%)` };
});
</script>
