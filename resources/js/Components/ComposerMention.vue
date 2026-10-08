<template>
  <NodeViewWrapper as="span" contenteditable="false"><MentionChip :label="node.attrs.name" :harness="node.attrs.harness" :launch="node.attrs.kind !== 'agent'" /></NodeViewWrapper>
</template>

<script setup lang="ts">
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3';
import MentionChip from './MentionChip.vue';

// A mention chip in the composer, drawn the way sent messages show it.
defineProps(nodeViewProps);
</script>
