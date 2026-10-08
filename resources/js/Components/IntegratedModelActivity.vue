<template>
  <!-- Narrow screens keep only the icon and the time. -->
  <span class="inline-flex items-center gap-1" title="Time since the agent last sent a model request. Prompt caches expire after a quiet period." data-component="integrated-model-activity">
    <History class="h-3.5 w-3.5 sm:hidden" aria-hidden="true" />
    <span><span class="hidden sm:inline">last request </span>{{ label }}<span class="hidden sm:inline"> ago</span></span>
  </span>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { History } from 'lucide-vue-next';
import { elapsedLabel } from '../lib/integratedConversation';

// The one-second tick lives here so only this label re-renders.
const props = defineProps<{ at: string }>();
const now = ref(Date.now());
const interval = setInterval(() => { now.value = Date.now(); }, 1000);
onBeforeUnmount(() => clearInterval(interval));
const label = computed(() => elapsedLabel(now.value - Date.parse(props.at)));
</script>
