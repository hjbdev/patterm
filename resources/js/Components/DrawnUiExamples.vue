<template>
  <div class="py-4" aria-roledescription="carousel" aria-label="Example figures">
    <div class="mb-3 flex items-center gap-1">
      <Button
        v-for="(example, index) in DRAWN_UI_EXAMPLES"
        :key="example.label"
        size="sm"
        variant="ghost"
        class="h-7 px-2.5 text-xs"
        :class="index === current ? 'bg-white/[0.07] text-foreground' : 'text-muted-foreground'"
        :aria-pressed="index === current"
        @click="current = index"
      >{{ example.label }}</Button>
      <Button size="icon" variant="ghost" class="ml-auto h-7 w-7 text-muted-foreground" aria-label="Previous example" @click="step(-1)"><ChevronLeft class="h-4 w-4" /></Button>
      <Button size="icon" variant="ghost" class="h-7 w-7 text-muted-foreground" aria-label="Next example" @click="step(1)"><ChevronRight class="h-4 w-4" /></Button>
    </div>
    <!-- A fixed height keeps the arrows still while figures of different sizes swap. -->
    <div class="min-h-[22rem] rounded-lg border border-white/[0.06] p-4" aria-live="polite">
      <DrawnUiCard :key="current" :spec="DRAWN_UI_EXAMPLES[current]!.spec" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { defineAsyncComponent, ref } from 'vue';
import { ChevronLeft, ChevronRight } from 'lucide-vue-next';
import { DRAWN_UI_EXAMPLES } from '../lib/drawnUiExamples';
import { Button } from './ui/button';

// Figures load their schema and chart library only when shown.
const DrawnUiCard = defineAsyncComponent(() => import('./DrawnUi/DrawnUiCard.vue'));
const current = ref(0);

function step(by: number): void {
  current.value = (current.value + by + DRAWN_UI_EXAMPLES.length) % DRAWN_UI_EXAMPLES.length;
}
</script>
