<template>
  <section class="flex flex-col rounded-xl border border-border bg-background p-4 text-sm shadow-sm" aria-label="Close request">
    <p class="font-medium text-foreground">Ready to close</p>
    <p v-if="request.summary" class="mt-0.5 max-h-40 overflow-y-auto overscroll-contain whitespace-pre-wrap break-words text-xs text-muted-foreground">{{ request.summary }}</p>
    <input
      v-model="feedback"
      class="-mx-2 mt-2 block w-[calc(100%+1rem)] rounded-lg bg-transparent px-2 py-1.5 text-xs transition-colors placeholder:text-muted-foreground hover:bg-muted/40 focus:bg-muted/40 focus:outline-none"
      placeholder="Tell the agent why it should stay open (optional)"
      aria-label="Reason to keep the agent open"
      :disabled="busy"
      @keydown.enter.prevent="answer('keep_open')"
    >
    <div class="mt-3 flex flex-wrap items-center justify-end gap-2">
      <p v-if="subagents" class="mr-auto text-xs text-muted-foreground">Also closes {{ subagents === 1 ? '1 running subagent' : `${subagents} running subagents` }}.</p>
      <Button size="sm" class="h-7 px-2.5" variant="ghost" :disabled="busy" @click="answer('keep_open')">Keep open</Button>
      <Button size="sm" class="h-7 px-2.5" :disabled="busy" @click="answer('close')">Close</Button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { toast } from 'vue-sonner';
import { Button } from './ui/button';
import type { CloseRequestRecord } from '../types';

const props = defineProps<{ processId: string; request: CloseRequestRecord; subagents?: number | undefined }>();
const feedback = ref('');
const busy = ref(false);

// The workbench drops the request once it is answered, which unmounts the card.
async function answer(decision: 'close' | 'keep_open'): Promise<void> {
  busy.value = true;
  const reason = feedback.value.trim();
  try {
    await window.patterm.call('close_request_answer', { process_id: props.processId, decision, ...(decision === 'keep_open' && reason ? { feedback: reason } : {}) });
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : 'Could not answer the close request');
  } finally {
    busy.value = false;
  }
}
</script>
