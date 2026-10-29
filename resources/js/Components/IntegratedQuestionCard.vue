<template>
  <section class="rounded-xl border border-border bg-background p-4 text-sm shadow-sm max-sm:rounded-[18px]" :aria-label="request.questions[0]?.question ?? 'Question'">
    <p v-if="note" class="mb-2 text-xs text-muted-foreground">{{ note }}</p>
    <!-- Several questions show one at a time, as in Claude Code's terminal. A
         phone counts them and steps with Back and Next. -->
    <p v-if="request.questions.length > 1 && phoneLayout" class="mb-0.5 text-xs text-muted-foreground">Question {{ current + 1 }} of {{ request.questions.length }}</p>
    <nav v-else-if="request.questions.length > 1" class="-mx-2 mb-2 flex flex-wrap gap-1" aria-label="Questions">
      <button
        v-for="(item, index) in request.questions"
        :key="item.key"
        type="button"
        class="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs transition-colors hover:bg-muted/40"
        :class="index === current ? 'bg-muted/60 text-foreground' : 'text-muted-foreground'"
        :aria-current="index === current ? 'step' : undefined"
        @click="current = index"
      >
        <Check v-if="answered(item)" class="h-3 w-3" aria-label="Answered" />
        {{ item.header || `Question ${index + 1}` }}
      </button>
    </nav>
    <fieldset v-if="question" :key="question.key">
      <legend class="contents">
        <span v-if="question.header && request.questions.length === 1" class="mb-0.5 block text-xs text-muted-foreground">{{ question.header }}</span>
        <span class="block font-medium text-foreground max-sm:text-[15px] max-sm:leading-snug">{{ question.question }}</span>
      </legend>
      <p v-if="question.multiple" class="mt-0.5 text-xs text-muted-foreground">Choose any that apply.</p>
      <div class="-mx-2 mt-2 space-y-0.5">
        <label
          v-for="option in question.options"
          :key="option.label"
          class="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/40 max-sm:min-h-12 max-sm:rounded-xl max-sm:py-3 max-sm:text-[14.5px]"
          :class="isChosen(question, option.label) && 'bg-muted/40'"
        >
          <Checkbox
            v-if="question.multiple"
            class="mt-0.5"
            :model-value="isChosen(question, option.label)"
            :disabled="disabled"
            @update:model-value="emit('choose', question, option.label, $event === true)"
          />
          <input
            v-else
            :class="RADIO_CLASS"
            type="radio"
            :name="`${request.id}-${question.key}`"
            :checked="isChosen(question, option.label)"
            :disabled="disabled"
            @change="chooseOption(question, option.label)"
          >
          <span class="min-w-0">
            <span class="block text-foreground">{{ option.label }}</span>
            <span v-if="option.description" class="block text-xs text-muted-foreground">{{ option.description }}</span>
          </span>
        </label>
        <!-- Your own answer reads as one more option, with the text as its subtitle. -->
        <label
          v-if="question.custom && question.options.length"
          class="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/40 max-sm:min-h-12 max-sm:rounded-xl max-sm:py-3 max-sm:text-[14.5px]"
          :class="otherChecked(question) && 'bg-muted/40'"
        >
          <Checkbox
            v-if="question.multiple"
            class="mt-0.5"
            :model-value="otherChecked(question)"
            :disabled="disabled"
            @update:model-value="toggleOther(question, $event === true)"
          />
          <input
            v-else
            :class="RADIO_CLASS"
            type="radio"
            :name="`${request.id}-${question.key}`"
            :checked="otherChecked(question)"
            :disabled="disabled"
            @change="toggleOther(question, true)"
          >
          <span class="min-w-0 flex-1">
            <span class="block text-foreground">Something else<template v-if="phoneLayout">…</template></span>
            <input
              ref="otherInput"
              class="block w-full bg-transparent text-xs text-muted-foreground placeholder:text-muted-foreground/70 focus:text-foreground focus:outline-none"
              placeholder="Type your own answer"
              :aria-label="`Your own answer to ${question.question}`"
              :value="custom[question.key] ?? ''"
              :disabled="disabled"
              @focus="otherChosen[question.key] = true"
              @input="emit('custom', question, ($event.target as HTMLInputElement).value)"
              @keydown.enter.prevent="advance"
            >
          </span>
        </label>
        <input
          v-else-if="question.options.length === 0"
          class="block w-full rounded-lg bg-transparent px-2 py-1.5 text-sm transition-colors placeholder:text-muted-foreground hover:bg-muted/40 focus:bg-muted/40 focus:outline-none"
          placeholder="Type your answer"
          :aria-label="`Answer to ${question.question}`"
          :value="custom[question.key] ?? ''"
          :disabled="disabled"
          @input="emit('custom', question, ($event.target as HTMLInputElement).value)"
          @keydown.enter.prevent="advance"
        >
      </div>
    </fieldset>
    <!-- On a phone, the answers and buttons grow to a fingertip. -->
    <div class="mt-3 flex items-center justify-end gap-2 max-sm:flex-wrap">
      <p v-if="attempted && question && !ready(question)" role="alert" class="mr-auto text-xs text-destructive">Answer this question to send.</p>
      <p v-else-if="error" role="alert" class="mr-auto text-xs text-destructive">{{ error }}</p>
      <Button v-if="declinable" size="sm" variant="ghost" :class="ANSWER_BUTTON" :disabled="disabled" @click="emit('decline')">Decline</Button>
      <Button v-if="current > 0" size="sm" variant="ghost" :class="ANSWER_BUTTON" @click="current -= 1">Back</Button>
      <Button v-if="!last" size="sm" :class="ANSWER_BUTTON" :disabled="disabled" @click="current += 1">Next</Button>
      <Button v-else size="sm" :class="ANSWER_BUTTON" :disabled="disabled" @click="send">{{ request.questions.length > 1 ? 'Send answers' : 'Send answer' }}</Button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { Check } from 'lucide-vue-next';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { RADIO_CLASS } from '../lib/utils';
import { phoneLayout } from '../lib/phoneLayout';
import type { IntegratedQuestion, IntegratedQuestionRequest } from '../lib/integratedConversation';


const props = defineProps<{
  request: IntegratedQuestionRequest;
  multiple: Record<string, string[]>;
  single: Record<string, string>;
  custom: Record<string, string>;
  disabled: boolean;
  // Forms shown as questions can be declined, carry who asked, and report
  // their own validation errors.
  declinable?: boolean | undefined;
  note?: string | undefined;
  error?: string | undefined;
}>();

const emit = defineEmits<{
  choose: [question: IntegratedQuestion, label: string, checked: boolean];
  custom: [question: IntegratedQuestion, text: string];
  reply: [];
  decline: [];
}>();

const ANSWER_BUTTON = 'h-7 px-2.5 max-sm:h-12 max-sm:flex-1 max-sm:rounded-xl max-sm:text-[15px]';
const current = ref(0);
// Questions whose "Something else" row is chosen, even before any text is typed.
const otherChosen = ref<Record<string, boolean>>({});
const otherInput = ref<HTMLInputElement | null>(null);
// Set once Send finds a question unanswered, so the note shows only after trying.
const attempted = ref(false);
const question = computed(() => props.request.questions[Math.min(current.value, props.request.questions.length - 1)]);
const last = computed(() => current.value >= props.request.questions.length - 1);

function isChosen(item: IntegratedQuestion, label: string): boolean {
  return item.multiple ? (props.multiple[item.key] ?? []).includes(label) : props.single[item.key] === label;
}

function otherChecked(item: IntegratedQuestion): boolean {
  const chosen = otherChosen.value[item.key] === true || Boolean(props.custom[item.key]?.trim());
  return item.multiple ? chosen : chosen && !props.single[item.key];
}

function chooseOption(item: IntegratedQuestion, label: string): void {
  otherChosen.value = { ...otherChosen.value, [item.key]: false };
  emit('choose', item, label, true);
}

// Choosing the row clears a single answer's option and moves to the text;
// unticking it drops the text from a multiple answer.
function toggleOther(item: IntegratedQuestion, checked: boolean): void {
  otherChosen.value = { ...otherChosen.value, [item.key]: checked };
  if (checked) {
    emit('custom', item, props.custom[item.key] ?? '');
    void nextTick(() => otherInput.value?.focus());
  } else emit('custom', item, '');
}

function answered(item: IntegratedQuestion): boolean {
  if (props.custom[item.key]?.trim()) return true;
  return item.multiple ? (props.multiple[item.key] ?? []).length > 0 : Boolean(props.single[item.key]);
}

function advance(): void {
  if (last.value) send();
  else current.value += 1;
}

function ready(item: IntegratedQuestion): boolean {
  return item.optional === true || answered(item);
}

// Show the first unanswered question instead of sending.
function send(): void {
  const unanswered = props.request.questions.findIndex((item) => !ready(item));
  if (unanswered < 0) {
    emit('reply');
    return;
  }
  current.value = unanswered;
  attempted.value = true;
}
</script>
