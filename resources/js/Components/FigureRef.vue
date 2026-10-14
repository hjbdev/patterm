<template>
  <span v-if="figure" class="my-3 block" data-component="figure-ref"><HtmlFigureCard :key="figure.id" :message="figure" /></span>
  <span v-else class="text-muted-foreground" :title="`No page named ${figureId} in this conversation`">{{ text }}</span>
</template>

<script setup lang="ts">
import { computed, inject } from 'vue';
import HtmlFigureCard from './HtmlFigureCard.vue';
import { figuresKey } from '../lib/htmlFigure';

// A [patterm_figure:<id>] token in a reply, drawn from the html_render call
// that defined it earlier in the same conversation.
const props = defineProps<{ figureId: string; text: string }>();
const figures = inject(figuresKey, null);
const figure = computed(() => figures?.value.get(props.figureId) ?? null);
</script>
