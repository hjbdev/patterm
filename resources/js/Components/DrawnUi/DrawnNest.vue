<template>
  <div class="rounded-lg border px-3 pb-3 pt-2" :class="item.node.highlight ? 'border-[var(--drawn-accent)] bg-[var(--drawn-accent-wash)]' : 'border-border'" :title="item.node.note">
    <p class="text-xs font-medium">{{ item.node.label }}<span v-if="item.node.sub" class="ml-1.5 font-normal text-muted-foreground">{{ item.node.sub }}</span></p>
    <div v-if="item.children.length" class="mt-2 space-y-2">
      <DrawnNest v-for="child in item.children" :key="child.node.id" :item="child" />
    </div>
  </div>
</template>

<script setup lang="ts">
import type { NestNode } from '../../lib/drawnUi';
import type { DrawnDiagram } from '../../../../app/Services/DrawnUi';

defineProps<{ item: NestNode<DrawnDiagram['nodes'][number]> }>();
</script>
