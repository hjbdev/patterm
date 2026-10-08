<template>
  <span class="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-normal text-muted-foreground" :title="`On ${host}, a paired host`">
    <Link2 class="h-3 w-3" aria-hidden="true" />{{ host }}
  </span>
</template>

<script setup lang="ts">
import { Link2 } from 'lucide-vue-next';

// Marks a record that belongs to a paired host.
defineProps<{ host: string }>();
</script>
