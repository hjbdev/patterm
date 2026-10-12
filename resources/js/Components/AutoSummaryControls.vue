<template>
  <div class="mt-2 text-[11px] text-muted-foreground">
    <p v-if="coverage && coverage !== 'complete'">{{ coverageLabel }}</p>
    <Button variant="ghost" size="sm" class="h-6 p-0 text-[11px] underline underline-offset-2" :disabled="busy" @click="inspect">Review summary coverage</Button>
    <p v-if="error" role="alert" class="text-destructive">{{ error }}</p>
    <Dialog v-model:open="open">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Conversation summary</DialogTitle>
          <DialogDescription>Rebuilding reads all retained conversation prose. Tools and reasoning are excluded, and older imported text may be truncated.</DialogDescription>
        </DialogHeader>
        <div v-if="details" class="space-y-2 text-sm text-muted-foreground">
          <p>{{ details.processedMessages }} of {{ details.totalMessages }} prose messages processed.</p>
          <p>A full rebuild needs roughly {{ details.estimatedCalls }} calls, depending on message size. {{ details.callsRemaining }} calls remain in this hour’s shared allowance.</p>
          <p v-if="!details.enabled">Enable auto-summaries in Settings to rebuild.</p>
          <p v-if="details.coverage === 'stale'">Earlier conversation text changed. Rebuild from beginning to refresh the recap.</p>
          <p v-else-if="details.rebuilding">Rebuilding in chronological batches. Your current recap stays visible until catch-up finishes.</p>
          <p v-if="error" role="alert" class="text-destructive">{{ error }}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" :disabled="busy" @click="open = false">Close</Button>
          <Button v-if="details?.rebuilding && !details?.paused" variant="outline" :disabled="busy" @click="control('cancel')">Pause rebuild</Button>
          <Button v-if="details?.paused" :disabled="busy || !details?.enabled" @click="control('resume')">Resume catch-up</Button>
          <Button :disabled="busy || !canRebuild" @click="control('rebuild')">Rebuild from beginning</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog';
import { contextCall } from '../lib/projectContext';
const props = defineProps<{ projectId: string; sessionId: string; coverage?: string | null | undefined }>();
const open = ref(false), busy = ref(false), error = ref('');
const details = ref<{ coverage: string; processedMessages: number; totalMessages: number; estimatedCalls: number;
  callsRemaining: number; rebuilding: boolean; paused: boolean; enabled: boolean } | null>(null);
const canRebuild = computed(() => Boolean(details.value?.enabled && details.value.totalMessages &&
  (!details.value.rebuilding || details.value.coverage === 'stale')));
const coverageLabel = computed(() => ({ partial: 'Partial history coverage', catching_up: 'Catching up with conversation history',
  stale: 'Earlier conversation text changed; rebuild needed', paused: 'History catch-up paused' }[props.coverage ?? ''] ?? ''));
async function control(operation: 'inspect' | 'rebuild' | 'cancel' | 'resume') {
  busy.value = true; error.value = '';
  try { details.value = await contextCall('auto_summary_control', props.projectId, { session_id: props.sessionId, operation }); }
  catch (caught) { error.value = caught instanceof Error ? caught.message : 'Could not read summary coverage.'; }
  finally { busy.value = false; }
}
async function inspect() { await control('inspect'); if (details.value) open.value = true; }
</script>
