<template>
  <!-- The chosen harness's logo, with the others beside it in a fixed order;
       choosing one slides the row so it lands in the middle. -->
  <div
    class="harness-fan"
    :class="{ open, locked }"
    :style="{ '--x': `${offset}px` }"
  >
    <div class="track" role="group" :aria-label="locked ? undefined : 'Agent CLI'">
      <template v-for="item in shown" :key="item">
        <span v-if="locked" class="item current" :data-name="harnessLabel(item)" role="img" :aria-label="harnessLabel(item)">
          <span class="tile"><AgentIcon :harness="item" class="icon" /></span>
        </span>
        <button
          v-else
          type="button"
          class="item"
          :class="{ current: item === harness }"
          :data-name="harnessLabel(item)"
          :aria-label="item === harness ? harnessLabel(item) : `Use ${harnessLabel(item)}`"
          :aria-pressed="item === harness"
          @click="choose(item)"
        >
          <span class="tile"><AgentIcon :harness="item" class="icon" /></span>
        </button>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import AgentIcon from './AgentIcon.vue';
import { harnessLabel } from '../lib/harnesses';

const props = defineProps<{ harness: string; harnesses: readonly string[]; locked?: boolean }>();
const emit = defineEmits<{ select: [harness: string] }>();

const ITEM = 40, CURRENT = 52;
const shown = computed(() => props.locked ? [props.harness] : props.harnesses.includes(props.harness) ? props.harnesses : [props.harness, ...props.harnesses]);
const currentIndex = computed(() => Math.max(0, shown.value.indexOf(props.harness)));
// Every item before the current one is ITEM wide; centre the current one.
const offset = computed(() => -(currentIndex.value * ITEM + CURRENT / 2));
const open = computed(() => !props.locked && shown.value.length > 1);

function choose(item: string): void {
  if (item !== props.harness) emit('select', item);
}
</script>

<style scoped>
.harness-fan {
  --slide: 340ms;
  --ease: cubic-bezier(.2, .8, .2, 1);
  position: relative;
  width: 52px;
  height: 52px;
  margin: 0 auto;
}
.track {
  position: absolute;
  left: 26px;
  top: 0;
  height: 52px;
  display: flex;
  align-items: center;
  transform: translateX(var(--x));
  transition: transform var(--slide) var(--ease);
}
.locked .track { transform: translateX(-26px); transition: none; }
.item {
  position: relative;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 52px;
  border-radius: 12px;
  outline: none;
  transition: width var(--slide) var(--ease);
}
.item.current { width: 52px; }
.tile {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  transition: background-color 120ms;
}
.item.current .tile { width: 52px; height: 52px; }
.icon {
  width: 20px !important;
  height: 20px !important;
  color: hsl(var(--muted-foreground));
  opacity: .7;
  transition: width var(--slide) var(--ease), height var(--slide) var(--ease), color 200ms, opacity 200ms;
}
.item.current .icon { width: 40px !important; height: 40px !important; color: hsl(var(--foreground)); opacity: 1; }
.item:not(.current):hover .tile, .item:not(.current):focus-visible .tile { background: hsl(var(--muted)); }
.item:not(.current):hover .icon, .item:not(.current):focus-visible .icon { color: hsl(var(--foreground)); opacity: 1; }
.item.current:focus-visible .tile { box-shadow: 0 0 0 2px hsl(var(--ring)); }
.item::after {
  content: attr(data-name);
  position: absolute;
  left: 50%;
  top: -14px;
  transform: translateX(-50%);
  white-space: nowrap;
  font-size: 11.5px;
  color: hsl(var(--muted-foreground));
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms;
}
.open .item:hover::after, .open .item:focus-visible::after { opacity: 1; }
.open .item.current::after { opacity: 1; color: hsl(var(--foreground)); }
.open:has(.item:not(.current):hover) .item.current::after { opacity: 0; }
.locked .item::after { display: none; }
@media (prefers-reduced-motion: reduce) {
  .track, .item, .tile, .icon { transition: none !important; }
}
</style>
