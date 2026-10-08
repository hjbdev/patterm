<template>
  <DropdownMenu v-if="compact">
    <DropdownMenuTrigger as-child>
      <Button variant="ghost" size="sm" class="h-7 shrink-0 gap-1.5 rounded-tab px-2 text-xs text-muted-foreground" aria-label="Diff view options">
        <SlidersHorizontal class="h-3.5 w-3.5" aria-hidden="true" />
        <span v-if="activeFilters" class="tabular-nums">{{ activeFilters }}</span>
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="w-60">
      <DropdownMenuLabel class="text-xs font-medium text-muted-foreground">Changes</DropdownMenuLabel>
      <DropdownMenuRadioGroup :model-value="viewer.scope" @update:model-value="setScope">
        <DropdownMenuRadioItem value="branch" class="text-[13px]" @select.prevent>Branch since {{ baseLabel }}</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="uncommitted" class="text-[13px]" @select.prevent>Uncommitted only</DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuCheckboxItem v-model="viewer.filters.excludeDocs" class="text-[13px]" @select.prevent>Exclude docs</DropdownMenuCheckboxItem>
      <DropdownMenuCheckboxItem v-model="viewer.filters.excludeTests" class="text-[13px]" @select.prevent>Exclude tests</DropdownMenuCheckboxItem>
      <template v-if="styles">
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup :model-value="viewer.diffStyle" @update:model-value="setStyle">
          <DropdownMenuRadioItem value="split" class="text-[13px]" @select.prevent>Split</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="unified" class="text-[13px]" @select.prevent>Unified</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </template>
    </DropdownMenuContent>
  </DropdownMenu>
  <div v-else class="flex shrink-0 items-center gap-1.5">
    <div role="radiogroup" aria-label="Changes to show" class="inline-flex gap-0.5 rounded-tab bg-muted/40 p-0.5">
      <button v-for="option in scopes" :key="option.value" type="button" role="radio" :aria-checked="viewer.scope === option.value" :title="option.title" :class="segment(viewer.scope === option.value)" @click="viewer.scope = option.value">{{ option.label }}</button>
    </div>
    <div class="inline-flex gap-0.5 rounded-tab bg-muted/40 p-0.5">
      <button type="button" :aria-pressed="viewer.filters.excludeDocs" title="Hide Markdown, text, and other documentation files" :class="segment(viewer.filters.excludeDocs)" @click="viewer.filters.excludeDocs = !viewer.filters.excludeDocs">
        <Check v-if="viewer.filters.excludeDocs" class="h-3 w-3" aria-hidden="true" />Exclude docs
      </button>
      <button type="button" :aria-pressed="viewer.filters.excludeTests" title="Hide tests, specs, fixtures, and snapshots" :class="segment(viewer.filters.excludeTests)" @click="viewer.filters.excludeTests = !viewer.filters.excludeTests">
        <Check v-if="viewer.filters.excludeTests" class="h-3 w-3" aria-hidden="true" />Exclude tests
      </button>
    </div>
    <div v-if="styles" role="radiogroup" aria-label="Diff layout" class="inline-flex gap-0.5 rounded-tab bg-muted/40 p-0.5">
      <button type="button" role="radio" :aria-checked="viewer.diffStyle === 'split'" aria-label="Split" title="Split" :class="segment(viewer.diffStyle === 'split', true)" @click="viewer.diffStyle = 'split'"><Columns2 class="h-3.5 w-3.5" aria-hidden="true" /></button>
      <button type="button" role="radio" :aria-checked="viewer.diffStyle === 'unified'" aria-label="Unified" title="Unified" :class="segment(viewer.diffStyle === 'unified', true)" @click="viewer.diffStyle = 'unified'"><Rows2 class="h-3.5 w-3.5" aria-hidden="true" /></button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Check, Columns2, Rows2, SlidersHorizontal } from 'lucide-vue-next';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from './ui/dropdown-menu';
import type { WorktreeDiffViewerState } from '../Composables/useWorktreeDiff';

const props = withDefaults(defineProps<{ viewer: WorktreeDiffViewerState; compact?: boolean; styles?: boolean }>(), { compact: false, styles: true });

const baseLabel = computed(() => props.viewer.summary?.base.ref ?? 'main');
const scopes = computed(() => [
  { value: 'branch' as const, label: 'Branch', title: `Everything on this branch since it split from ${baseLabel.value}, including uncommitted and untracked files` },
  { value: 'uncommitted' as const, label: 'Uncommitted', title: 'Only changes that are not committed yet, including untracked files' }
]);
const activeFilters = computed(() => Number(props.viewer.filters.excludeDocs) + Number(props.viewer.filters.excludeTests) || null);

// Matches the agent interface toggle so the controls read as one family.
function segment(active: boolean, icon = false): string {
  return cn(
    'flex h-6 items-center gap-1 rounded-[5px] text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
    icon ? 'w-7 justify-center' : 'px-2',
    active && 'bg-primary/10 text-foreground'
  );
}

function setScope(value: unknown): void {
  if (value === 'branch' || value === 'uncommitted') props.viewer.scope = value;
}

function setStyle(value: unknown): void {
  if (value === 'split' || value === 'unified') props.viewer.diffStyle = value;
}
</script>
