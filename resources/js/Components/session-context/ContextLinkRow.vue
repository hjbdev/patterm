<template>
  <div class="group/row flex items-center rounded-md pr-1 transition-colors hover:bg-muted/40">
    <a :href="link.url" target="_blank" rel="noopener noreferrer" class="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 text-[13px] leading-5 outline-none focus-visible:ring-1 focus-visible:ring-ring" :class="dense ? 'py-1' : 'py-1.5'" :title="link.url">
      <component :is="linkIcon(link)" class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <!-- A long title shrinks too, so the status beside it stays visible. -->
      <span class="min-w-0 truncate font-medium" :class="link.identifier ? 'max-w-[60%] shrink-0' : 'max-w-full'">{{ linkLabel(link) }}</span>
      <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{{ linkDetail(link) }}</span>
      <span v-if="status" class="shrink-0 rounded-full border border-border px-1.5 text-[11px] leading-4 text-muted-foreground" :title="`${status}, as last reported. Patterm does not check it.`">{{ status }}</span>
    </a>
    <LinkEditPopover :link="link" :busy="busy" @save="(changes, done) => emit('update', changes, done)">
      <Button size="icon" variant="ghost" :class="ROW_ACTION" :disabled="busy" :aria-label="`Edit ${linkLabel(link)}`" title="Edit"><Pencil class="h-3 w-3" /></Button>
    </LinkEditPopover>
    <Button size="icon" variant="ghost" :class="ROW_ACTION" :disabled="busy" :aria-label="`Detach ${linkLabel(link)}`" title="Detach" @click="emit('detach')"><X class="h-3.5 w-3.5" /></Button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Pencil, X } from 'lucide-vue-next';
import { Button } from '../ui/button';
import LinkEditPopover from './LinkEditPopover.vue';
import { ROW_ACTION } from './rowAction';
import { linkDetail, linkIcon, linkLabel, linkStatusLabel, type LinkChanges } from '../../Composables/useSessionContext';
import type { Reference } from '../../lib/projectContext';

const props = withDefaults(defineProps<{ link: Reference; busy?: boolean | undefined; dense?: boolean | undefined }>(), { busy: false, dense: false });
const status = computed(() => linkStatusLabel(props.link));
const emit = defineEmits<{ update: [changes: LinkChanges, done: (saved: boolean) => void]; detach: [] }>();
</script>
