<template>
  <StatusIcon v-if="spec.spinner" :spec="spec" class="h-3.5 w-3.5 shrink-0 text-purple-400" />
  <template v-else>
    <!-- Compact tabs show a status glyph in place of the icon. -->
    <slot v-if="!compact || spec.ring" />
    <span class="sr-only">{{ spec.label }}</span>
    <StatusIcon v-if="!spec.ring" :spec="spec" class="h-3.5 w-3.5 shrink-0" />
  </template>
</template>

<script setup lang="ts">
import type { IconSpec } from '../lib/statusIcons';
import StatusIcon from './StatusIcon.vue';
defineProps<{ spec: IconSpec; compact?: boolean }>();
</script>
