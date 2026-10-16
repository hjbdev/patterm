<template>
  <Tooltip>
    <ContextMenu>
      <ContextMenuTrigger as-child>
        <!-- The trigger anchors the nearest popper, the context menu, so point it at the cursor. -->
        <TooltipTrigger as-child :reference="cursorAnchor">
          <button
            ref="button"
            type="button"
            :data-patterm-tab-id="`process:${process.id}`"
            :aria-label="pinned ? `${hostLabel(process.name, process.host)}, ${describeActivity(processActivity(process))}` : undefined"
            :class="cn(
              'relative isolate flex h-[26px] w-full touch-none select-none items-center gap-1.5 overflow-hidden rounded-tab bg-transparent text-left text-[13px] transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              pinned ? 'justify-center' : 'pl-2 pr-6',
              active && 'bg-primary/10'
            )"
            @click="emit('select')"
            @pointerdown="moveCursor"
            @contextmenu="moveCursor"
          >
            <TabWash :activity="processActivity(process)" />
            <RowStatus :activity="processActivity(process)" />
            <ProjectLogo v-if="!pinned && project" :project="project" :size="14" :title="project.name" />
            <span v-if="!pinned" class="min-w-0 flex-1 truncate">{{ process.name }}</span>
            <HostBadge v-if="!pinned && process.host" :host="process.host" />
            <UnreadDot :class="pinned && 'absolute right-1 top-1'" :urgency="unreadUrgency(process.id)" />
          </button>
        </TooltipTrigger>
      </ContextMenuTrigger>
      <ContextMenuContent class="w-52">
        <ContextMenuItem @select="openRenameProcess(process)">
          <Pencil class="h-4 w-4" /><span>Rename</span>
        </ContextMenuItem>
        <ContextMenuItem @select="emit('update:pinned', !pinned)">
          <PinOff v-if="pinned" class="h-4 w-4" /><Pin v-else class="h-4 w-4" /><span>{{ pinned ? 'Unpin tab' : 'Pin tab' }}</span>
        </ContextMenuItem>
        <ContextMenuItem @select="copyProcessId(process)">
          <Copy class="h-4 w-4" /><span>Copy process ID</span>
        </ContextMenuItem>
        <ContextMenuItem class="text-destructive focus:text-destructive" @select="closeProcess(process)">
          <X class="h-4 w-4" /><span>Close</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
    <!-- The trigger's anchor goes to the context menu, so the tooltip anchors itself. -->
    <TooltipContent :reference="button" class="bg-popover text-popover-foreground">
      <p v-if="pinned || !process.summary" :class="process.summary && 'px-2 pt-2 font-medium'">{{ hostLabel(process.name, process.host) }}</p>
      <AutoSummaryPreview v-if="process.summary" :summary="process.summary" />
    </TooltipContent>
  </Tooltip>

  <Dialog v-model:open="renameOpen">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>Rename process</DialogTitle>
        <DialogDescription>Set the label shown in the tab bar.</DialogDescription>
      </DialogHeader>
      <form class="flex flex-col gap-3" @submit.prevent="submitRename">
        <Input v-model="renameName" aria-label="Process name" maxlength="500" />
        <p v-if="renameError" role="alert" class="text-sm text-destructive">{{ renameError }}</p>
        <DialogFooter>
          <Button type="submit" :disabled="renameBusy || !renameName.trim()">Save</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import HostBadge from './HostBadge.vue';
import ProjectLogo from './ProjectLogo.vue';
import { computed, ref } from 'vue';
import { Copy, Pencil, Pin, PinOff, X } from 'lucide-vue-next';
import { toast } from 'vue-sonner';
import { cn } from '@/lib/utils';
import { describeActivity, processActivity } from '../lib/rowActivity';
import type { ProcessRecord, ProjectSummary } from '../types';
import RowStatus from './RowStatus.vue';
import TabWash from './TabWash.vue';
import UnreadDot from './UnreadDot.vue';
import { unreadUrgency } from '../Composables/useNotifications';
import { hostLabel } from '../lib/hosts';
import { confirmClose } from '../Composables/useCloseConfirm';
import AutoSummaryPreview from './AutoSummaryPreview.vue';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { Button } from './ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from './ui/context-menu';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';

defineProps<{
  process: ProcessRecord;
  active: boolean;
  pinned: boolean;
  // Shown while listing all agents.
  project?: ProjectSummary | null | undefined;
}>();

const emit = defineEmits<{
  select: [];
  'update:pinned': [pinned: boolean];
}>();

const button = ref<HTMLButtonElement>();
const cursor = ref({ x: 0, y: 0 });
const cursorAnchor = computed(() => {
  const { x, y } = cursor.value;
  return { getBoundingClientRect: () => DOMRect.fromRect({ x, y, width: 0, height: 0 }) };
});

// Touch and pen open the menu by long press, which fires no contextmenu event.
function moveCursor(event: MouseEvent): void {
  cursor.value = { x: event.clientX, y: event.clientY };
}
const renameOpen = ref(false);
const renameProcess = ref<ProcessRecord | null>(null);
const renameName = ref('');
const renameError = ref('');
const renameBusy = ref(false);

function openRenameProcess(process: ProcessRecord): void {
  renameProcess.value = process;
  renameName.value = process.name;
  renameError.value = '';
  renameOpen.value = true;
}

async function submitRename(): Promise<void> {
  const process = renameProcess.value;
  const name = renameName.value.trim();
  if (!process || renameBusy.value || !name) return;
  renameBusy.value = true;
  renameError.value = '';
  try {
    await window.patterm.call('rename_process', { process_id: process.id, name });
    renameOpen.value = false;
  } catch (caught) {
    renameError.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    renameBusy.value = false;
  }
}

async function copyProcessId(process: ProcessRecord): Promise<void> {
  try {
    await navigator.clipboard.writeText(process.id);
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : 'Could not copy process ID');
  }
}

function closeProcess(process: ProcessRecord): void {
  confirmClose(process.id, process.name, 'process');
}

</script>
