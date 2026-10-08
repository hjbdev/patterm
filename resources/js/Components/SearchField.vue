<template>
  <div class="relative">
    <Search class="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
    <input v-model="query" type="search" :placeholder="placeholder" :aria-label="label" class="h-full min-h-8 w-full rounded-md bg-transparent pl-7 pr-2 text-sm outline-none transition-colors placeholder:text-muted-foreground hover:bg-muted/30 focus:bg-muted/40" />
  </div>
</template>

<script setup lang="ts">
import { Search } from 'lucide-vue-next';

// A borderless search box for list pages.
defineProps<{ label: string; placeholder: string }>();
const query = defineModel<string>({ required: true });
</script>
