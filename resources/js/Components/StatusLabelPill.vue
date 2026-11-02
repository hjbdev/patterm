<template>
  <!-- A status label pinned on an agent: a pill washed with its colour, or a
       dot where a row has no room for the name. -->
  <span
    v-if="dot"
    class="inline-block h-2 w-2 shrink-0 rounded-full"
    :style="{ backgroundColor: statusLabelDot(label.color) }"
    :title="title"
    role="img"
    :aria-label="title"
  />
  <span
    v-else
    class="inline-flex h-4 min-w-0 max-w-40 shrink items-center gap-1 rounded-full border px-1.5 text-[11px] font-medium leading-none"
    :style="statusLabelStyle(label.color)"
    :title="title"
  >
    <span class="h-1.5 w-1.5 shrink-0 rounded-full" :style="{ backgroundColor: statusLabelDot(label.color) }" aria-hidden="true" />
    <span class="truncate">{{ label.name }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { statusLabelDot, statusLabelStyle, type StatusLabelColor } from '../lib/statusLabels';

const props = defineProps<{ label: { name: string; color: StatusLabelColor; setBy?: 'agent' | 'user' }; dot?: boolean }>();

const title = computed(() => props.label.setBy === 'user' ? `${props.label.name} (set by you)` : props.label.name);
</script>
