<template>
  <span
    v-if="urgency"
    class="h-1.5 w-1.5 shrink-0 rounded-full"
    :class="urgency === 'high' ? 'bg-amber-400' : urgency === 'normal' ? 'bg-primary' : 'bg-muted-foreground/70'"
    role="status"
    :aria-label="urgency === 'high' ? 'Needs your attention' : 'Unread notification'"
  />
</template>

<script setup lang="ts">
import type { NotificationUrgency } from '../Composables/useNotifications';
defineProps<{ urgency: NotificationUrgency | null }>();
</script>
