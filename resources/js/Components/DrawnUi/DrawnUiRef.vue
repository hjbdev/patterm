<template>
  <span v-if="figure" class="my-3 block" data-component="drawn-ui-ref"><DrawnUiCard :key="figure.id" :message="figure" /></span>
  <span v-else class="text-muted-foreground" :title="`No figure named ${figureId} in this conversation`">{{ text }}</span>
</template>

<script setup lang="ts">
import { computed, inject } from 'vue';
import DrawnUiCard from './DrawnUiCard.vue';
import { drawnUiFiguresKey } from '../../lib/drawnUi';

// A [patterm_figure:<id>] token in a reply, drawn from the ui.save call
// that defined it earlier in the same conversation.
const props = defineProps<{ figureId: string; text: string }>();
const figures = inject(drawnUiFiguresKey, null);
const figure = computed(() => figures?.value.get(props.figureId) ?? null);
</script>
