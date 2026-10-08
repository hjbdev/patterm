<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button variant="ghost" size="icon" class="h-8 w-8 shrink-0 text-muted-foreground" aria-label="Scratchpad actions"><MoreHorizontal class="h-4 w-4" /></Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      <DropdownMenuItem @select="emit('copy')">Copy as Markdown</DropdownMenuItem>
      <DropdownMenuItem @select="emit('update:status', status === 'archived' ? 'active' : 'archived')">{{ status === 'archived' ? 'Restore' : 'Archive' }}</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem class="text-destructive focus:text-destructive" @select="emit('delete')">Delete scratchpad</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>

<script setup lang="ts">
import { MoreHorizontal } from 'lucide-vue-next';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu';

defineProps<{ status: string }>();
const emit = defineEmits<{ 'update:status': [status: string]; copy: []; delete: [] }>();
</script>
