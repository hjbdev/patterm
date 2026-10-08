<template>
  <div class="min-w-0">
    <p class="mb-2.5 pr-16 font-semibold leading-snug">{{ claim }}</p>
    <DrawnUiInputs v-if="section.inputs?.length" :inputs="section.inputs" :values="values" />
    <DrawnFigure :figure="figure" :images="images" />
    <p v-if="section.source" class="mt-2 text-xs text-muted-foreground/70">{{ section.source }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive } from 'vue';
import DrawnFigure from './DrawnFigure.vue';
import DrawnUiInputs from './DrawnUiInputs.vue';
import { fillClaim, resolveFormulas, sectionVars, type DrawnSection, type DrawnUi } from '../../../../app/Services/DrawnUi';

const props = defineProps<{ section: DrawnSection; images: Record<string, string>; shared?: Pick<DrawnUi, 'inputs' | 'constants'>; sharedValues?: Record<string, number> }>();
const values = reactive<Record<string, number>>(Object.fromEntries((props.section.inputs ?? []).map((input) => [input.id, input.value])));
const vars = computed(() => sectionVars(props.section, { ...props.sharedValues, ...values }, props.shared));
const dynamic = computed(() => Boolean(props.section.inputs?.length || props.section.constants || props.shared?.inputs?.length || props.shared?.constants));
const claim = computed(() => dynamic.value ? fillClaim(props.section.claim, vars.value) : props.section.claim);
const figure = computed(() => dynamic.value ? resolveFormulas(props.section.figure, vars.value) : props.section.figure);
</script>
