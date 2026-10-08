<template>
  <!-- Dated steps read left to right as a timeline; others as a list. -->
  <div v-if="dated" class="overflow-x-auto">
    <ol class="relative grid min-w-0" :style="{ gridTemplateColumns: `repeat(${steps.items.length}, minmax(7rem, 1fr))` }">
      <span class="absolute inset-x-0 top-[33px] border-t border-border" aria-hidden="true" />
      <li v-for="(item, index) in steps.items" :key="index" class="relative pr-3">
        <p class="h-6 text-xs text-muted-foreground">{{ item.date }}</p>
        <span :class="markClass(item.status)" class="relative my-1 grid h-4 w-4 place-items-center rounded-full border-[1.5px] text-[10px]">{{ item.status === 'done' ? '✓' : '' }}</span>
        <p class="mt-1.5 text-xs font-medium" :class="(item.status ?? 'next') === 'next' ? 'text-muted-foreground' : ''">{{ item.title }}</p>
        <p v-if="item.body" class="text-xs text-muted-foreground">{{ item.body }}</p>
      </li>
    </ol>
  </div>
  <ol v-else class="space-y-1.5">
    <li v-for="(item, index) in steps.items" :key="index" class="grid grid-cols-[1.25rem_1fr] gap-2.5">
      <span :class="markClass(item.status)" class="mt-0.5 grid h-4 w-4 place-items-center rounded-full border-[1.5px] text-[10px]">{{ item.status === 'done' ? '✓' : '' }}</span>
      <div class="min-w-0">
        <p class="font-medium" :class="(item.status ?? 'next') === 'next' ? 'text-muted-foreground' : ''">{{ item.title }}</p>
        <p v-if="item.body" class="text-xs text-muted-foreground">{{ item.body }}</p>
      </div>
      <span class="sr-only">{{ item.status ?? 'next' }}</span>
    </li>
  </ol>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { DrawnSteps } from '../../../../app/Services/DrawnUi';

const props = defineProps<{ steps: DrawnSteps }>();
const dated = computed(() => props.steps.items.every((item) => item.date));

function markClass(status: string | undefined): string {
  if (status === 'done') return 'border-[var(--drawn-good)] text-[var(--drawn-good)] bg-card';
  if (status === 'now') return 'border-[var(--drawn-accent)] bg-[var(--drawn-accent)] shadow-[0_0_0_3px_var(--drawn-accent-wash)]';
  return 'border-muted-foreground/50 bg-card';
}
</script>
