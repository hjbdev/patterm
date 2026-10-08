<template>
  <!-- Workspace runs have no project tab, so their conversation opens here. -->
  <Dialog :open="Boolean(processId)" @update:open="(open) => { if (!open) emit('close') }">
    <DialogContent class="flex h-[min(85dvh,52rem)] max-w-3xl flex-col gap-0 overflow-hidden border-white/[0.06] bg-background p-0">
      <DialogTitle class="px-5 pb-2 pr-12 pt-4 text-sm font-semibold">{{ title }}</DialogTitle>
      <DialogDescription class="sr-only">The conversation of this routine run.</DialogDescription>
      <div class="min-h-0 flex-1">
        <IntegratedConversation v-if="processId" :key="processId" :process-id="processId" embedded class="h-full" />
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { defineAsyncComponent } from 'vue';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog';

defineProps<{ processId: string | null; title: string }>();
const emit = defineEmits<{ close: [] }>();

const IntegratedConversation = defineAsyncComponent(() => import('../IntegratedConversation.vue'));
</script>
