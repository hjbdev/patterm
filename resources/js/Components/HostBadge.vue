<template>
  <span class="inline-flex shrink-0 items-center text-[11.5px] font-normal text-muted-foreground/80" :title="`On ${host}`">
    {{ host }}
  </span>
</template>

<script setup lang="ts">
// Quietly names the paired host a record belongs to when hosts are mixed.
defineProps<{ host: string }>();
</script>
