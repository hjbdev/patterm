<template>
  <div class="w-full min-w-0 text-xs" data-component="transcript-thinking">
    <button
      type="button"
      class="group/thought flex min-w-0 items-center gap-1.5 rounded-md py-1 pr-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      :aria-expanded="open"
      :aria-controls="`thinking-${message.id}`"
      @click="open = toggleTranscriptRow(processId, message.id)"
    >
      <span class="shrink-0 font-[440] text-foreground"><ShimmerText v-if="thinking" text="Thinking" /><template v-else>Thought</template></span>
      <span v-if="duration" class="shrink-0 text-muted-foreground">{{ duration }}</span>
      <ChevronRight class="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-[transform,opacity] duration-150 group-hover/thought:opacity-100 group-focus-visible/thought:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100" :class="open ? 'rotate-90 opacity-100' : ''" aria-hidden="true" />
    </button>
    <div v-if="open" :id="`thinking-${message.id}`" class="mb-1 mt-0.5 break-words pl-3 text-xs italic text-muted-foreground [&>p]:m-0" v-html="renderPlainMarkdown(message.text)" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ChevronRight } from 'lucide-vue-next';
import ShimmerText from './ShimmerText.vue';
import { renderPlainMarkdown } from '../lib/markdown';
import { elapsedLabel, toggleTranscriptRow, transcriptRowOpen, type TranscriptMessage } from '../lib/integratedConversation';

const props = withDefaults(defineProps<{ message: TranscriptMessage; processId: string; durationMs?: number | undefined; thinking?: boolean; active?: boolean }>(), { durationMs: undefined, thinking: false, active: false });

const open = ref(props.active || transcriptRowOpen(props.processId, props.message.id));
watch(() => props.active, (active) => { if (active) open.value = true; });
// Sub-second thoughts show no duration rather than "0s".
const duration = computed(() => !props.thinking && props.durationMs !== undefined && props.durationMs >= 1_000 ? elapsedLabel(props.durationMs) : '');
</script>
