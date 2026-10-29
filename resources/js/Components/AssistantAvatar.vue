<template>
  <!-- The assistant has no avatar of its own, so it lists with the bots under its mark. -->
  <BotAvatar :size="props.size ?? 22" :activity="props.activity ?? null">
    <span class="flex size-full items-center justify-center rounded-full bg-muted text-foreground/80"><Sparkles class="size-[55%]" aria-hidden="true" /></span>
  </BotAvatar>
</template>

<script setup lang="ts">
import { Sparkles } from 'lucide-vue-next';
import type { RowActivity } from '../lib/rowActivity';
import BotAvatar from './BotAvatar.vue';

const props = withDefaults(defineProps<{ size?: number; activity?: RowActivity | null }>(), { size: 22, activity: null });
</script>
