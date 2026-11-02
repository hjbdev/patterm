<template>
  <!-- Marks an agent a bot started: the bot's face in a pill washed with its colour. -->
  <span class="inline-flex h-4 shrink-0 items-center rounded-full border px-1" :style="wash" :title="`Started by ${bot.name}`">
    <BotAvatar :avatar="bot.avatar" :size="12" />
    <span class="sr-only">Started by {{ bot.name }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Bot } from '../lib/bots';
import { faceWash } from '../lib/faces';
import BotAvatar from './BotAvatar.vue';

const props = defineProps<{ bot: Bot }>();

// Only a face has a colour scheme; other avatars sit in a neutral pill.
const wash = computed(() => {
  const { background, border } = faceWash(props.bot.avatar.kind === 'face' ? props.bot.avatar.look.color : 'graphite');
  return { backgroundColor: background, borderColor: border };
});
</script>
