<template>
  <ContextMenu>
    <ContextMenuTrigger as-child>
      <slot />
    </ContextMenuTrigger>
    <ContextMenuContent class="w-52">
      <ContextMenuItem @select="rename">
        <Pencil class="h-4 w-4" /><span>Rename</span>
      </ContextMenuItem>
      <ContextMenuItem v-if="tab" @select="sidebar.setPinned(tab, !tab.pinned)">
        <PinOff v-if="tab.pinned" class="h-4 w-4" /><Pin v-else class="h-4 w-4" />
        <span>{{ tab.pinned ? 'Unpin' : 'Pin to top' }}</span>
      </ContextMenuItem>
      <!-- Agents in the list, not their subagents, can be snoozed. -->
      <template v-if="tab && session">
        <ContextMenuItem v-if="isSnoozed(session)" @select="unsnooze(session.processId!)">
          <Sun class="h-4 w-4" /><span>Wake</span>
        </ContextMenuItem>
        <ContextMenuItem v-else :disabled="!canSnooze(session)" @select="openSnooze(session)">
          <Moon class="h-4 w-4" /><span>Snooze…</span>
        </ContextMenuItem>
      </template>
      <ContextMenuItem v-if="session" :disabled="!session.processId" @select="openTimer(session)">
        <Clock class="h-4 w-4" /><span>Set timer</span>
      </ContextMenuItem>
      <ContextMenuItem :disabled="!targetId" @select="copyId(targetId)">
        <Copy class="h-4 w-4" /><span>Copy process ID</span>
      </ContextMenuItem>
      <ContextMenuItem class="text-destructive focus:text-destructive" @select="close">
        <X class="h-4 w-4" /><span>Close</span>
      </ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Clock, Copy, Moon, Pencil, Pin, PinOff, Sun, X } from 'lucide-vue-next';
import { canSnooze, openSnooze, unsnooze } from '../../Composables/useSnooze';
import { isSnoozed } from '../../lib/snooze';
import type { StripTab } from '../../lib/tabStrip';
import type { ProcessRecord, SessionRecord } from '../../types';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../ui/context-menu';
import { closeProcess, closeSession, copyId, openRename, openTimer } from './sidebarActions';
import { useSidebar } from './sidebarContext';

const props = defineProps<{ session?: SessionRecord | undefined; process?: ProcessRecord | undefined; tab?: StripTab | undefined }>();
const sidebar = useSidebar();
const targetId = computed(() => props.session ? props.session.processId : props.process?.id ?? null);

function rename(): void {
  if (props.session) openRename({ session: props.session });
  else if (props.process) openRename({ process: props.process });
}

function close(): void {
  if (props.session) closeSession(props.session);
  else if (props.process) closeProcess(props.process);
}
</script>
