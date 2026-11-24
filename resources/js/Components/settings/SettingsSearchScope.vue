<template>
  <div v-show="visible"><slot /></div>
</template>

<script setup lang="ts">
import { watch } from 'vue';
import { useSettingsSearch } from './settingsSearch';

// Wraps one settings page in search results. Its keywords match the whole page,
// such as "tailscale" for Remote access, and it reports what matched inside.
const props = defineProps<{ label: string; keywords?: string | undefined }>();
const emit = defineEmits<{ result: [{ hit: boolean; matches: number }] }>();

const { visible, hit, matches } = useSettingsSearch(() => [props.label, props.keywords]);
watch([hit, matches], ([nextHit, nextMatches]) => emit('result', { hit: nextHit, matches: nextMatches }), { immediate: true });
</script>
