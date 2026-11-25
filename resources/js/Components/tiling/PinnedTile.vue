<template>
  <!-- One pinned tile: a single panel, or a group of them as tabs. Its header
       drags it, a tab drags just that panel out, and Alt drags it from
       anywhere, as SUPER does in Hyprland. -->
  <article
    :data-tile-id="tile.id"
    tabindex="-1"
    class="pinned-tile group/tile absolute left-0 top-0 flex flex-col overflow-hidden rounded-xl border bg-background outline-none"
    :class="[focused ? 'border-white/30' : 'border-white/[0.06]', lifted && 'shadow-2xl shadow-black/70 ring-1 ring-white/20', entering && 'pinned-tile-enter', flashing && 'pinned-tile-flash']"
    :aria-label="tile.tabs.length > 1 ? `Pinned: ${tile.tabs.map((kind) => PIN_META[kind].title).join(', ')}` : `Pinned: ${PIN_META[tile.active].title}`"
    @pointerdown.capture="altGrab"
    @animationend.self="entered"
    @animationcancel.self="entered"
  >
    <header class="flex h-10 shrink-0 cursor-grab select-none items-center gap-1 border-b border-white/[0.04] pl-2 pr-1.5 active:cursor-grabbing" @pointerdown="emit('grab', $event, null)" @dblclick="emit('maximise')">
      <template v-if="tile.tabs.length === 1">
        <component :is="PIN_META[tile.active].icon" class="ml-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h2 class="ml-0.5 min-w-0 truncate text-[13px] font-medium">{{ PIN_META[tile.active].title }}</h2>
      </template>
      <div v-else role="tablist" class="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]" @wheel.prevent="cycle">
        <button
          v-for="kind in tile.tabs"
          :key="kind"
          type="button"
          role="tab"
          :aria-selected="kind === tile.active"
          class="group/tab flex h-7 shrink-0 cursor-default items-center gap-1.5 rounded-md pl-2 pr-1 text-[12.5px] outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring"
          :class="kind === tile.active ? 'bg-white/[0.08] text-foreground' : 'text-muted-foreground hover:text-foreground'"
          @pointerdown.stop="emit('grab', $event, kind)"
          @click="emit('activate', kind)"
          @auxclick.prevent="$event.button === 1 && emit('close', kind)"
        >
          <component :is="PIN_META[kind].icon" class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{{ PIN_META[kind].title }}</span>
          <span role="button" tabindex="-1" :aria-label="`Unpin ${PIN_META[kind].title}`" class="flex h-5 w-5 items-center justify-center rounded opacity-0 transition-opacity hover:bg-white/10 group-hover/tab:opacity-100" @pointerdown.stop @click.stop="emit('close', kind)"><X class="h-3 w-3" /></span>
        </button>
      </div>
      <span class="min-w-2 flex-1" />
      <span class="flex items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover/tile:opacity-100 [@media(hover:none)]:opacity-100" @pointerdown.stop @dblclick.stop>
        <button type="button" :class="ICON_BUTTON" :aria-label="maximised ? 'Restore' : 'Maximise'" :title="maximised ? 'Restore (Alt+F)' : 'Maximise (Alt+F)'" @click="emit('maximise')"><component :is="maximised ? Minimize2 : Maximize2" class="h-3.5 w-3.5" /></button>
        <button type="button" :class="ICON_BUTTON" :aria-label="`Unpin ${PIN_META[tile.active].title}`" title="Unpin (Alt+Q)" @click="emit('close', tile.active)"><PinOff class="h-3.5 w-3.5" /></button>
      </span>
    </header>
    <div class="relative flex min-h-0 flex-1 flex-col">
      <slot :kind="tile.active" />
      <!-- Dropping here would make it a tab. -->
      <div v-if="joining" class="pointer-events-none absolute inset-2 flex items-center justify-center rounded-lg bg-white/[0.08] ring-1 ring-inset ring-white/30 duration-150 animate-in fade-in-0">
        <span class="rounded-md bg-popover px-2.5 py-1 text-[12.5px] shadow-lg">Add as a tab</span>
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { Maximize2, Minimize2, PinOff, X } from 'lucide-vue-next';
import type { PinKind, Tile } from '../../lib/tiling';
import { PIN_META } from './pinMeta';

// `enter` animates the tile in as it mounts.
const props = defineProps<{ tile: Tile; enter: boolean; focused: boolean; maximised: boolean; lifted: boolean; joining: boolean; flashing: boolean }>();
const emit = defineEmits<{ grab: [event: PointerEvent, kind: PinKind | null]; activate: [kind: PinKind]; close: [kind: PinKind]; maximise: [] }>();
const ICON_BUTTON = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.07] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

// The entrance plays once. Its class goes when it ends, or when a flash
// replaces it: left on, the entrance would run again as the flash ends.
const entering = ref(props.enter);
function entered(event: AnimationEvent): void {
  if (event.animationName === 'pinned-tile-enter') entering.value = false;
}
watch(() => props.flashing, (flashing) => { if (flashing) entering.value = false; });

function altGrab(event: PointerEvent): void {
  if (!event.altKey || event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  emit('grab', event, null);
}
// Scrolling over the tabs steps through them.
let lastStep = 0;
function cycle(event: WheelEvent): void {
  if (event.timeStamp - lastStep < 160) return;
  lastStep = event.timeStamp;
  const tabs = props.tile.tabs;
  const index = tabs.indexOf(props.tile.active) + (event.deltaY > 0 || event.deltaX > 0 ? 1 : -1);
  emit('activate', tabs[(index + tabs.length) % tabs.length]!);
}
</script>
