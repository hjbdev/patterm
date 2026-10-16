<template>
  <!-- An amber or red wash comes in from the side of a tab or sidebar row that
       needs you: from the icon for the agent itself, from the far end for a
       subagent. The row must be `relative isolate`, so the wash sits above the
       row's background and below its content. -->
  <span v-if="wash" class="tab-wash" :data-tone="wash.tone" :data-side="wash.side" aria-hidden="true" />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { subagentPulse, type Pulse, type RowActivity } from '../lib/rowActivity';

const props = defineProps<{ activity: RowActivity }>();

const wash = computed(() => {
  const self = tone(props.activity.self);
  if (self) return { tone: self, side: 'start' };
  const subagents = tone(subagentPulse(props.activity));
  if (subagents) return { tone: subagents, side: 'end' };
  return null;
});

// A question washes amber like a permission.
function tone(pulse: Pulse | null): 'permission' | 'error' | null {
  if (pulse === 'permission' || pulse === 'question') return 'permission';
  return pulse === 'error' ? 'error' : null;
}
</script>

<style scoped>
.tab-wash {
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: inherit;
  pointer-events: none;
}

.tab-wash[data-tone='permission'][data-side='start'] { background: linear-gradient(90deg, hsl(var(--warning) / 0.2), transparent 70%); }
.tab-wash[data-tone='permission'][data-side='end'] { background: linear-gradient(270deg, hsl(var(--warning) / 0.18), transparent 60%); }
.tab-wash[data-tone='error'][data-side='start'] { background: linear-gradient(90deg, hsl(var(--destructive) / 0.2), transparent 70%); }
.tab-wash[data-tone='error'][data-side='end'] { background: linear-gradient(270deg, hsl(var(--destructive) / 0.18), transparent 60%); }
</style>
