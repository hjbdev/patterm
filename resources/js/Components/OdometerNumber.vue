<template>
  <span class="relative inline-block whitespace-pre tabular-nums">
    <span class="sr-only">{{ value }}</span>
    <span ref="mount" class="inline-block select-none" aria-hidden="true" />
  </span>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { createRollingNumber, type RollingNumberController } from '@kitlangton/rolling-number';
import '@kitlangton/rolling-number/styles.css';

const props = defineProps<{ value: number }>();

// The controller owns the mount's children; Vue only renders the accessible text.
const mount = ref<HTMLElement | null>(null);
let controller: RollingNumberController | null = null;

onMounted(() => {
  if (mount.value) controller = createRollingNumber(mount.value, { value: props.value, duration: 400 });
});

watch(() => props.value, (value) => controller?.update({ value }));

onBeforeUnmount(() => {
  controller?.destroy();
  controller = null;
});
</script>
