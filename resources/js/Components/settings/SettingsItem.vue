<template>
  <div class="px-3.5 py-3">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <div v-if="$slots.icon" class="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground"><slot name="icon" /></div>
      <div class="min-w-0 flex-1" :class="muted ? 'text-muted-foreground' : ''">
        <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-medium"><slot name="title" /></div>
        <div v-if="$slots.meta" class="mt-0.5 truncate text-xs text-muted-foreground"><slot name="meta" /></div>
      </div>
      <!-- Actions sit on their own line until the list is wide enough. -->
      <div v-if="$slots.actions" class="order-last flex w-full shrink-0 items-center gap-0.5 [@container(min-width:30rem)]:order-none [@container(min-width:30rem)]:ml-0 [@container(min-width:30rem)]:w-auto [@container(min-width:30rem)]:pl-0" :class="$slots.icon ? 'pl-5' : '-ml-2'"><slot name="actions" /></div>
      <div v-if="$slots.control" class="flex shrink-0 items-center"><slot name="control" /></div>
    </div>
    <p v-if="error" role="alert" class="mt-2 text-xs text-destructive" :class="$slots.icon ? 'pl-7' : ''">{{ error }}</p>
    <div v-if="$slots.default" class="mt-3" :class="$slots.icon ? 'pl-7' : ''"><slot /></div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { settingSaveStatus } from '../../Composables/useSettingsAutosave';

const props = defineProps<{ muted?: boolean; saveKey?: string }>();

const error = computed(() => {
  const saved = props.saveKey ? settingSaveStatus(props.saveKey) : null;
  return saved?.state === 'error' ? saved.error : '';
});
</script>
