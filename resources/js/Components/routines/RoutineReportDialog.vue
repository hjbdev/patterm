<template>
  <!-- What a run reported, kept after its agent stops. -->
  <Dialog :open="Boolean(run)" @update:open="(open) => { if (!open) emit('close') }">
    <DialogScrollContent class="max-w-2xl grid-cols-[minmax(0,1fr)] gap-0 border-white/[0.06] bg-background p-0">
      <template v-if="run">
        <header class="px-5 pb-3 pr-12 pt-4">
          <DialogTitle class="text-sm font-semibold">{{ title }}</DialogTitle>
          <DialogDescription class="mt-0.5 text-xs text-muted-foreground">
            <span :class="runNeedsAttention(run) ? 'text-foreground' : ''">{{ runStatusLabel(run) }}</span> · {{ formatRunWhen(runTime(run), now) }}
          </DialogDescription>
        </header>
        <div class="px-5 pb-5">
          <Markdown v-if="text" :source="text">
            <template #mention="{ part }"><MentionPart :part="part" /></template>
          </Markdown>
          <p v-else class="text-sm text-muted-foreground">{{ run.status === 'running' ? 'The agent has not reported yet.' : 'This run has no report.' }}</p>
        </div>
        <footer v-if="run.live" class="flex items-center justify-end gap-3 border-t border-white/[0.06] px-5 py-3">
          <p class="min-w-0 flex-1 text-xs text-muted-foreground">The agent is still running, so you can reply.</p>
          <Button variant="outline" size="sm" class="h-8 text-xs" @click="emit('openConversation', run)">Open conversation</Button>
        </footer>
      </template>
    </DialogScrollContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import Markdown from '../Markdown.vue';
import MentionPart from '../MentionPart.vue';
import { Button } from '../ui/button';
import { Dialog, DialogDescription, DialogScrollContent, DialogTitle } from '../ui/dialog';
import { formatRunWhen, runNeedsAttention, runStatusLabel, runTime, type RoutineRunRecord } from '../../lib/routines';

const props = defineProps<{ run: RoutineRunRecord | null; title: string; now: number }>();
const emit = defineEmits<{ close: []; openConversation: [run: RoutineRunRecord] }>();

// Runs from before full reports were kept only have their excerpt.
const text = computed(() => props.run?.report ?? props.run?.excerpt ?? '');
</script>
