<template>
  <!-- A row's icon. While its agent works a spinner takes its place, at half
       strength when only subagents work; hovering the row fades the icon back
       in over the dimmed spinner. `?`, `✕` and `✓` mark an agent that needs
       permission, has an error, or asked to be closed; compact rows show only the mark. `muted`
       dims an icon that isn't working. -->
  <span v-if="!compact || !mark" :class="cn('relative inline-flex shrink-0', muted && 'text-muted-foreground')" :title="description">
    <span class="tab-icon-face inline-flex" :data-spinning="spinning ? '' : undefined"><slot :working="working" /></span>
    <ArcSpinner v-if="spinning" :data-faint="working ? undefined : ''" class="tab-icon-spinner" />
  </span>
  <StatusIcon v-if="mark" :spec="mark" class="h-3.5 w-3.5" aria-hidden="true" />
  <span class="sr-only">{{ description }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { cn } from '@/lib/utils';
import { describeActivity, type RowActivity } from '../lib/rowActivity';
import { activityIcon, type IconSpec } from '../lib/statusIcons';
import ArcSpinner from './ArcSpinner.vue';
import StatusIcon from './StatusIcon.vue';

const CLOSING_MARK: IconSpec = { glyph: '✓', class: 'text-foreground/75', spin: false, label: 'Ready to close' };

const props = defineProps<{ activity: RowActivity; compact?: boolean | undefined; muted?: boolean | undefined }>();

const working = computed(() => props.activity.self === 'working');
const spinning = computed(() => working.value || ((props.activity.self === 'idle' || props.activity.self === 'unknown') && props.activity.subagents.working > 0));
const mark = computed(() => {
  const self = props.activity.self;
  if (self === 'closing') return CLOSING_MARK;
  return self === 'permission' || self === 'error' ? activityIcon(self) : null;
});
const description = computed(() => describeActivity(props.activity));
</script>

<style scoped>
/* The spinner is 16px, centred under an icon of 14 or 16px. */
.tab-icon-spinner {
  position: absolute;
  left: 50%;
  top: 50%;
  margin: -8px 0 0 -8px;
  transition: opacity 150ms ease-out;
}

.tab-icon-spinner[data-faint] {
  opacity: 0.5;
}

.tab-icon-face[data-spinning] {
  position: relative;
  z-index: 1;
  opacity: 0;
  transition: opacity 150ms ease-out;
}

button:hover .tab-icon-face[data-spinning] {
  opacity: 1;
}

button:hover .tab-icon-spinner {
  opacity: 0.3;
}

@media (prefers-reduced-motion: reduce) {
  .tab-icon-spinner,
  .tab-icon-face[data-spinning] {
    transition: none;
  }
}
</style>
