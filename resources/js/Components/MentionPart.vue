<template>
  <ProcessMention v-if="part.processId" :process-id="part.processId" />
  <MentionChip v-else-if="part.launch" :label="part.launch.name" :harness="part.launch.harness" launch :title="part.text" />
  <DrawnUiRef v-else-if="part.figure" :figure-id="part.figure" :text="part.text" />
  <template v-else>{{ part.text }}</template>
</template>

<script setup lang="ts">
import type { MentionPart } from '../lib/agentMentions';
import MentionChip from './MentionChip.vue';
import ProcessMention from './ProcessMention.vue';
import { defineAsyncComponent } from 'vue';

// Figures load the chart engine only when one is shown.
const DrawnUiRef = defineAsyncComponent(() => import('./DrawnUi/DrawnUiRef.vue'));

// A run of message text: a process ID or launch token as a chip, a figure
// token as its figure, otherwise plain text.
defineProps<{ part: MentionPart }>();
</script>
