<template>
  <!-- Rows for a two-column grid of labels and controls. -->
  <label class="text-xs text-muted-foreground" :for="`${idPrefix}-model`">Model</label>
  <SettingsChoice :id="`${idPrefix}-model`" :model-value="fields.model" :options="modelChoices(catalog, fields.harness)" aria-label="Model" @update:model-value="(value) => changeModel(catalog, fields, value)" />
  <template v-if="fields.model === CUSTOM_MODEL">
    <label class="text-xs text-muted-foreground" :for="`${idPrefix}-custom`">Custom ID</label>
    <Input :id="`${idPrefix}-custom`" v-model="fields.customModel" class="h-8 text-xs" placeholder="claude-opus-4-8" autocomplete="off" />
  </template>
  <label class="text-xs text-muted-foreground" :for="`${idPrefix}-reasoning`">Reasoning</label>
  <SettingsChoice :id="`${idPrefix}-reasoning`" :model-value="fields.reasoning" :options="reasoningChoices(catalog, fields)" aria-label="Reasoning" :disabled="fields.model === DEFAULT_MODEL" @update:model-value="(value) => { fields.reasoning = value; }" />
  <template v-if="fields.harness === 'codex'">
    <label class="text-xs text-muted-foreground" :for="`${idPrefix}-speed`">Speed</label>
    <SettingsChoice :id="`${idPrefix}-speed`" :model-value="fields.serviceTier" :options="speedChoices(catalog, fields)" aria-label="Speed" @update:model-value="(value) => { fields.serviceTier = value; }" />
  </template>
</template>

<script setup lang="ts">
import { CUSTOM_MODEL, DEFAULT_MODEL, changeModel, modelChoices, reasoningChoices, speedChoices, type ModelCatalog, type ProfileFieldsState } from '../lib/profileFields';
import SettingsChoice from './settings/SettingsChoice.vue';
import { Input } from './ui/input';

defineProps<{ catalog: ModelCatalog; idPrefix: string }>();
const fields = defineModel<ProfileFieldsState>('fields', { required: true });
</script>
