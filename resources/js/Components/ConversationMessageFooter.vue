<template>
  <div
    class="flex h-6 items-center gap-1.5 text-xs text-muted-foreground opacity-0 transition-opacity duration-150 focus-within:opacity-100 [@media(hover:hover)]:group-hover/row:opacity-100 group-data-[tapped]/row:opacity-100 motion-reduce:transition-none"
    :class="align === 'end' ? 'justify-end' : ''"
    data-component="transcript-message-footer"
  >
    <button
      type="button"
      class="-ml-1 flex h-6 w-6 items-center justify-center rounded-md hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      :class="align === 'end' ? 'order-last -mr-1 ml-0' : ''"
      :aria-label="copied ? 'Copied' : 'Copy message'"
      @click="copy"
    >
      <Check v-if="copied" class="h-3.5 w-3.5" aria-hidden="true" />
      <Copy v-else class="h-3.5 w-3.5" aria-hidden="true" />
    </button>
    <time v-if="time" :datetime="createdAt" :title="createdAt ? formatTimestamp(createdAt) : undefined">{{ time }}</time>
    <template v-if="duration">
      <span aria-hidden="true">·</span>
      <span :aria-label="`Took ${duration}`">{{ duration }}</span>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { Check, Copy } from 'lucide-vue-next';
import { elapsedLabel } from '../lib/integratedConversation';
import { formatMessageTime, formatTimestamp } from '../lib/format';

const props = withDefaults(defineProps<{ text: string; createdAt?: string | undefined; durationMs?: number | null | undefined; align?: 'start' | 'end' }>(), { createdAt: undefined, durationMs: null, align: 'start' });

const time = computed(() => props.createdAt ? formatMessageTime(props.createdAt) : '');
const duration = computed(() => props.durationMs !== null && props.durationMs !== undefined && props.durationMs >= 1_000 ? elapsedLabel(props.durationMs) : '');
const copied = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

function copy(): void {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return;
  void navigator.clipboard.writeText(props.text).then(() => {
    copied.value = true;
    clearTimeout(timer);
    timer = setTimeout(() => { copied.value = false; }, 1_200);
  }).catch(() => { /* Clipboard access can be denied; the text stays selectable. */ });
}

onBeforeUnmount(() => clearTimeout(timer));
</script>
