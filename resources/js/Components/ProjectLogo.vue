<template>
  <img v-if="project.logo" :src="project.logo" alt="" class="shrink-0 rounded-[22%] object-contain" :style="box" draggable="false" />
  <span
    v-else
    aria-hidden="true"
    class="inline-flex shrink-0 select-none items-center justify-center rounded-[22%] font-semibold leading-none"
    :style="tile"
  >{{ letter }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { monogram, monogramHue } from '../lib/projectLogo';
import type { ProjectSummary } from '../types';

// The project's logo, or a muted monogram tile when it has none.
const props = withDefaults(defineProps<{ project: Pick<ProjectSummary, 'id' | 'name' | 'logo'>; size?: number }>(), { size: 14 });

const box = computed(() => ({ width: `${props.size}px`, height: `${props.size}px` }));
const letter = computed(() => monogram(props.project.name));
const tile = computed(() => {
  const hue = monogramHue(props.project.id);
  return { ...box.value, fontSize: `${Math.round(props.size * 0.6)}px`, backgroundColor: `hsl(${hue} 18% 24%)`, color: `hsl(${hue} 28% 76%)` };
});
</script>
