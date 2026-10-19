<template>
  <NodeViewWrapper as="span" contenteditable="false"><MentionChip :label="node.attrs.name" :host="node.attrs.host ?? undefined" :harness="node.attrs.harness" :agent="node.attrs.kind !== 'process'" :launch="node.attrs.kind === 'preset' || node.attrs.kind === 'harness'" /></NodeViewWrapper>
</template>

<script setup lang="ts">
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3';
import MentionChip from './MentionChip.vue';

// A mention chip in the composer, drawn the way sent messages show it.
defineProps(nodeViewProps);
</script>
