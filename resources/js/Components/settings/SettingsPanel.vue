<template>
  <!-- A query container: the panel's sections and rows respond to its width. -->
  <section class="[container-type:inline-size]">
    <header class="flex flex-col gap-3 border-b border-white/[0.06] pb-5 [@container(min-width:36rem)]:flex-row [@container(min-width:36rem)]:items-start [@container(min-width:36rem)]:justify-between">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <h2 class="text-[15px] font-semibold">{{ title }}</h2>
          <SettingsSaveStatus v-if="soloScope" :scope="soloScope" />
        </div>
        <p v-if="description || $slots.description" class="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground"><slot name="description">{{ description }}</slot></p>
      </div>
      <div v-if="$slots.actions" class="flex shrink-0 flex-wrap items-center gap-2"><slot name="actions" /></div>
    </header>
    <div class="divide-y divide-white/[0.06]"><slot /></div>
  </section>
</template>

<script setup lang="ts">
import { computed, provide, reactive } from 'vue';
import { settingsPanelSections } from './panelContext';
import SettingsSaveStatus from './SettingsSaveStatus.vue';

defineProps<{ title: string; description?: string }>();

const sections = reactive(new Map<symbol, string | undefined>());
provide(settingsPanelSections, sections);

// A lone section has no heading, so its save status shows beside the title.
const soloScope = computed(() => sections.size === 1 ? [...sections.values()][0] : undefined);
</script>
