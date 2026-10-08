<template>
  <div :class="cn('flex h-full min-h-0 flex-col items-center justify-center gap-2 p-4 text-center', props.class)">
    <div class="flex h-9 w-9 items-center justify-center rounded-lg border border-border/70 bg-secondary/30 text-muted-foreground">
      <slot name="icon">
        <Inbox class="h-5 w-5" />
      </slot>
    </div>
    <div class="space-y-1">
      <p class="text-sm font-medium text-foreground">{{ title }}</p>
      <p v-if="description || $slots.description" class="max-w-xs text-sm text-muted-foreground">
        <slot name="description">{{ description }}</slot>
      </p>
    </div>
    <div v-if="$slots.action">
      <slot name="action" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { Inbox } from 'lucide-vue-next';
import { cn } from '@/lib/utils';

const props = withDefaults(
  defineProps<{
    title?: string;
    description?: string;
    class?: string;
  }>(),
  {
    title: 'Nothing here yet',
    description: '',
    class: ''
  }
);
</script>
