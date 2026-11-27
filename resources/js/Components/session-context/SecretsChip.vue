<template>
  <!-- The agent's secrets, with a dot while it waits for one. A new request
       opens the list without taking focus, so typing carries on where it was;
       a form opens only when a row is chosen. Pinned beside the conversation,
       opening it points at its tile instead. -->
  <ResponsivePopover v-if="secrets.length" v-model:open="open" title="Secrets" content-class="w-[22rem]" :keep-focus="requestOpened">
    <template #trigger>
      <button type="button" :class="CHIP" v-bind="trigger"><KeyRound :class="CHIP_ICON" /><span :class="CHIP_LABEL">{{ secrets.length === 1 ? '1 secret' : `${secrets.length} secrets` }}</span><span v-if="requested" class="h-1.5 w-1.5 rounded-full bg-foreground" aria-label="needs you" /><ChipUnpin v-if="pinned" title="Secrets" @unpin="emit('unpin')" /></button>
    </template>
    <slot name="bar" />
    <ContextSecrets dense :process-id="processId" />
  </ResponsivePopover>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { KeyRound } from 'lucide-vue-next';
import ChipUnpin from './ChipUnpin.vue';
import ResponsivePopover from '../ResponsivePopover.vue';
import ContextSecrets from './ContextSecrets.vue';
import { CHIP, CHIP_ICON, CHIP_LABEL } from './rowAction';
import { takeFreshRequests } from '../../lib/secretRequests';
import { useSessionSecrets } from '../../lib/secrets';

// `trigger` adds the header's pinning to the chip itself.
const props = defineProps<{ processId: string; trigger?: Record<string, unknown> | undefined; pinned?: boolean | undefined }>();
const emit = defineEmits<{ unpin: [] }>();
const open = defineModel<boolean>('open', { default: false });
const state = useSessionSecrets(() => props.processId);
const secrets = computed(() => state.value?.secrets ?? []);
const requested = computed(() => secrets.value.some((secret) => secret.status === 'requested'));

// Opened by a request rather than by the user, until the user opens it.
const requestOpened = ref(false);
let opening = false;
watch(secrets, (list) => {
  if (!takeFreshRequests(list).length || open.value) return;
  requestOpened.value = opening = true;
  open.value = true;
}, { immediate: true });
watch(open, (value) => {
  if (value && !opening) requestOpened.value = false;
  opening = false;
});
</script>
