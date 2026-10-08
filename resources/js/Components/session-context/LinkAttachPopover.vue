<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <slot />
    </PopoverTrigger>
    <PopoverContent :align="align ?? 'end'" class="w-72 max-w-[calc(100vw-2rem)] overflow-hidden p-0">
      <LinkAttachForm :busy="busy" @attach="attach" />
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import LinkAttachForm from './LinkAttachForm.vue';

withDefaults(defineProps<{ busy?: boolean | undefined; align?: 'start' | 'center' | 'end' | undefined }>(), { busy: false, align: 'end' });
const emit = defineEmits<{ attach: [url: string, done: (saved: boolean) => void] }>();
const open = defineModel<boolean>('open', { default: false });

function attach(url: string, done: (saved: boolean) => void) {
  emit('attach', url, (saved) => {
    done(saved);
    if (saved) open.value = false;
  });
}
</script>
