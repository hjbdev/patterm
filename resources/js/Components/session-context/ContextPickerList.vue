<template>
  <Command>
    <!-- The list filters itself rather than through Command, whose filter would
         also hide the create row once its text stops matching the search. -->
    <div class="flex items-center border-b px-3">
      <MagnifyingGlassIcon class="mr-2 h-4 w-4 shrink-0 opacity-50" />
      <ListboxFilter v-model="search" auto-focus :placeholder="placeholder" :aria-label="label" class="flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground" />
    </div>
    <!-- Only the matches scroll, so the create row stays pinned below them. -->
    <CommandList class="max-h-none overflow-visible">
      <div class="max-h-[264px] overflow-y-auto overscroll-contain">
        <CommandGroup v-if="matches.length">
          <CommandItem v-for="item in matches" :key="item.id" :value="item.id" :disabled="disabled || item.selected" class="gap-2 text-[13px]" @select="emit('select', item.id)">
            <span class="min-w-0 flex-1 truncate" :title="item.detail ?? item.label">{{ item.label }}</span>
            <Check v-if="item.selected" class="text-muted-foreground" />
          </CommandItem>
        </CommandGroup>
        <p v-else class="px-3 py-2.5 text-xs text-muted-foreground">{{ search.trim() ? 'No matches.' : emptyText }}</p>
      </div>
      <CommandGroup v-if="createLabel" class="border-t">
        <CommandItem value="create" :disabled="disabled ?? false" class="gap-2 text-[13px]" @select="emit('create', search.trim())">
          <Plus class="text-muted-foreground" />
          <span class="min-w-0 flex-1 truncate">{{ createLabel }}<span v-if="search.trim()" class="text-muted-foreground"> “{{ search.trim() }}”</span></span>
        </CommandItem>
      </CommandGroup>
    </CommandList>
  </Command>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { MagnifyingGlassIcon } from '@radix-icons/vue';
import { Check, Plus } from 'lucide-vue-next';
import { ListboxFilter, useFilter } from 'reka-ui';
import { Command, CommandGroup, CommandItem, CommandList } from '../ui/command';

export interface PickerItem { id: string; label: string; detail?: string; selected: boolean }

const props = withDefaults(defineProps<{
  items: PickerItem[];
  placeholder: string;
  label: string;
  emptyText: string;
  createLabel?: string | undefined;
  disabled?: boolean | undefined;
}>(), { disabled: false });
const emit = defineEmits<{ select: [id: string]; create: [title: string] }>();
const search = defineModel<string>('search', { default: '' });
const { contains } = useFilter({ sensitivity: 'base' });
const matches = computed(() => {
  const query = search.value.trim();
  if (!query) return props.items;
  return props.items.filter(item => contains(item.label, query) || (!!item.detail && contains(item.detail, query)));
});
// The list mounts with an empty search box.
onMounted(() => { search.value = ''; });
</script>
