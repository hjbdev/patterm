<template>
  <svg viewBox="0 0 16 16" class="shrink-0" :aria-label="`${label} priority`" role="img">
    <rect v-for="bar in 3" :key="bar" :x="1 + (bar - 1) * 5" :y="12 - bar * 3.5" width="3.5" :height="2 + bar * 3.5" rx="1" fill="currentColor" :opacity="bar <= level ? 1 : 0.25" />
  </svg>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { todoPriorityOption } from '../../lib/todoStatus';

const props = defineProps<{ priority: string }>();
const level = computed(() => ({ high: 3, medium: 2, low: 1 })[props.priority] ?? 2);
const label = computed(() => todoPriorityOption(props.priority).label);
</script>
