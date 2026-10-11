<template>
  <!-- A card beside the agent you point at in the list, saying where it stands. -->
  <Popover :open="Boolean(card.row.value)" @update:open="(open: boolean) => { if (!open) card.dismiss(); }">
    <PopoverContent
      data-agent-card
      :reference="anchor"
      side="right"
      align="start"
      :side-offset="16"
      :align-offset="-6"
      :collision-padding="8"
      hide-when-detached
      class="w-80 p-0 shadow-lg"
      @pointerenter="card.onCardEnter"
      @pointerleave="card.onCardLeave"
      @click.capture="onCardClick"
      @open-auto-focus.prevent
      @close-auto-focus.prevent
      @focus-outside.prevent
    >
      <AgentCard v-if="shown" :key="shown.key" :digest="shown" :now="now" class="max-h-[min(34rem,var(--reka-popover-content-available-height))]" />
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue';
import { useEventListener } from '@vueuse/core';
import { useAgentDigests } from '../../Composables/useAgentDigests';
import { useBoardRoute } from '../../Composables/useBoard';
import { useRowHoverCard } from '../../Composables/useRowHoverCard';
import { Popover, PopoverContent } from '../ui/popover';
import AgentCard from './AgentCard.vue';

// The list the card watches for pointing and keyboard focus.
const props = defineProps<{ list: HTMLElement | null }>();
const { digests, now, show } = useAgentDigests();
const board = useBoardRoute();

// Agents have cards. Subagents and processes are rows of their own, which
// the card lists anyway. The controls laid over a row count as the row.
function agentRow(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const row = target.closest('[data-sidebar-block]')?.querySelector<HTMLElement>('[data-family]');
  return row?.parentElement?.contains(target) ? row : null;
}
const card = useRowHoverCard(agentRow, () => document.querySelector<HTMLElement>('[data-agent-card]'));
// An open card keeps its agent's todos, links and diff fresh.
show(() => Boolean(card.row.value));
const shown = computed(() => digests.value.find((digest) => digest.key === card.last.value?.dataset.rowKey) ?? null);
const anchor = computed(() => card.last.value ?? document.body);

// The board already shows every agent.
useEventListener(() => props.list, 'pointermove', (event: PointerEvent) => {
  if (!board.open.value) card.onPointerMove(event);
});
useEventListener(() => props.list, 'focusin', (event: FocusEvent) => {
  if (!board.open.value) card.onFocusIn(event);
});
useEventListener(() => props.list, 'pointerleave', card.onPointerLeave);
useEventListener(() => props.list, 'pointerdown', card.onPointerDown);
useEventListener(() => props.list, 'focusout', card.onFocusOut);
watch(board.open, (open) => {
  if (open) card.close();
});

// Opening a subagent, a process or a link from the card puts it away.
function onCardClick(event: MouseEvent): void {
  if (event.target instanceof Element && event.target.closest('button, a')) card.close();
}
</script>
