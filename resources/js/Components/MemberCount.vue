<template>
  <!-- A subagent count with a small chevron under it, for tabs and sidebar rows.
       The chevron flips to point up while the row's members are shown. -->
  <WorkingShimmer :active="shimmer ?? false" class="h-4 min-w-[7px] shrink-0 justify-center">
    <span v-if="!bare" class="text-[10px] font-medium leading-[10px] tabular-nums">{{ count }}</span>
    <!-- About a digit wide, so the number and chevron read as one glyph. -->
    <svg class="absolute h-1 w-[7px] transition-transform duration-200 motion-reduce:transition-none" :class="[bare ? 'top-1/2 -mt-0.5' : 'bottom-0.5', open && 'rotate-180']" viewBox="0 0 7 4" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m1 1 2.5 2 2.5-2" /></svg>
  </WorkingShimmer>
</template>

<script setup lang="ts">
import WorkingShimmer from './WorkingShimmer.vue';

// `shimmer` while subagents work.
// `bare` shows only the chevron, when the number is shown elsewhere.
defineProps<{ count: number; open?: boolean | undefined; shimmer?: boolean | undefined; bare?: boolean | undefined }>();
</script>
