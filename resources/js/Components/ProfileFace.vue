<template>
  <span :class="cn('profile-face', motion && look.idle !== 'still' && `profile-face-${look.idle}`, props.class)" :style="{ width: `${size}px`, height: `${size}px`, '--profile-face-size': `${size}px` }" aria-hidden="true">
    <!-- The markup is built from the look's enum parts only, never from text.
         Inline sizes win over lists that size every svg inside a row. -->
    <svg viewBox="0 0 24 24" :width="size" :height="size" :style="{ width: `${size}px`, height: `${size}px`, filter: markup.filter ?? undefined }" v-html="markup.body" />
  </span>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue';
import { cn } from '@/lib/utils';
import { faceMarkup, type ProfileLook } from '../lib/faces';

// `motion` plays the look's idle animation; lists turn it on only for the
// highlighted row, so a long list stays calm.
const props = withDefaults(defineProps<{ look: ProfileLook; size?: number; motion?: boolean; class?: string }>(), { size: 20, motion: false, class: '' });
const id = `face-${useId()}`;
const markup = computed(() => faceMarkup(props.look, props.size, id));
</script>

<style>
.profile-face { position: relative; display: inline-flex; flex: none; align-items: center; justify-content: center; }
.profile-face svg { display: block; overflow: visible; }
.profile-face-eyes { transform-box: fill-box; transform-origin: center; }
.profile-face-blink .profile-face-eyes { animation: profile-face-blink 6.5s infinite; }
.profile-face-glance .profile-face-eyes { animation: profile-face-glance 7s infinite; }
.profile-face-bob svg { animation: profile-face-bob 2.8s ease-in-out infinite; }
@keyframes profile-face-blink { 0%, 95%, 100% { transform: scaleY(1); } 97% { transform: scaleY(.12); } }
@keyframes profile-face-glance { 0%, 36%, 100% { transform: translateX(0); } 42%, 56% { transform: translateX(-1.1px); } 62%, 78% { transform: translateX(1.1px); } 84% { transform: translateX(0); } }
@keyframes profile-face-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(calc(var(--profile-face-size) * -.06)); } }
@media (prefers-reduced-motion: reduce) {
  .profile-face-eyes, .profile-face svg { animation: none !important; }
}
</style>
