<template>
  <!-- Every layer stays mounted; a phase only changes their targets, so moving
       between phases cross-fades instead of swapping animations. -->
  <div ref="root" class="orb" :class="`orb--${phase}`" role="img" :aria-label="label">
    <span class="orb__halo" />
    <span class="orb__listen" />
    <span class="orb__dash" />
    <span class="orb__arc" />
    <span class="orb__core" />
    <Transition name="orb-badge" mode="out-in">
      <span :key="phase" class="orb__badge" aria-hidden="true">
        <component :is="badge" class="size-3.5" />
      </span>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { AudioLines, CircleAlert, Ear, LoaderCircle, MicOff, PhoneOff, Plug } from 'lucide-vue-next';
import type { VoicePhase } from '../../lib/assistantVoicePhase';

const props = defineProps<{ phase: VoicePhase; label: string }>();
const root = ref<HTMLElement | null>(null);

const BADGES = { connecting: Plug, listening: Ear, speaking: AudioLines, working: LoaderCircle, muted: MicOff, ended: PhoneOff, failed: CircleAlert } as const;
const badge = computed(() => BADGES[props.phase]);

// Loudness arrives every frame. Easing it here keeps the orb fluid without
// putting per-frame values through reactive state.
let output = 0;
let input = 0;
function setLevels(nextOutput: number, nextInput: number): void {
  output += (nextOutput - output) * (nextOutput > output ? 0.45 : 0.12);
  input += (nextInput - input) * (nextInput > input ? 0.35 : 0.1);
  root.value?.style.setProperty('--out', output.toFixed(3));
  root.value?.style.setProperty('--in', input.toFixed(3));
}

defineExpose({ setLevels });
</script>

<style scoped>
/* Registered so phase changes interpolate instead of jumping. */
@property --tint { syntax: '<color>'; inherits: true; initial-value: rgb(250 250 250); }
@property --core { syntax: '<number>'; inherits: true; initial-value: 0.86; }
@property --glow { syntax: '<number>'; inherits: true; initial-value: 0.25; }
@property --listen { syntax: '<number>'; inherits: true; initial-value: 0; }
@property --dash { syntax: '<number>'; inherits: true; initial-value: 0; }
@property --arc { syntax: '<number>'; inherits: true; initial-value: 0; }
@property --dim { syntax: '<number>'; inherits: true; initial-value: 1; }

.orb {
  --out: 0;
  --in: 0;
  position: relative;
  width: 8.5rem;
  height: 8.5rem;
  transition: --tint 700ms ease, --core 600ms ease, --glow 600ms ease, --listen 500ms ease, --dash 500ms ease, --arc 500ms ease, --dim 600ms ease;
}

/* Phase targets. Tints stay soft so the orb reads as a state, not an alert. */
.orb--connecting { --tint: rgb(161 161 170); --core: 0.72; --glow: 0.1; --dash: 1; --dim: 0.55; }
.orb--listening { --tint: rgb(186 230 253); --core: 0.82; --glow: 0.22; --listen: 1; }
.orb--speaking { --tint: rgb(250 250 250); --core: 0.88; --glow: 0.5; }
.orb--working { --tint: rgb(238 224 178); --core: 0.74; --glow: 0.3; --arc: 1; --dim: 0.85; }
.orb--muted { --tint: rgb(113 113 122); --core: 0.7; --glow: 0.05; --dim: 0.45; }
.orb--ended { --tint: rgb(82 82 91); --core: 0.66; --glow: 0; --dim: 0.35; }
.orb--failed { --tint: rgb(252 165 165); --core: 0.66; --glow: 0.12; --dim: 0.5; }

.orb > span:not(.orb__badge) {
  position: absolute;
  inset: 0;
  border-radius: 9999px;
  pointer-events: none;
}

.orb__halo {
  background: radial-gradient(circle, color-mix(in srgb, var(--tint) 55%, transparent) 0%, transparent 68%);
  filter: blur(14px);
  opacity: calc(var(--glow) + var(--out) * 0.8);
  transform: scale(calc(1.05 + var(--out) * 0.35));
}

/* Listening: a ring that answers the user's own voice. */
.orb__listen {
  border: 1.5px solid color-mix(in srgb, var(--tint) 70%, transparent);
  opacity: calc(var(--listen) * (0.25 + var(--in) * 1.2));
  transform: scale(calc(1 + var(--in) * 0.28));
}

/* Connecting: a slow dashed ring. */
.orb__dash {
  border: 1.5px dashed color-mix(in srgb, var(--tint) 60%, transparent);
  opacity: calc(var(--dash) * 0.8);
  animation: orb-spin 6s linear infinite;
}

/* Working: an arc that circles the core. */
.orb__arc {
  background: conic-gradient(from 0deg, transparent 0deg, color-mix(in srgb, var(--tint) 85%, transparent) 70deg, transparent 140deg);
  mask: radial-gradient(circle, transparent 63%, black 64.5%, black 67%, transparent 68.5%);
  opacity: var(--arc);
  animation: orb-spin 1.6s linear infinite;
}

.orb__core {
  inset: 14% !important;
  background: radial-gradient(circle at 35% 30%,
    rgb(255 255 255 / calc(0.95 * var(--dim))),
    color-mix(in srgb, var(--tint) calc(80% * var(--dim)), transparent) 42%,
    color-mix(in srgb, var(--tint) 22%, transparent) 72%,
    transparent 100%);
  transform: scale(calc(var(--core) + var(--out) * 0.22));
  animation: orb-breathe 3.2s ease-in-out infinite;
}

.orb__badge {
  position: absolute;
  right: 6%;
  bottom: 6%;
  display: flex;
  width: 1.75rem;
  height: 1.75rem;
  align-items: center;
  justify-content: center;
  border-radius: 9999px;
  border: 1px solid hsl(var(--border));
  background: hsl(var(--background));
  color: color-mix(in srgb, var(--tint) 85%, hsl(var(--muted-foreground)));
}
.orb--working .orb__badge :deep(svg) { animation: orb-spin 1.2s linear infinite; }

.orb-badge-enter-active, .orb-badge-leave-active { transition: opacity 180ms ease, transform 180ms ease; }
.orb-badge-enter-from, .orb-badge-leave-to { opacity: 0; transform: scale(0.7); }

@keyframes orb-spin { to { transform: rotate(360deg); } }
/* Breathing is relative to the phase's size, so it never fights the level. */
@keyframes orb-breathe {
  0%, 100% { translate: 0 0; filter: brightness(1); }
  50% { translate: 0 -1px; filter: brightness(1.06); }
}

@media (prefers-reduced-motion: reduce) {
  .orb__dash, .orb__arc, .orb__core, .orb--working .orb__badge :deep(svg) { animation: none; }
}
</style>
