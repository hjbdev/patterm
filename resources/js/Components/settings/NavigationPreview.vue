<template>
  <!-- A miniature workbench showing where agents appear with each layout.
       Decorative: the choice above it is the control. -->
  <div aria-hidden="true" class="pointer-events-none select-none overflow-hidden rounded-lg bg-[#080808] p-1.5 text-[10px] leading-tight text-foreground/85 [container-type:inline-size]">
    <div class="flex h-5 items-center gap-2 px-1">
      <span class="shrink-0 font-medium text-foreground">patterm-desktop</span>
      <div class="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden transition-opacity duration-300 motion-reduce:transition-none" :class="layout === 'tabs' ? 'opacity-100' : 'opacity-0'">
        <span v-for="family in FAMILIES" :key="family.label" class="flex h-4 min-w-0 max-w-[24cqw] flex-1 items-center gap-1 rounded-[4px] px-1.5" :class="family.selected ? 'bg-white/10 text-foreground' : 'text-foreground/70'">
          <span class="flex w-2 shrink-0 justify-center"><span :class="mark(family.status)">{{ family.status === 'permission' ? '?' : '' }}</span></span>
          <span class="truncate">{{ family.label }}</span>
        </span>
      </div>
      <span class="ml-auto flex shrink-0 items-center gap-1.5 pr-0.5"><span v-for="dot in 3" :key="dot" class="h-1.5 w-1.5 rounded-full bg-white/15" /></span>
    </div>
    <div class="mt-1 flex h-52 gap-1.5">
      <div class="shrink-0 overflow-hidden transition-[width,opacity] duration-300 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none" :class="layout === 'sidebar' ? 'w-[34cqw] opacity-100' : 'w-0 opacity-0'">
        <div class="w-[34cqw] space-y-1.5 pr-0.5 pt-0.5">
          <div v-for="family in FAMILIES" :key="family.label">
            <div class="flex items-start gap-1.5 rounded-[4px] px-1.5 py-1" :class="family.selected && !family.members?.length ? 'bg-white/10' : ''">
              <span class="flex h-3 w-2 shrink-0 items-center justify-center"><span :class="mark(family.status)">{{ family.status === 'permission' ? '?' : '' }}</span></span>
              <span class="min-w-0 flex-1">
                <span class="block truncate" :class="family.selected && 'font-medium text-foreground'">{{ family.label }}</span>
                <span v-if="family.note" class="mt-0.5 block truncate text-[9px] text-muted-foreground">{{ family.note }}</span>
              </span>
            </div>
            <div v-if="family.members?.length" class="ml-[9px] border-l border-white/10 pl-1">
              <div v-for="member in family.members" :key="member.label">
                <div class="flex items-center gap-1.5 rounded-[4px] px-1.5 py-[3px]" :class="member.selected && 'bg-white/10 text-foreground'">
                  <span class="flex w-2 shrink-0 justify-center"><span :class="mark(member.status)" /></span>
                  <span class="truncate" :class="member.dim && 'text-muted-foreground/80'">{{ member.label }}</span>
                </div>
                <div v-if="member.members?.length" class="ml-[9px] border-l border-white/10 pl-1">
                  <div v-for="child in member.members" :key="child.label" class="flex items-center gap-1.5 px-1.5 py-[3px]">
                    <span class="flex w-2 shrink-0 justify-center"><span :class="mark(child.status)" /></span>
                    <span class="truncate" :class="child.dim && 'text-muted-foreground/80'">{{ child.label }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="flex min-w-0 flex-1 flex-col rounded-md bg-background p-2.5">
        <div class="space-y-1.5">
          <div class="h-1.5 w-2/5 rounded-full bg-white/15" />
          <div class="h-1.5 w-4/5 rounded-full bg-white/[0.07]" />
          <div class="h-1.5 w-3/5 rounded-full bg-white/[0.07]" />
          <div class="h-1.5 w-2/3 rounded-full bg-white/[0.07]" />
        </div>
        <div class="mt-auto h-6 rounded-md border border-white/10" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { NavigationLayout } from '../../appearance/AppearanceSettings';

defineProps<{ layout: NavigationLayout }>();

type Status = 'working' | 'permission' | 'idle';
interface PreviewAgent { label: string; status: Status; note?: string; selected?: boolean; dim?: boolean; members?: PreviewAgent[] }

// The same agents in both layouts. In the sidebar, the selected subagent's
// path stays bright and the rest of its family dims, as in the real sidebar.
const FAMILIES: PreviewAgent[] = [
  { label: 'Settings redesign', status: 'working', note: 'Moving sections onto cards' },
  { label: 'Tab drag', status: 'permission', note: 'Needs permission' },
  {
    label: 'Sidebar navigation',
    status: 'working',
    note: 'Building the agent tree',
    selected: true,
    members: [
      { label: 'Check focus order', status: 'working', selected: true, members: [{ label: 'Re-run the audit', status: 'working', dim: true }] },
      { label: 'Review copy', status: 'idle', dim: true }
    ]
  },
  { label: 'Changelog tidy', status: 'idle' }
];

function mark(status: Status): string {
  if (status === 'permission') return 'text-[10px] font-semibold leading-none text-warning';
  if (status === 'working') return 'h-2 w-2 rounded-full border-[1.5px] border-purple-200';
  return 'h-2 w-2 rounded-full border-[1.5px] border-muted-foreground/60';
}
</script>
