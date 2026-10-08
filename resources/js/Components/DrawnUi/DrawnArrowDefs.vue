<template>
  <defs>
    <marker :id="`${id}-arrow`" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="var(--drawn-text)" fill-opacity="0.8" />
    </marker>
    <marker :id="`${id}-hot`" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="var(--drawn-accent)" />
    </marker>
  </defs>
</template>

<script setup lang="ts">
defineProps<{ id: string }>();
</script>
