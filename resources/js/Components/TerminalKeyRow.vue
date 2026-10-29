<template>
  <!-- Over an on-screen keyboard, the keys a TUI needs that it lacks. Pressing
       one keeps focus in the terminal, so the keyboard stays up. -->
  <div role="toolbar" aria-label="Terminal keys" class="flex shrink-0 gap-1.5 border-t border-white/5 bg-[hsl(0_0%_9%)] p-1.5" @pointerdown.prevent @mousedown.prevent>
    <button
      v-for="key in KEYS"
      :key="key.key"
      type="button"
      :aria-label="key.label"
      :aria-pressed="key.key === 'Control' ? ctrlHeld : undefined"
      class="flex h-10 min-w-0 flex-1 items-center justify-center rounded-md font-mono text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      :class="key.key === 'Control' && ctrlHeld ? 'bg-primary text-primary-foreground' : 'bg-white/[0.08] text-foreground/90 active:bg-white/15'"
      @click="emit('key', key.key)"
    >
      <component :is="key.icon" v-if="'icon' in key" class="h-4 w-4" aria-hidden="true" />
      <template v-else>{{ key.text }}</template>
    </button>
  </div>
</template>

<script setup lang="ts">
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from 'lucide-vue-next';

defineProps<{ ctrlHeld: boolean }>();
const emit = defineEmits<{ key: [key: string] }>();

// Named as KeyboardEvent.key names them, for the terminal's key mapping.
const KEYS = [
  { key: 'Escape', text: 'Esc', label: 'Escape' },
  { key: 'Tab', text: 'Tab', label: 'Tab' },
  { key: 'Control', text: 'Ctrl', label: 'Control' },
  { key: 'ArrowLeft', icon: ArrowLeft, label: 'Left' },
  { key: 'ArrowUp', icon: ArrowUp, label: 'Up' },
  { key: 'ArrowDown', icon: ArrowDown, label: 'Down' },
  { key: 'ArrowRight', icon: ArrowRight, label: 'Right' }
] as const;
</script>
