<template>
  <!-- Lives in the page's bar rather than floating over the workspace, where
       it covered composers and terminal text. -->
  <Tooltip v-if="assistant.enabled">
    <TooltipTrigger as-child>
      <Button
        variant="ghost"
        size="icon"
        data-assistant-launcher
        class="relative h-7 w-7 rounded-tab"
        :class="open ? 'bg-accent text-foreground' : 'text-muted-foreground'"
        :aria-label="label"
        :aria-expanded="open"
        @click="setAssistantLayout({ open: !open })"
      >
        <Sparkles class="h-4 w-4" />
        <span v-if="assistant.voiceActive" class="absolute right-1 top-1 h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" aria-hidden="true" />
        <span v-else-if="assistant.focus && !open" class="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-muted-foreground" aria-hidden="true" />
      </Button>
    </TooltipTrigger>
    <TooltipContent>{{ label }}</TooltipContent>
  </Tooltip>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Sparkles } from 'lucide-vue-next';
import { Button } from '../ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { assistant } from '../../lib/assistant';
import { assistantLayout, setAssistantLayout } from '../../lib/assistantLayout';

const open = computed(() => assistantLayout.open);
const label = computed(() => {
  if (open.value) return 'Hide assistant';
  if (assistant.voiceActive) return 'Assistant · Voice call';
  if (assistant.focus) return `Assistant · Focus${assistant.focusPending ? `, ${assistant.focusPending} held` : ''}`;
  return 'Assistant';
});
</script>
