<template>
  <!-- Brings back the Get started checklist after it was hidden. -->
  <DropdownMenuItem v-if="status?.dismissed" class="text-[14px]" @select="restore()">
    <ListChecks class="mr-2 h-4 w-4 text-muted-foreground" />Get started
  </DropdownMenuItem>
</template>

<script setup lang="ts">
import { ListChecks } from 'lucide-vue-next';
import { useOnboarding } from '../Composables/useOnboarding';
import { DropdownMenuItem } from './ui/dropdown-menu';

const { status, restore } = useOnboarding();
</script>
