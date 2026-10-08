<template>
  <!-- Pages pad their content, so the bar pins to the main area instead of its
       parent. Inline bars, such as the assistant panel's, pin to their parent. -->
  <Teleport to="#workbench-main" defer :disabled="inline === true">
    <Transition name="loading-bar">
      <div v-if="active" class="loading-bar" role="progressbar" :aria-label="label" aria-busy="true">
        <span class="loading-bar-comet" aria-hidden="true">
          <span class="loading-bar-glow" />
          <span class="loading-bar-line" />
          <span class="loading-bar-head" />
        </span>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ active: boolean; label?: string; inline?: boolean }>(), { label: 'Loading', inline: false });
</script>

<style scoped>
/*
 * A thin indeterminate comet pinned to the top of the workbench main area,
 * modelled on Helium's address bar progress bar: a dim tail that brightens
 * towards the head, a blurred glow in screen blend, and a bright head that
 * pulses. The bar clips the glow at its top edge, so it only spreads down into
 * the page. It waits briefly before it appears so fast loads do not flash it.
 * The sweep changes only transform and the pulse only opacity, which the
 * compositor runs without repainting.
 */
.loading-bar {
  --loading-bar-tail: linear-gradient(
    90deg,
    transparent,
    hsl(var(--primary) / 0.18) 45%,
    hsl(var(--primary) / 0.68) 82%,
    hsl(var(--primary)) 100%
  );
  position: absolute;
  inset: 0 0 auto;
  z-index: 20;
  height: 12px;
  overflow: hidden;
  pointer-events: none;
  animation: loading-bar-delay 360ms steps(1, end);
}

.loading-bar-comet {
  position: absolute;
  inset: 0 auto 0 0;
  width: 40%;
  animation: loading-bar-sweep 1.4s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  will-change: transform;
}

.loading-bar-line {
  position: absolute;
  inset: 0 0 auto;
  height: 1px;
  border-radius: 9999px;
  background: var(--loading-bar-tail);
}

.loading-bar-glow,
.loading-bar-head {
  position: absolute;
  mix-blend-mode: screen;
  filter: blur(4px);
  animation: loading-bar-pulse 700ms ease-in-out infinite alternate;
}

.loading-bar-glow {
  inset: 0 0 auto;
  height: 4px;
  border-radius: 9999px;
  background: var(--loading-bar-tail);
}

.loading-bar-head {
  top: -2.5px;
  right: -2.5px;
  width: 5px;
  height: 5px;
  border-radius: 9999px;
  background: hsl(var(--primary));
}

@keyframes loading-bar-sweep {
  from { transform: translateX(-100%); }
  to { transform: translateX(250%); }
}

@keyframes loading-bar-pulse {
  from { opacity: 0.5; }
  to { opacity: 0.88; }
}

@keyframes loading-bar-delay {
  from { opacity: 0; }
}

.loading-bar-leave-active {
  transition: opacity 320ms ease-out;
}

.loading-bar-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .loading-bar-comet {
    width: 100%;
    animation: none;
  }

  .loading-bar {
    --loading-bar-tail: hsl(var(--primary));
  }

  .loading-bar-head {
    display: none;
  }

  .loading-bar-glow {
    animation-duration: 1.6s;
  }
}
</style>
