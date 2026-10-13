<template>
  <ProcessMention v-if="part.processId" :process-id="part.processId" />
  <MentionChip v-else-if="part.launch" :label="part.launch.name" :harness="part.launch.harness" launch :title="part.text" />
  <FigureRef v-else-if="part.figure" :figure-id="part.figure" :text="part.text" />
  <template v-else>{{ part.text }}</template>
</template>

<script setup lang="ts">
import type { MentionPart } from '../lib/agentMentions';
import MentionChip from './MentionChip.vue';
import ProcessMention from './ProcessMention.vue';
import { defineAsyncComponent } from 'vue';

// Pages load their frame code only when one is shown.
const FigureRef = defineAsyncComponent(() => import('./FigureRef.vue'));

// A run of message text: a process ID or launch token as a chip, a figure
// token as its page, otherwise plain text.
defineProps<{ part: MentionPart }>();
</script>
