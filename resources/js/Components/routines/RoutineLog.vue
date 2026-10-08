<template>
  <!-- Routine reports read in place, newest first; long ones fade after a few lines. -->
  <!-- Spacing, not dividers, separates reports, so a hovered one reads as a single block.
       The bottom padding is 3 px less than the top to absorb the last line's leading,
       and a faded report needs little, since its fade ends at the box edge. -->
  <div class="-mx-3 space-y-1">
    <article
      v-for="run in runs"
      :key="run.run_id"
      role="button"
      tabindex="0"
      :aria-label="`${routineOf(run)?.name ?? 'Routine'}, ${runStatusLabel(run)}: open report`"
      class="cursor-pointer rounded-lg px-3 pb-[9px] pt-3 outline-none has-[[data-clipped]]:pb-1 transition-colors duration-150 hover:bg-white/[0.035] focus-visible:bg-white/[0.035] focus-visible:ring-1 focus-visible:ring-ring"
      @click="open(run, $event)"
      @keydown.enter.self="emit('open', run)"
      @keydown.space.self.prevent="emit('open', run)"
    >
      <header class="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <AgentIcon :harness="routineOf(run)?.harness ?? 'claude'" class="h-3.5 w-3.5" />
        <span class="truncate font-medium text-foreground">{{ routineOf(run)?.name ?? 'Routine' }}</span>
        <span class="shrink-0" :class="statusTone(run)">{{ runStatusLabel(run) }}</span>
        <span class="ml-auto shrink-0 tabular-nums">{{ formatRunWhen(runTime(run), now) }}</span>
      </header>
      <!-- Only a report that is cut short fades, so a complete one never loses its last line. -->
      <div v-if="run.report ?? run.excerpt" v-clip-fade class="max-h-28 overflow-hidden data-[clipped]:[mask-image:linear-gradient(to_bottom,black_5rem,transparent_7rem)] [&_.markdown]:text-[13px] [&_.markdown]:text-muted-foreground [&_.markdown_h1]:!text-[13px] [&_.markdown_h1]:text-foreground [&_.markdown_h2]:my-1 [&_.markdown_h2]:!text-[13px] [&_.markdown_h2]:text-foreground [&_.markdown_h3]:!text-[13px] [&_.markdown_h3]:text-foreground">
        <Markdown :source="run.report ?? run.excerpt ?? ''">
          <template #mention="{ part }"><MentionPart :part="part" /></template>
        </Markdown>
      </div>
      <p v-else class="text-xs text-muted-foreground/70">{{ run.status === 'running' ? 'Running now.' : 'No report.' }}</p>
    </article>
  </div>
</template>

<script setup lang="ts">
import type { Directive } from 'vue';
import AgentIcon from '../AgentIcon.vue';
import Markdown from '../Markdown.vue';
import MentionPart from '../MentionPart.vue';
import { formatRunWhen, runStatusLabel, runTime, type RoutineRecord, type RoutineRunRecord } from '../../lib/routines';

const props = defineProps<{ runs: RoutineRunRecord[]; routines: RoutineRecord[]; now: number }>();
const emit = defineEmits<{ open: [run: RoutineRunRecord] }>();

// Marks the element `data-clipped` while its content overflows; Markdown can
// render after mount, so the content is watched for size changes.
const observers = new WeakMap<HTMLElement, ResizeObserver>();
const vClipFade: Directive<HTMLElement> = {
  mounted(element) {
    const update = () => element.toggleAttribute('data-clipped', element.scrollHeight > element.clientHeight + 1);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    observers.set(element, observer);
    update();
  },
  unmounted(element) {
    observers.get(element)?.disconnect();
    observers.delete(element);
  }
};

// Links and mention chips in a report open themselves, and selecting text to copy it doesn't open the report.
function open(run: RoutineRunRecord, event: MouseEvent): void {
  if ((event.target as Element | null)?.closest('a, button')) return;
  if (window.getSelection()?.toString()) return;
  emit('open', run);
}

function routineOf(run: RoutineRunRecord): RoutineRecord | null {
  return props.routines.find((routine) => routine.routine_id === run.routine_id) ?? null;
}

// Colour only where the user should look.
function statusTone(run: RoutineRunRecord): string {
  if (run.needs_you || run.report_status === 'blocked') return 'text-amber-400';
  if (run.status === 'failed' || run.report_status === 'failed') return 'text-red-400';
  return run.report_status === 'no_findings' ? 'text-muted-foreground/60' : 'text-muted-foreground';
}
</script>
