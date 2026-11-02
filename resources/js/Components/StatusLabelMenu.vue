<template>
  <!-- A menu's Status submenu: pin a configured label on the agent, or clear
       it. `dropdown` builds it from dropdown parts, for a ⋯ menu. -->
  <component :is="parts.Sub">
    <component :is="parts.SubTrigger" :disabled="!session.processId || session.processStatus !== 'running' || Boolean(session.host)">
      <Tag class="h-4 w-4" />
      <span>Status</span>
    </component>
    <component :is="parts.SubContent" class="w-52">
      <component :is="parts.Item" v-for="label in labels" :key="label.id" @select="set(label.id)">
        <span class="h-2 w-2 shrink-0 rounded-full" :style="{ backgroundColor: statusLabelDot(label.color) }" aria-hidden="true" />
        <span class="min-w-0 flex-1 truncate">{{ label.name }}</span>
        <Check v-if="session.statusLabel?.id === label.id" class="h-4 w-4" />
      </component>
      <p v-if="!labels.length" class="px-2 py-1.5 text-xs text-muted-foreground">No labels. Add them in Settings › Status labels.</p>
      <component :is="parts.Separator" />
      <component :is="parts.Item" :disabled="!session.statusLabel" @select="set(null)">
        <X class="h-4 w-4" />
        <span>Clear status</span>
      </component>
    </component>
  </component>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Check, Tag, X } from 'lucide-vue-next';
import { useStatusLabels } from '../Composables/useStatusLabels';
import { setAgentStatus, statusLabelDot } from '../lib/statusLabels';
import { toast } from 'vue-sonner';
import { errorMessage } from '../lib/utils';
import type { SessionRecord } from '../types';
import { ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from './ui/context-menu';
import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from './ui/dropdown-menu';

const props = defineProps<{ session: SessionRecord; dropdown?: boolean }>();
const { labels } = useStatusLabels();
const parts = computed(() => props.dropdown
  ? { Sub: DropdownMenuSub, SubTrigger: DropdownMenuSubTrigger, SubContent: DropdownMenuSubContent, Item: DropdownMenuItem, Separator: DropdownMenuSeparator }
  : { Sub: ContextMenuSub, SubTrigger: ContextMenuSubTrigger, SubContent: ContextMenuSubContent, Item: ContextMenuItem, Separator: ContextMenuSeparator });

function set(labelId: string | null): void {
  if (!props.session.processId) return;
  setAgentStatus(props.session.processId, labelId).catch((error: unknown) => toast.error(errorMessage(error)));
}
</script>
