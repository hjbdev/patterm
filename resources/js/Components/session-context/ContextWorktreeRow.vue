<template>
  <div class="group/row flex items-center rounded-md transition-colors" :class="active ? 'bg-muted/60' : 'hover:bg-muted/40'">
    <button type="button" class="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 text-left text-[13px] leading-5 outline-none focus-visible:ring-1 focus-visible:ring-ring" :class="dense ? 'py-1' : 'py-1.5'" :title="worktree.own ? `${worktree.worktree_path} (this agent runs here)` : worktree.worktree_path" :aria-label="`Review changes in ${name}`" @pointerenter="warmDiffHighlighter" @focus="warmDiffHighlighter" @click="emit('open')">
      <GitBranch class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span class="min-w-0 flex-1 truncate">{{ name }}</span>
      <WorktreeChanges :state="state" />
    </button>
    <Button v-if="!worktree.own" size="icon" variant="ghost" :class="ROW_ACTION" class="mr-1" :disabled="busy" :aria-label="`Unlink ${name}`" title="Unlink" @click="emit('unlink')"><X class="h-3.5 w-3.5" /></Button>
    <!-- The agent's own worktree cannot be unlinked; the gap keeps its changes in line with the other rows. -->
    <span v-else class="mr-1 w-6 shrink-0" aria-hidden="true" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { GitBranch, X } from 'lucide-vue-next';
import { Button } from '../ui/button';
import WorktreeChanges from './WorktreeChanges.vue';
import { ROW_ACTION } from './rowAction';
import { sessionWorktreeName } from '../../Composables/useSessionContext';
import type { WorktreeDiffTotalsState } from '../../Composables/useWorktreeDiff';
import type { SessionWorktree } from '../../lib/projectContext';

const props = withDefaults(defineProps<{ worktree: SessionWorktree; state: WorktreeDiffTotalsState | undefined; active?: boolean | undefined; busy?: boolean | undefined; dense?: boolean | undefined }>(), { active: false, busy: false, dense: false });
const emit = defineEmits<{ open: []; unlink: [] }>();
const name = computed(() => sessionWorktreeName(props.worktree));

// Loading the diff viewer and starting its highlighting workers on hover hides
// their start-up from the first open.
function warmDiffHighlighter(): void {
  void import('../WorktreeFileDiff.vue');
  void import('../../lib/diffHighlighter').then(({ diffHighlighterPool }) => diffHighlighterPool());
}
</script>
