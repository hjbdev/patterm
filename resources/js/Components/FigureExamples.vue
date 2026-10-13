<template>
  <div class="py-4" aria-roledescription="carousel" aria-label="Example pages">
    <div class="mb-3 flex items-center gap-1">
      <Button
        v-for="(example, index) in FIGURE_EXAMPLES"
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
    <!-- A fixed height keeps the arrows still while pages of different sizes swap. -->
    <div class="min-h-[20rem] rounded-lg border border-white/[0.06] p-4" aria-live="polite">
      <HtmlFigureCard :key="current" :page="FIGURE_EXAMPLES[current]!.page" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { defineAsyncComponent, ref } from 'vue';
import { ChevronLeft, ChevronRight } from 'lucide-vue-next';
import { FIGURE_EXAMPLES } from '../lib/figureExamples';
import { Button } from './ui/button';

const HtmlFigureCard = defineAsyncComponent(() => import('./HtmlFigureCard.vue'));
const current = ref(0);

function step(by: number): void {
  current.value = (current.value + by + FIGURE_EXAMPLES.length) % FIGURE_EXAMPLES.length;
}
</script>
