<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <slot />
    </PopoverTrigger>
    <PopoverContent :align="align ?? 'end'" class="w-72 max-w-[calc(100vw-2rem)] p-0">
      <ContextPickerList v-model:search="search" :items="items" :placeholder="placeholder" :label="label" :empty-text="emptyText" :create-label="createLabel" :disabled="disabled" @select="select" @create="create" />
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import ContextPickerList, { type PickerItem } from './ContextPickerList.vue';

withDefaults(defineProps<{
  items: PickerItem[];
  placeholder: string;
  label: string;
  emptyText: string;
  createLabel?: string | undefined;
  disabled?: boolean | undefined;
  align?: 'start' | 'center' | 'end' | undefined;
}>(), { align: 'end', disabled: false });
const emit = defineEmits<{ select: [id: string]; create: [title: string] }>();
const open = defineModel<boolean>('open', { default: false });
// Server-side searches follow this; the list also filters as you type.
const query = defineModel<string>('query', { default: '' });
const search = ref('');
watch(search, value => { query.value = value; });
watch(open, (value) => { if (value) search.value = ''; });

function select(id: string) {
  open.value = false;
  emit('select', id);
}
function create(title: string) {
  open.value = false;
  emit('create', title);
}
</script>
