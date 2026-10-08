<template>
  <Loader2 v-if="status === 'running'" class="h-3.5 w-3.5 shrink-0 animate-spin text-primary motion-reduce:animate-none" aria-hidden="true" />
  <X v-else-if="status === 'failed'" class="h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden="true" />
  <Check v-else-if="status === 'completed'" class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
  <Pause v-else-if="status === 'paused'" class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
  <Square v-else-if="status === 'stopped'" class="h-3 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
  <Circle v-else class="h-2.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
</template>

<script setup lang="ts">
import { Check, Circle, Loader2, Pause, Square, X } from 'lucide-vue-next';
import type { IntegratedTask } from '../lib/integratedConversation';

defineProps<{ status: IntegratedTask['status'] }>();
</script>
