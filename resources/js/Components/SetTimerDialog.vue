<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Set timer</DialogTitle>
        <DialogDescription>
          Send a reminder to {{ props.targetName || 'this process' }} when the timer fires.
        </DialogDescription>
      </DialogHeader>

      <form class="flex flex-col gap-4" @submit.prevent="submit">
        <div class="flex flex-col gap-2">
          <label class="text-xs font-medium text-muted-foreground">Duration</label>
          <div class="flex flex-wrap gap-2">
            <Button v-for="preset in presets" :key="preset.value" type="button" variant="secondary" size="sm" @click="duration = preset.value">
              {{ preset.label }}
            </Button>
          </div>
          <Input ref="durationInput" v-model="duration" placeholder="30s, 5m, 1h" />
        </div>

        <div class="flex flex-col gap-1.5">
          <label class="text-xs font-medium text-muted-foreground">Label <span class="font-normal">(optional)</span></label>
          <Input v-model="label" placeholder="Review build output" />
        </div>

        <div class="flex flex-col gap-1.5">
          <label class="text-xs font-medium text-muted-foreground">Prompt <span class="font-normal">(optional)</span></label>
          <Textarea v-model="body" class="min-h-24" placeholder="Blank uses the default reminder prompt." />
        </div>

        <p v-if="error" class="text-sm text-destructive">{{ error }}</p>

        <DialogFooter>
          <Button type="submit" :disabled="busy || !props.targetProcessId">{{ busy ? 'Setting…' : 'Set timer' }}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { useAutofocus } from '../Composables/useAutofocus';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { parseDurationSeconds } from '../lib/timers';

const props = withDefaults(
  defineProps<{
    targetProcessId?: string | null;
    targetName?: string | null;
  }>(),
  {
    targetProcessId: null,
    targetName: null
  }
);
const emit = defineEmits<{ submitted: [] }>();
const open = defineModel<boolean>('open', { default: false });

const presets = [
  { label: '30s', value: '30s' },
  { label: '1m', value: '1m' },
  { label: '5m', value: '5m' },
  { label: '15m', value: '15m' }
];

const durationInput = ref<{ $el?: unknown } | null>(null);
const duration = ref('5m');
const label = ref('');
const body = ref('');
const busy = ref(false);
const error = ref('');

useAutofocus(open, durationInput);

watch(open, (isOpen) => {
  if (!isOpen) {
    return;
  }
  duration.value = '5m';
  label.value = '';
  body.value = '';
  error.value = '';
});

async function submit(): Promise<void> {
  if (busy.value || !props.targetProcessId) {
    return;
  }

  const seconds = parseDurationSeconds(duration.value);
  if (seconds === null || seconds <= 0) {
    error.value = 'Enter a duration like 30s, 5m, or 1h.';
    return;
  }

  busy.value = true;
  error.value = '';
  try {
    await window.patterm.timerSet({
      owner_process_id: props.targetProcessId,
      seconds,
      label: label.value.trim() || undefined,
      body: body.value.trim() || undefined
    });
    open.value = false;
    emit('submitted');
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    busy.value = false;
  }
}
</script>
