<template>
  <!-- Grows from 0fr to 1fr so the content animates to its natural height. -->
  <div class="tool-collapse" :data-open="shown ? '' : undefined" :inert="!open || undefined">
    <div class="tool-collapse-inner"><slot v-if="mounted" /></div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';

// `prepare` loads what the content needs, such as lazy chunks, before it
// mounts; `ready` resolves once the mounted content has drawn.
const props = defineProps<{ open: boolean; prepare?: (() => Promise<unknown>) | undefined; ready?: (() => Promise<unknown>) | undefined }>();

// Content mounts on first open and stays, so later toggles animate without
// re-rendering diffs or highlighting.
const mounted = ref(props.open);
const shown = ref(props.open);

const frames = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const capped = (work: Promise<unknown>, ms: number): Promise<unknown> => Promise.race([work.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, ms))]);

watch(() => props.open, async (open) => {
  if (!open) {
    shown.value = false;
    return;
  }
  if (!mounted.value) {
    // Load the content's chunks, mount it, and give it two frames to lay out,
    // so the panel opens to its real height. Capped so it never stalls a click.
    const started = performance.now();
    await capped(props.prepare?.() ?? Promise.resolve(), 300);
    mounted.value = true;
    await nextTick();
    await capped(Promise.all([frames(), props.ready?.()]), Math.max(0, 300 - (performance.now() - started)));
    if (!props.open) return;
  }
  shown.value = true;
});
</script>
