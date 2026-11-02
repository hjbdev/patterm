<template>
  <!-- The routine as editable sentences: each underlined word opens its options. -->
  <div class="space-y-3 text-[13px] leading-8 text-muted-foreground">
    <p>
      Run
      <InlineChoice :model-value="routine.run_at ? 'once' : 'repeat'" :options="REPEAT_OPTIONS" label="Repeat" @update:model-value="setRepeat($event)" />
      <template v-if="routine.run_at">
        on <RoutineOncePicker :date="onceDate(routine)" :time="routine.time" :timezone="routine.timezone" class="mx-1 inline-flex align-middle" @change="emit('change', $event)" />
      </template>
      <template v-else>
        on <RoutineDaysPicker :days="routine.days" :time="routine.time" class="mx-1 inline-flex align-middle" @update:days="emit('change', { days: $event })" @update:time="emit('change', { time: $event })" />
      </template>
    </p>
    <p>
      Start
      <InlineChoice :model-value="routine.harness" :options="harnessOptions" label="Harness" @update:model-value="$event && emit('change', harnessPatch($event))" />
      with
      <InlineChoice :model-value="launchChoiceKey(routine)" :options="launchChoiceOptions(routine.harness, presets, models)" label="Preset or model" @update:model-value="emit('change', launchChoicePatch(routine, $event ?? 'preset:', models))" />
      <template v-if="routine.model && reasoning.length > 1">
        at
        <InlineChoice :model-value="routine.reasoning" :options="reasoning" label="Effort" @update:model-value="emit('change', { reasoning: $event })" />
        effort<template v-if="speed.length">,
          <InlineChoice :model-value="routine.service_tier" :options="speed" label="Speed" @update:model-value="emit('change', { service_tier: $event })" />
        </template>
      </template>
      in
      <InlineChoice :model-value="routine.project_id" :options="projectOptions(projects)" label="Project" @update:model-value="emit('change', { project_id: $event })" />
      and ask it to:
    </p>
    <RoutinePromptField :model-value="routine.prompt" field-class="min-h-24 text-foreground" @update:model-value="emit('change', { prompt: $event })" />
    <p>
      When it reports,
      <InlineChoice :model-value="routine.delivery" :options="DELIVERY_OPTIONS" label="When it reports" @update:model-value="emit('change', { delivery: $event === 'none' || $event === 'assistant' ? $event : 'notification' })" />
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import InlineChoice from './InlineChoice.vue';
import RoutineDaysPicker from './RoutineDaysPicker.vue';
import RoutineOncePicker from './RoutineOncePicker.vue';
import { zonedInstant } from '../../../../app/Services/RoutineSchedule';
import RoutinePromptField from './RoutinePromptField.vue';
import { harnessLabel } from '../../lib/harnesses';
import {
  DELIVERY_OPTIONS, harnessPatch, launchChoiceKey, launchChoiceOptions, launchChoicePatch, modelFor, onceDate, projectOptions, reasoningOptions, speedOptions,
  type RoutineModelOption, type RoutinePatch, type RoutinePresetOption, type RoutineRecord
} from '../../lib/routines';

const props = defineProps<{
  routine: RoutineRecord;
  harnesses: readonly string[];
  projects: ReadonlyArray<{ id: string; name: string }>;
  presets: RoutinePresetOption[];
  models: Record<string, RoutineModelOption[]>;
}>();
const emit = defineEmits<{ change: [patch: RoutinePatch] }>();

// A harness that is no longer installed stays listed so the sentence still reads correctly.
const harnessOptions = computed(() => [...new Set([...props.harnesses, props.routine.harness])].map((harness) => ({ value: harness, label: harnessLabel(harness) })));
const model = computed(() => modelFor(props.routine.harness, props.routine.model, props.models));
const reasoning = computed(() => reasoningOptions(model.value));
const speed = computed(() => speedOptions(model.value));

const REPEAT_OPTIONS = [{ value: 'repeat', label: 'every week' }, { value: 'once', label: 'once' }];

// Once starts tomorrow at the routine's time; repeating again keeps its days, or weekdays if it had none.
function setRepeat(value: string | null): void {
  if (value === 'once' && !props.routine.run_at) {
    const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString('en-CA', { timeZone: props.routine.timezone });
    const at = zonedInstant(tomorrow, props.routine.time, props.routine.timezone);
    if (at !== null) emit('change', { run_at: new Date(at).toISOString() });
  } else if (value === 'repeat' && props.routine.run_at) {
    emit('change', { run_at: null, ...(props.routine.days.length ? {} : { days: [1, 2, 3, 4, 5] }) });
  }
}
</script>
