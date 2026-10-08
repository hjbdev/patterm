<template>
  <div class="mb-3 grid grid-cols-[max-content_1fr_4rem] items-center gap-x-3 gap-y-1.5 text-xs max-sm:grid-cols-[1fr_3.5rem]">
    <template v-for="input in inputs" :key="input.id">
      <label :for="`${uid}-${input.id}`" class="text-muted-foreground max-sm:col-span-2 max-sm:-mb-1">{{ input.label }}</label>
      <input :id="`${uid}-${input.id}`" v-model.number="values[input.id]" type="range" :min="input.min" :max="input.max" :step="input.step ?? 1" class="w-full accent-foreground">
      <output :for="`${uid}-${input.id}`" class="text-right font-mono tabular-nums">{{ formatDrawnNumber(values[input.id]) }}{{ input.unit ?? '' }}</output>
    </template>
  </div>
</template>

<script setup lang="ts">
import { useId } from 'vue';
import { formatDrawnNumber, type DrawnSection } from '../../../../app/Services/DrawnUi';

// Slider positions are a viewer's own; they are not sent anywhere.
defineProps<{ inputs: NonNullable<DrawnSection['inputs']>; values: Record<string, number> }>();
const uid = useId();
</script>
