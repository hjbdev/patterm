<template>
  <span
    v-if="icon"
    :class="cn('inline-block shrink-0 bg-current', props.class)"
    :style="maskStyle"
    :aria-label="label"
    role="img"
  />
  <Bot v-else :class="cn('shrink-0 text-muted-foreground', props.class)" aria-hidden="true" />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Bot } from 'lucide-vue-next';
import { cn } from '@/lib/utils';
import { harnessIcon, harnessLabel } from '../lib/harnesses';

const props = withDefaults(
  defineProps<{
    harness?: string | null | undefined;
    class?: string | undefined;
  }>(),
  {
    harness: null,
    class: ''
  }
);

const icon = computed(() => harnessIcon(props.harness));
const label = computed(() => props.harness ? harnessLabel(props.harness) : 'Agent');
const maskStyle = computed(() => icon.value
  ? {
      WebkitMask: `url("${icon.value}") center / contain no-repeat`,
      mask: `url("${icon.value}") center / contain no-repeat`
    }
  : undefined);
</script>
