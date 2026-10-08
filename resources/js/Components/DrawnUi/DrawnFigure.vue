<template>
  <DrawnChart v-if="figure.type === 'chart'" :chart="figure" />
  <DrawnTable v-else-if="figure.type === 'table'" :table="figure" />
  <DrawnDiagram v-else-if="figure.type === 'diagram'" :diagram="figure" />
  <DrawnStats v-else-if="figure.type === 'stats'" :stats="figure" />
  <DrawnSteps v-else-if="figure.type === 'steps'" :steps="figure" />
  <DrawnChoice v-else-if="figure.type === 'choice'" :choice="figure" />
  <DrawnImage v-else-if="figure.type === 'image'" :image="figure" :sha256="images[figure.path]" />
</template>

<script setup lang="ts">
import DrawnChart from './DrawnChart.vue';
import DrawnTable from './DrawnTable.vue';
import DrawnDiagram from './DrawnDiagram.vue';
import DrawnStats from './DrawnStats.vue';
import DrawnSteps from './DrawnSteps.vue';
import DrawnChoice from './DrawnChoice.vue';
import DrawnImage from './DrawnImage.vue';
import type { DrawnFigure } from '../../../../app/Services/DrawnUi';

defineProps<{ figure: DrawnFigure; images: Record<string, string> }>();
</script>
