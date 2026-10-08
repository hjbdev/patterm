<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button variant="ghost" size="sm" class="h-8 max-w-48 gap-1.5 px-2 text-xs text-muted-foreground" aria-label="Filter by assignee">
        <span class="truncate">{{ modelValue ? assigneeName(modelValue) : 'Everyone' }}</span><ChevronDown class="h-3.5 w-3.5 shrink-0" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="max-h-72 w-56 overflow-y-auto">
      <DropdownMenuRadioGroup :model-value="modelValue" @update:model-value="emit('update:modelValue', String($event))">
        <DropdownMenuRadioItem value="">Everyone</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="user">You</DropdownMenuRadioItem>
        <DropdownMenuRadioItem v-for="session in sessions" :key="session.id" :value="session.id"><span class="truncate">{{ assigneeName(session.id) }}</span></DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>
</template>

<script setup lang="ts">
import { ChevronDown } from 'lucide-vue-next';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { useAssignees } from '../../Composables/useContextRecord';

defineProps<{ modelValue: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const { sessions, assigneeName } = useAssignees();
</script>
