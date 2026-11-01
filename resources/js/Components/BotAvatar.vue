<template>
  <!-- A bot's face, emoji, picture or Patterm's mark, carrying the status a row's ring shows
       for other agents: a comet circling it while the bot works (faint while
       only its hidden helpers work), the `?`, `✕` or `✓` mark when it needs
       you, has an error or asked to close, and dimmed once it has exited. -->
  <span :class="cn('bot-avatar', props.class)" :data-dead="dead ? '' : undefined" :style="{ width: `${px}px`, height: `${px}px` }" :title="description ?? undefined">
    <span v-if="moving" class="bot-avatar-ring" :data-faint="faint ? '' : undefined" :style="{ animationDelay: `${syncDelay()}ms` }" aria-hidden="true" />
    <span class="bot-avatar-body" :style="{ width: `${px}px`, height: `${px}px` }">
      <slot>
        <span v-if="avatar?.kind === 'mark'" class="flex size-full items-center justify-center rounded-full bg-muted text-foreground/80"><Sparkles class="size-[55%]" aria-hidden="true" /></span>
        <img v-else-if="avatar?.kind === 'picture' && avatar.picture" :src="avatar.picture" alt="" class="size-full rounded-full object-cover" />
        <span v-else-if="avatar?.kind === 'emoji' && avatar.emoji" class="bot-avatar-emoji" :style="{ fontSize: `${Math.round(px * 0.84)}px` }" aria-hidden="true">{{ avatar.emoji }}</span>
        <ProfileFace v-else-if="avatar" :look="avatar.look" :size="px" :motion="animate" />
      </slot>
    </span>
    <span v-if="mark" class="bot-avatar-badge"><StatusIcon :spec="mark" class="h-full w-full" aria-hidden="true" /></span>
    <span v-if="description" class="sr-only">{{ description }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Sparkles } from 'lucide-vue-next';
import { cn } from '@/lib/utils';
import type { BotAvatar } from '../../../app/Bots/BotAvatar';
import { describeActivity, type RowActivity } from '../lib/rowActivity';
import { activityIcon, CLOSING_MARK } from '../lib/statusIcons';
import ProfileFace from './ProfileFace.vue';
import StatusIcon from './StatusIcon.vue';

const props = withDefaults(defineProps<{ avatar?: BotAvatar; size?: number; activity?: RowActivity | null; motion?: boolean; class?: string }>(), { size: 20, activity: null, motion: false, class: '' });

const px = computed(() => props.size ?? 20);
const animate = computed(() => props.motion ?? false);
const self = computed(() => props.activity?.self ?? 'idle');
const helpersWorking = computed(() => (props.activity?.subagents.working ?? 0) > 0);
const moving = computed(() => self.value === 'working' || ((self.value === 'idle' || self.value === 'unknown') && helpersWorking.value));
const faint = computed(() => self.value !== 'working');
const dead = computed(() => self.value === 'dead');
const mark = computed(() => {
  if (self.value === 'closing') return CLOSING_MARK;
  return self.value === 'permission' || self.value === 'question' || self.value === 'error' ? activityIcon(self.value) : null;
});
const description = computed(() => props.activity ? describeActivity(props.activity) : null);

// Every loader on the page turns in step.
function syncDelay(): number {
  return -(performance.now() % 1100);
}
</script>

<style scoped>
.bot-avatar { position: relative; display: inline-flex; flex: none; align-items: center; justify-content: center; }
.bot-avatar-body { position: relative; display: flex; align-items: center; justify-content: center; transition: opacity 0.2s; }
.bot-avatar[data-dead] .bot-avatar-body { opacity: 0.42; }
.bot-avatar-emoji { line-height: 1; font-family: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif; }
.bot-avatar-ring {
  position: absolute;
  inset: -3px;
  border-radius: 9999px;
  background: conic-gradient(from 0deg, rgb(244 244 245 / 0) 0 70deg, rgb(244 244 245 / 0.92) 357deg, rgb(244 244 245 / 0) 360deg);
  mask: radial-gradient(farthest-side, transparent calc(100% - 1.5px), #000 calc(100% - 1.2px));
  animation: bot-avatar-spin 1.1s linear infinite;
}
.bot-avatar-ring[data-faint] { opacity: 0.45; }
.bot-avatar-badge {
  position: absolute;
  right: -3px;
  bottom: -3px;
  width: max(10px, 45%);
  height: max(10px, 45%);
  border-radius: 9999px;
  background: hsl(var(--background));
}
@keyframes bot-avatar-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .bot-avatar-ring { animation: none; } }
</style>
