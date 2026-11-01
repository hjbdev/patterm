<template>
  <!-- The assistant's avatar from Settings › Bots, or Patterm's mark until it loads. -->
  <BotAvatar :avatar="props.avatar ?? MARK" :size="props.size ?? 22" :activity="props.activity ?? null" />
</template>

<script setup lang="ts">
import type { BotAvatar as Avatar } from '../../../app/Bots/BotAvatar';
import type { RowActivity } from '../lib/rowActivity';
import BotAvatar from './BotAvatar.vue';

const props = withDefaults(defineProps<{ avatar?: Avatar | null; size?: number; activity?: RowActivity | null }>(), { avatar: null, size: 22, activity: null });

const MARK: Avatar = { kind: 'mark', look: { color: 'graphite', shape: 'circle', finish: 'soft', marking: 'none', eyes: 'sparkle', mouth: 'smile', cheeks: false, hat: 'none', accent: 'violet', idle: 'blink' }, emoji: null, picture: null };
</script>
