<template>
  <!-- Right-click or long-press the row, or, with `dropdown`, click what's in
       the slot (an agent page's ⋯). -->
  <component :is="parts.Root">
    <component :is="parts.Trigger" as-child>
      <slot />
    </component>
    <component :is="parts.Content" class="w-52" :align="dropdown ? 'end' : undefined">
      <slot name="extra" :item="parts.Item" :separator="parts.Separator" />
      <component :is="parts.Item" @select="rename">
        <Pencil class="h-4 w-4" /><span>Rename</span>
      </component>
      <StatusLabelMenu v-if="session" :session="session" :dropdown="Boolean(dropdown)" />
      <component :is="parts.Item" v-if="tab" @select="sidebar.setPinned(tab, !tab.pinned)">
        <PinOff v-if="tab.pinned" class="h-4 w-4" /><Pin v-else class="h-4 w-4" />
        <span>{{ tab.pinned ? 'Unpin' : 'Pin to top' }}</span>
      </component>
      <!-- Agents in the list, not their subagents, can be snoozed. -->
      <template v-if="tab && session">
        <component :is="parts.Item" v-if="isSnoozed(session)" @select="unsnooze(session.processId!)">
          <Sun class="h-4 w-4" /><span>Wake</span>
        </component>
        <component :is="parts.Item" v-else :disabled="!canSnooze(session)" @select="openSnooze(session)">
          <Moon class="h-4 w-4" /><span>Snooze…</span>
        </component>
      </template>
      <component :is="parts.Item" v-if="session" :disabled="!session.processId" @select="openTimer(session)">
        <Clock class="h-4 w-4" /><span>Set timer</span>
      </component>
      <!-- While the list shows subagents, one agent can keep its own folded away. -->
      <component :is="parts.Item" v-if="familyRoot" @select="expansion.setMembersHidden(familyRoot, expansion.membersShown(familyRoot))">
        <ListTree class="h-4 w-4" /><span>{{ expansion.membersShown(familyRoot) ? 'Hide subagents here' : 'Show subagents here' }}</span>
      </component>
      <component :is="parts.Item" :disabled="!targetId" @select="copyId(targetId)">
        <Copy class="h-4 w-4" /><span>Copy process ID</span>
      </component>
      <component :is="parts.Separator" />
      <component :is="parts.Item" class="text-destructive focus:text-destructive" @select="close">
        <X class="h-4 w-4" /><span>Close</span>
      </component>
    </component>
  </component>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Clock, Copy, ListTree, Moon, Pencil, Pin, PinOff, Sun, X } from 'lucide-vue-next';
import { useSidebarExpansion } from '../../Composables/useSidebarExpansion';
import { canSnooze, openSnooze, unsnooze } from '../../Composables/useSnooze';
import { isSnoozed } from '../../lib/snooze';
import type { StripTab } from '../../lib/tabStrip';
import type { ProcessRecord, SessionRecord } from '../../types';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '../ui/context-menu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { closeProcess, closeSession, copyId, openRename, openTimer } from './sidebarActions';
import { useSidebar } from './sidebarContext';
import StatusLabelMenu from '../StatusLabelMenu.vue';

const props = defineProps<{ session?: SessionRecord | undefined; process?: ProcessRecord | undefined; tab?: StripTab | undefined; dropdown?: boolean }>();
const sidebar = useSidebar();
const expansion = useSidebarExpansion(() => sidebar.expansionScope.value);
const targetId = computed(() => props.session ? props.session.processId : props.process?.id ?? null);
const parts = computed(() => props.dropdown
  ? { Root: DropdownMenu, Trigger: DropdownMenuTrigger, Content: DropdownMenuContent, Item: DropdownMenuItem, Separator: DropdownMenuSeparator }
  : { Root: ContextMenu, Trigger: ContextMenuTrigger, Content: ContextMenuContent, Item: ContextMenuItem, Separator: ContextMenuSeparator });
// A list row with subagents or servers, while the list shows them at all.
const familyRoot = computed(() => props.tab?.kind === 'agent' && expansion.view.value.members && sidebar.memberCount(props.tab.family) > 0 ? props.tab.family.rootId : null);

function rename(): void {
  if (props.session) openRename({ session: props.session });
  else if (props.process) openRename({ process: props.process });
}

function close(): void {
  if (props.session) closeSession(props.session);
  else if (props.process) closeProcess(props.process);
}
</script>
