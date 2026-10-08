<template>
  <!-- The row's context menu behind a visible button, for people who don't right-click. -->
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <button
        type="button"
        tabindex="-1"
        :aria-label="`Actions for ${label}`"
        :class="cn('flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring', props.class)"
        @pointerdown.stop
        @click.stop
      >
        <MoreHorizontal class="h-3.5 w-3.5" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" class="w-52">
      <DropdownMenuItem @select="rename">
        <Pencil class="h-4 w-4" /><span>Rename</span>
      </DropdownMenuItem>
      <DropdownMenuItem v-if="tab" @select="sidebar.setPinned(tab, !tab.pinned)">
        <PinOff v-if="tab.pinned" class="h-4 w-4" /><Pin v-else class="h-4 w-4" />
        <span>{{ tab.pinned ? 'Unpin' : 'Pin to top' }}</span>
      </DropdownMenuItem>
      <DropdownMenuItem v-if="session" :disabled="!session.processId" @select="openTimer(session)">
        <Clock class="h-4 w-4" /><span>Set timer</span>
      </DropdownMenuItem>
      <DropdownMenuItem :disabled="!targetId" @select="copyId(targetId)">
        <Copy class="h-4 w-4" /><span>Copy process ID</span>
      </DropdownMenuItem>
      <DropdownMenuItem class="text-destructive focus:text-destructive" @select="close">
        <X class="h-4 w-4" /><span>Close</span>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Clock, Copy, MoreHorizontal, Pencil, Pin, PinOff, X } from 'lucide-vue-next';
import { cn } from '@/lib/utils';
import { agentLabel } from '../../lib/agentTabs';
import type { StripTab } from '../../lib/tabStrip';
import type { ProcessRecord, SessionRecord } from '../../types';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { closeSession, closeTarget, copyId, openRename, openTimer } from './sidebarActions';
import { useSidebar } from './sidebarContext';

const props = defineProps<{
  session?: SessionRecord | undefined;
  process?: ProcessRecord | undefined;
  tab?: StripTab | undefined;
  class?: string | undefined;
}>();
const sidebar = useSidebar();
const label = computed(() => props.session ? agentLabel(props.session) : props.process?.name ?? '');
const targetId = computed(() => props.session ? props.session.processId : props.process?.id ?? null);

function rename(): void {
  if (props.session) openRename({ session: props.session });
  else if (props.process) openRename({ process: props.process });
}

function close(): void {
  if (props.session) void closeSession(props.session);
  else if (props.process) void closeTarget(props.process.id, 'process');
}
</script>
