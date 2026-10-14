<template>
  <div class="flex items-center">
    <Button variant="ghost" size="icon" class="h-7 w-7 text-muted-foreground hover:text-foreground" aria-label="Regenerate summary" title="Regenerate summary" :disabled="busy" @click="inspect"><RefreshCw class="h-3.5 w-3.5" /></Button>
    <Dialog v-model:open="open">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Regenerate summary</DialogTitle>
          <DialogDescription>Create a fresh summary from the conversation history saved in Patterm. Tool output and reasoning are skipped; older imported messages may be shortened.</DialogDescription>
        </DialogHeader>
        <p v-if="busy && !details" class="text-sm text-muted-foreground">Loading summary details…</p>
        <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
        <div v-if="details" class="space-y-2 text-sm text-muted-foreground">
          <p>{{ details.processedMessages }} of {{ details.totalMessages }} messages read.</p>
          <p>Regenerating uses about {{ details.estimatedCalls }} model calls, depending on message length.</p>
          <p v-if="!details.enabled">Turn on automatic summaries in Settings to regenerate this summary.</p>
          <p v-if="details.coverage === 'stale'">Earlier messages have changed. Regenerate to bring the summary up to date.</p>
          <p v-else-if="details.paused">Regeneration is paused. Resume to continue where it left off.</p>
          <p v-else-if="details.rebuilding">Reading the conversation from the beginning. Your current summary stays visible until the new one is ready.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" :disabled="busy" @click="open = false">Close</Button>
          <Button v-if="details?.rebuilding && !details?.paused" variant="outline" :disabled="busy" @click="control('cancel')">Pause</Button>
          <Button v-if="details?.paused" :disabled="busy || !details?.enabled" @click="control('resume')">Resume</Button>
          <Button :disabled="busy || !canRebuild" @click="control('rebuild')">Regenerate</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue';
import { RefreshCw } from 'lucide-vue-next';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog';
import { contextCall } from '../lib/projectContext';
const props = defineProps<{ projectId: string; sessionId: string }>();
const open = ref(false), busy = ref(false), error = ref('');
const details = ref<{ coverage: string; processedMessages: number; totalMessages: number; estimatedCalls: number;
  rebuilding: boolean; paused: boolean; enabled: boolean } | null>(null);
const canRebuild = computed(() => Boolean(details.value?.enabled && details.value.totalMessages &&
  (!details.value.rebuilding || details.value.coverage === 'stale')));
async function control(operation: 'inspect' | 'rebuild' | 'cancel' | 'resume') {
  busy.value = true; error.value = '';
  try { details.value = await contextCall('auto_summary_control', props.projectId, { session_id: props.sessionId, operation }); }
  catch (caught) { error.value = caught instanceof Error ? caught.message : 'Could not update the summary. Please try again.'; }
  finally { busy.value = false; }
}
async function inspect() { open.value = true; details.value = null; await control('inspect'); }
</script>
