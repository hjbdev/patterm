<template>
  <!-- A snoozed project folded to its name in All agents; its menu opens or wakes it. -->
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <button
        type="button"
        :title="`${project.name} is snoozed until ${until}`"
        :aria-label="`${project.name}, snoozed until ${until}`"
        :class="cn(
          'flex min-w-0 items-center gap-1.5 text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          chip ? 'h-[26px] max-w-48 shrink-0 rounded-tab px-2 text-[13px] hover:bg-muted/50' : 'h-6 w-full rounded-tab pl-2 pr-1 text-[11px]',
          props.class
        )"
      >
        <ProjectLogo :project="project" :size="chip ? 14 : 12" />
        <span class="truncate">{{ project.name }}</span>
        <SnoozeIcon :class="chip ? 'h-3.5 w-3.5' : 'h-3 w-3'" class="shrink-0" />
        <span v-if="!chip" class="h-px flex-1 bg-white/[0.06]" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent :align="chip ? 'end' : 'start'" class="w-56">
      <DropdownMenuLabel class="text-xs font-normal text-muted-foreground">Snoozed until {{ until }}</DropdownMenuLabel>
      <DropdownMenuItem class="text-[13px]" @select="pickProject(project.id)"><FolderOpen class="h-4 w-4" /><span>Open project</span></DropdownMenuItem>
      <DropdownMenuItem class="text-[13px]" @select="wakeProject(project.id)"><Sun class="h-4 w-4" /><span>Wake</span></DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>

<script setup lang="ts">
import { computed, type HTMLAttributes } from 'vue';
import { FolderOpen, Sun } from 'lucide-vue-next';
import { cn } from '@/lib/utils';
import { wakeProject } from '../Composables/useProjectSnooze';
import { useWorkbenchNavigation } from '../Composables/useWorkbenchNavigation';
import { describeWake } from '../lib/projectSnooze';
import type { ProjectSummary } from '../types';
import ProjectLogo from './ProjectLogo.vue';
import SnoozeIcon from './SnoozeIcon.vue';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from './ui/dropdown-menu';

const props = defineProps<{ project: ProjectSummary; chip?: boolean; class?: HTMLAttributes['class'] }>();
const { pickProject } = useWorkbenchNavigation();
const until = computed(() => props.project.snoozedUntil ? describeWake(new Date(props.project.snoozedUntil), new Date()) : '');
</script>
