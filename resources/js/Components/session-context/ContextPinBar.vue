<template>
  <!-- Atop a chip's list: its name, and pinning it beside the conversation,
       on its own or as a tab of the panel pins go beside. -->
  <div class="-mx-1.5 -mt-1.5 mb-1.5 flex h-9 items-center gap-1 border-b border-white/[0.06] pl-3.5 pr-1">
    <span class="min-w-0 flex-1 truncate text-[12.5px] font-medium text-muted-foreground">{{ title }}</span>
    <button type="button" :class="ACTION" :title="`Pin ${title.toLowerCase()} beside the conversation`" @click="emit('pin')"><Pin class="h-3.5 w-3.5" />Pin</button>
    <button v-if="tabInto" type="button" :class="ACTION" :title="`Add as a tab beside ${tabInto}`" @click="emit('tab')"><PanelTop class="h-3.5 w-3.5" />Tab</button>
  </div>
</template>

<script setup lang="ts">
import { PanelTop, Pin } from 'lucide-vue-next';

defineProps<{ title: string; tabInto?: string | null | undefined }>();
const emit = defineEmits<{ pin: []; tab: [] }>();
const ACTION = 'flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-muted-foreground outline-none transition-colors hover:bg-white/[0.08] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring';
</script>
