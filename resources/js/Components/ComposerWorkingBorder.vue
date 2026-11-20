<template>
  <!-- A lightweight GPU-composited border comet while the agent works: one
       rotating conic gradient masked to the composer's 1px border ring, with
       zero JS keyframe rebuilds when the composer changes height. -->
  <div class="composer-comet" aria-hidden="true">
    <span class="composer-comet-beam" />
  </div>
</template>

<style scoped>
/* Covers the composer's border box and masks out its interior so only the 1px
   rounded border ring shows the sweeping comet. */
.composer-comet {
  position: absolute;
  inset: -1px;
  border-radius: 12px;
  padding: 1px;
  pointer-events: none;
  overflow: hidden;
  -webkit-mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  mask-composite: exclude;
}

.composer-comet-beam {
  position: absolute;
  left: 50%;
  top: 50%;
  width: max(200%, 820px);
  aspect-ratio: 1;
  background: conic-gradient(
    from 0deg,
    transparent 0deg,
    transparent 285deg,
    hsl(var(--primary) / 0.1) 312deg,
    hsl(var(--primary) / 0.35) 334deg,
    hsl(var(--primary) / 0.75) 350deg,
    hsl(var(--primary) / 0.95) 358deg,
    transparent 360deg
  );
  transform: translate(-50%, -50%) rotate(0deg);
  animation: composer-comet-spin 3.6s linear infinite;
  will-change: transform;
}

@keyframes composer-comet-spin {
  from { transform: translate(-50%, -50%) rotate(0deg); }
  to { transform: translate(-50%, -50%) rotate(360deg); }
}

/* Without motion the border brightens instead. */
@media (prefers-reduced-motion: reduce) {
  .composer-comet {
    padding: 0;
    border: 1px solid hsl(var(--primary) / 0.3);
    -webkit-mask: none;
    mask: none;
  }

  .composer-comet-beam {
    display: none;
  }
}
</style>
