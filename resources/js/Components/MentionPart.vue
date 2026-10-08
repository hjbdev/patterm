<template>
  <ProcessMention v-if="part.processId" :process-id="part.processId" />
  <MentionChip v-else-if="part.launch" :label="part.launch.name" :harness="part.launch.harness" launch :title="part.text" />
  <template v-else>{{ part.text }}</template>
</template>

<script setup lang="ts">
import type { MentionPart } from '../lib/agentMentions';
import MentionChip from './MentionChip.vue';
import ProcessMention from './ProcessMention.vue';

// A run of message text: a process ID or launch token as a chip, otherwise
// plain text.
defineProps<{ part: MentionPart }>();
</script>
