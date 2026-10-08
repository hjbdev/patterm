<template>
  <!-- A lone section spans the panel. Otherwise wide panels put each heading in a
       left column, and narrow ones stack it above the settings. -->
  <section v-if="solo" class="py-6">
    <p v-if="description || $slots.description" class="mb-4 text-xs leading-relaxed text-muted-foreground"><slot name="description">{{ description }}</slot></p>
    <div v-if="$slots.actions" class="mb-4 flex flex-wrap items-center gap-2"><slot name="actions" /></div>
    <div :class="contentClass"><slot /></div>
  </section>
  <section v-else class="grid grid-cols-1 gap-x-8 gap-y-4 py-7 [@container(min-width:40rem)]:grid-cols-[168px_minmax(0,1fr)]">
    <div class="min-w-0">
      <div class="flex items-center gap-2">
        <h3 class="flex items-center gap-2 text-[13px] font-medium"><slot name="title">{{ title }}</slot></h3>
        <SettingsSaveStatus v-if="scope" :scope="scope" />
      </div>
      <p v-if="description || $slots.description" class="mt-1 text-xs leading-relaxed text-muted-foreground"><slot name="description">{{ description }}</slot></p>
      <div v-if="$slots.actions" class="mt-3 flex flex-wrap items-center gap-2"><slot name="actions" /></div>
    </div>
    <div :class="contentClass"><slot /></div>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, onBeforeUnmount, watch } from 'vue';
import { settingsPanelSections } from './panelContext';
import SettingsSaveStatus from './SettingsSaveStatus.vue';

// `scope` is the save-key prefix of the settings inside; the heading shows
// their save status. `list` frames a list of items, such as sources or servers.
const props = defineProps<{ title?: string; description?: string; scope?: string; list?: boolean }>();

const sections = inject(settingsPanelSections, null);
const id = Symbol('settings-section');
sections?.set(id, props.scope);
watch(() => props.scope, (scope) => sections?.set(id, scope));
onBeforeUnmount(() => sections?.delete(id));

const solo = computed(() => sections?.size === 1);
// Rows and items inside respond to the width of this column.
const contentClass = computed(() => ['min-w-0 [container-type:inline-size]', props.list ? 'divide-y divide-white/[0.06] self-start rounded-lg border border-white/[0.06]' : 'space-y-5']);
</script>
