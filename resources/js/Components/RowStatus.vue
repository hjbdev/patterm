<template>
  <!-- A tab or row's status in a 14px slot, in place of an icon: the ring at
       rest while nothing runs, a comet circling it while the agent or any of
       its subagents works, and `?`, `✕` or `✓` when it needs permission, has
       an error, or asked to be closed. With subagents, their count sits inside
       the ring and turns amber or red when one needs you. -->
  <span class="relative inline-flex h-3.5 w-3.5 shrink-0" :title="description">
    <span class="row-status-glyph">
      <StatusIcon v-if="mark" :spec="mark" class="h-3.5 w-3.5" aria-hidden="true" />
      <StatusRing v-else :moving="isWorking(activity)" />
    </span>
    <RingCount v-if="ringCount" :count="count!" :class="subagentCountClass(activity)" />
  </span>
  <span class="sr-only">{{ description }}<template v-if="ringCount">, {{ countLabel }}</template></span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { countInRing, describeActivity, isWorking, subagentCountClass, type RowActivity } from '../lib/rowActivity';
import { activityIcon, CLOSING_MARK, DEAD_MARK } from '../lib/statusIcons';
import RingCount from './RingCount.vue';
import StatusIcon from './StatusIcon.vue';
import StatusRing from './StatusRing.vue';

// `count`: the row's subagents and owned processes, shown inside the ring;
// `countLabel` says what they are, for screen readers.
const props = defineProps<{ activity: RowActivity; count?: number | undefined; countLabel?: string | undefined }>();

const mark = computed(() => {
  const self = props.activity.self;
  if (self === 'dead') return DEAD_MARK;
  if (self === 'closing') return CLOSING_MARK;
  return self === 'permission' || self === 'question' || self === 'error' ? activityIcon(self) : null;
});
const ringCount = computed(() => Boolean(props.count) && countInRing(props.activity));
const description = computed(() => describeActivity(props.activity));
</script>

<style scoped>
/* The 16px ring overhangs the 14px slot evenly. */
.row-status-glyph {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
</style>
