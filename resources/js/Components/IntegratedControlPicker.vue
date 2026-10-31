<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button type="button" variant="ghost" size="sm" class="h-8 max-w-56 gap-1 px-2 text-xs font-medium text-muted-foreground hover:text-foreground" :disabled="disabled" :aria-label="`${selector.label}: ${selectedLabel}`">
        <span class="truncate">{{ selectedLabel }}</span>
        <ChevronsUpDown class="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" class="w-80 max-w-[calc(100vw-2rem)] p-0">
      <Command>
        <CommandInput :placeholder="`Search ${selector.label.toLowerCase()}…`" :aria-label="`Search ${selector.label.toLowerCase()}`" />
        <CommandList class="max-h-72">
          <CommandEmpty>No matching {{ selector.label.toLowerCase() }}.</CommandEmpty>
          <CommandGroup :heading="selector.label">
            <CommandItem v-for="option in selector.options" :key="option.value" :value="`${option.label} ${option.description ?? ''} ${option.value}`" @select="choose(option.value)">
              <span class="min-w-0 flex-1 truncate">{{ option.label }}</span>
              <span v-if="option.description" class="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">{{ option.description }}</span>
              <Check v-if="option.value === selector.value" class="h-4 w-4 shrink-0" aria-hidden="true" />
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { Check, ChevronsUpDown } from 'lucide-vue-next';
import { Button } from './ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from './ui/command';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

const props = defineProps<{
  selector: { id: string; label: string; value: string; options: Array<{ value: string; label: string; description?: string }> };
  disabled: boolean;
}>();
const emit = defineEmits<{ select: [value: string] }>();
const open = ref(false);
const selectedLabel = computed(() => props.selector.options.find((option) => option.value === props.selector.value)?.label ?? props.selector.label);

function choose(value: string): void {
  open.value = false;
  if (value !== props.selector.value) emit('select', value);
}
</script>
