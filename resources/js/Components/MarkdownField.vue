<template>
  <textarea
    v-if="editing"
    ref="textarea"
    :value="modelValue"
    :aria-label="label"
    :placeholder="placeholder"
    spellcheck="true"
    class="markdown-field block w-full resize-none bg-transparent text-sm leading-7 text-foreground outline-none placeholder:text-muted-foreground/70"
    :class="[mono && 'font-mono text-[13px] leading-6', minHeightClass]"
    @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
    @blur="finish"
    @keydown.esc.prevent="finish"
  />
  <div
    v-else
    role="button"
    tabindex="0"
    :aria-label="`Edit ${label.toLowerCase()}`"
    class="cursor-text rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
    :class="minHeightClass"
    @click="start"
    @keydown.enter.prevent="start"
  >
    <Markdown v-if="modelValue.trim()" :source="modelValue" />
    <p v-else class="text-sm leading-7 text-muted-foreground/70">{{ placeholder }}</p>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import Markdown from './Markdown.vue';

// Shows rendered Markdown and becomes a plain editor when clicked, so reading
// and writing share one surface without Edit and Preview tabs.
withDefaults(defineProps<{ modelValue: string; label: string; placeholder?: string; mono?: boolean; minHeightClass?: string }>(), { placeholder: '', mono: false, minHeightClass: 'min-h-24' });
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const editing = defineModel<boolean>('editing', { default: false });
const textarea = ref<HTMLTextAreaElement | null>(null);

function start(event?: Event) {
  // Let links and copy buttons inside the rendered Markdown work.
  if (event && (event.target as HTMLElement).closest('a, button')) return;
  if (window.getSelection()?.toString()) return;
  editing.value = true;
}
function finish() {
  editing.value = false;
}
watch(editing, async (value) => {
  if (!value) return;
  await nextTick();
  textarea.value?.focus({ preventScroll: true });
});
defineExpose({ start });
</script>

<style scoped>
.markdown-field { field-sizing: content; }
</style>
