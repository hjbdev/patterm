<template>
  <fieldset>
    <legend class="text-xs text-muted-foreground">{{ label }}</legend>
    <div v-if="rows.length" class="mt-2 space-y-2">
      <div v-for="(row, index) in rows" :key="index" class="flex items-center gap-2">
        <Input :model-value="row.key" class="h-8 w-2/5 font-mono text-xs" :placeholder="keyPlaceholder" :aria-label="`${label} ${index + 1} name`" autocomplete="off" @update:model-value="update(index, { key: String($event) })" />
        <Input :model-value="row.value" class="h-8 flex-1 font-mono text-xs" :placeholder="valuePlaceholder" :aria-label="`${label} ${index + 1} value`" autocomplete="off" @update:model-value="update(index, { value: String($event) })" />
        <Button type="button" size="icon" variant="ghost" class="h-8 w-8 shrink-0 text-muted-foreground" :aria-label="`Remove ${label.toLowerCase()} ${index + 1}`" @click="removeRow(index)">
          <X class="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
    <Button type="button" size="sm" variant="outline" class="mt-2 h-7 px-2 text-[11px]" @click="emit('update:modelValue', [...rows, { key: '', value: '' }])">{{ addLabel }}</Button>
  </fieldset>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { X } from 'lucide-vue-next';
import { Button } from './ui/button';
import { Input } from './ui/input';
import type { KeyValueRow } from '../lib/mcpServers';

const props = defineProps<{
  modelValue: KeyValueRow[];
  label: string;
  keyPlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
}>();
const emit = defineEmits<{ 'update:modelValue': [rows: KeyValueRow[]] }>();
const rows = computed(() => props.modelValue);

function update(index: number, change: Partial<KeyValueRow>): void {
  emit('update:modelValue', rows.value.map((row, current) => current === index ? { ...row, ...change } : row));
}

function removeRow(index: number): void {
  emit('update:modelValue', rows.value.filter((_, current) => current !== index));
}
</script>
