<template>
  <div class="min-w-0">
    <p v-if="choice.question" class="mb-2 font-medium">{{ choice.question }}</p>

    <!-- A queue: one item at a time, answered with buttons or keys. -->
    <div v-if="choice.items" ref="queueRef" class="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50" tabindex="0" aria-label="Answer each item" @keydown="onKey">
      <div class="mb-3 h-[3px] overflow-hidden rounded bg-border"><i class="block h-full bg-foreground transition-[width] duration-200 motion-reduce:transition-none" :style="{ width: `${progress * 100}%` }" /></div>
      <template v-if="queueIndex < choice.items.length && !locked">
        <p class="text-xs text-muted-foreground">{{ queueIndex + 1 }} of {{ choice.items.length }}<template v-if="currentItem?.meta"> · {{ currentItem.meta }}</template></p>
        <p class="my-2 whitespace-pre-wrap break-words rounded-md bg-muted/40 px-3 py-2">{{ currentItem?.body }}</p>
        <div class="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" class="h-7 px-2.5 text-xs" v-for="option in choice.options" :key="option.value" :disabled="!canAnswer" @click="answerItem(option.value)">
            {{ option.label }}<span v-if="option.key" class="font-mono text-[10px] text-muted-foreground">{{ option.key.toUpperCase() }}</span>
          </Button>
          <Button v-if="queueIndex > 0" size="sm" variant="ghost" class="ml-auto h-7 px-2.5 text-xs text-muted-foreground" @click="queueIndex--">Back</Button>
        </div>
      </template>
      <template v-else>
        <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
          <template v-for="(item, index) in choice.items" :key="item.id">
            <dt class="font-mono text-muted-foreground">{{ item.id }}</dt>
            <dd class="m-0">{{ labelOf(queueValues[index]) ?? '—' }}</dd>
          </template>
        </dl>
        <div v-if="!locked" class="mt-3 flex gap-2">
          <Button size="sm" class="h-7 px-2.5 text-xs" :disabled="!canAnswer || sending" @click="sendQueue">Send {{ choice.items.length }} answers</Button>
          <Button size="sm" variant="ghost" class="h-7 px-2.5 text-xs text-muted-foreground" @click="queueIndex--">Back</Button>
        </div>
      </template>
    </div>

    <!-- Options with trade-offs read side by side. -->
    <div v-else-if="detailed" class="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]">
      <div v-for="(option, index) in choice.options" :key="option.value" class="flex min-w-0 flex-col py-1 pr-3.5" :class="[index ? 'border-l border-border pl-3.5 max-sm:border-l-0 max-sm:border-t max-sm:pl-0 max-sm:pt-3' : '', locked && !chosen.has(option.value) ? 'opacity-45' : '']">
        <p class="flex items-baseline gap-2 font-semibold">{{ option.label }}<span v-if="option.pick" class="rounded-full border border-[var(--drawn-accent)] px-1.5 text-[10px] font-normal text-[var(--drawn-accent)]">pick</span><span v-if="chosen.has(option.value)" class="text-[10px] font-normal text-muted-foreground">chosen</span></p>
        <p v-if="option.detail" class="mt-0.5 text-xs text-muted-foreground">{{ option.detail }}</p>
        <ul class="mb-2 mt-1.5 flex-1 space-y-0.5 text-xs text-muted-foreground">
          <li v-for="pro in option.pros ?? []" :key="`p${pro}`" class="flex gap-1.5"><span class="text-[var(--drawn-good)]" aria-label="Pro">+</span>{{ pro }}</li>
          <li v-for="con in option.cons ?? []" :key="`c${con}`" class="flex gap-1.5"><span class="text-[var(--drawn-bad)]" aria-label="Con">−</span>{{ con }}</li>
        </ul>
        <Button v-if="choice.ask && !locked" size="sm" variant="outline" class="h-7 self-start px-2.5 text-xs" :disabled="!canAnswer || sending" @click="sendOne(option.value)">Choose</Button>
      </div>
    </div>

    <!-- A plain list, optionally asking for one pick. -->
    <div v-else class="space-y-0.5" :role="choice.ask ? 'radiogroup' : 'list'" :aria-label="choice.question ?? 'Options'">
      <label
        v-for="option in choice.options"
        :key="option.value"
        class="flex items-start gap-3 rounded-lg px-2 py-1.5 transition-colors"
        :class="[choice.ask && !locked ? 'cursor-pointer hover:bg-muted/40' : '', isPicked(option.value) ? 'bg-muted/40' : '', locked && !chosen.has(option.value) ? 'opacity-45' : '']"
      >
        <input v-if="choice.ask" v-model="selected" :class="RADIO_CLASS" type="radio" :name="uid" :value="option.value" :checked="isPicked(option.value)" :disabled="locked || !canAnswer">
        <span class="min-w-0 flex-1"><span class="block">{{ option.label }}</span><span v-if="option.detail" class="block text-xs text-muted-foreground">{{ option.detail }}</span></span>
        <span v-if="option.pick" class="rounded-full border border-[var(--drawn-accent)] px-1.5 text-[10px] text-[var(--drawn-accent)]">my pick</span>
      </label>
      <Button v-if="choice.ask && !locked" size="sm" class="mt-2 h-7 px-2.5 text-xs" :disabled="!selected || !canAnswer || sending" @click="selected && sendOne(selected)">Send choice</Button>
    </div>

    <p v-if="note" class="mt-2 text-xs text-muted-foreground" role="status">{{ note }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, ref, useId } from 'vue';
import { Button } from '../ui/button';
import { RADIO_CLASS } from '../../lib/utils';
import { answeredValues, drawnUiAnswerText, type DrawnChoice } from '../../../../app/Services/DrawnUi';
import { drawnUiAnswerKey, drawnUiAnsweredKey } from '../../lib/drawnUi';

const props = defineProps<{ choice: DrawnChoice }>();
const channel = inject(drawnUiAnswerKey, null);
const answers = inject(drawnUiAnsweredKey, null);

const selected = ref<string | null>(null);
const uid = useId();
const sending = ref(false);
const error = ref('');
const queueIndex = ref(0);
const queueAnswers = ref<string[]>([]);
const queueRef = ref<HTMLElement | null>(null);

// The answer's own message, in the transcript or the agent's queue, locks the
// card from the moment it is sent and on every reload; a failed send unlocks it.
const answeredText = computed(() => props.choice.id ? answers?.value.get(props.choice.id) ?? channel?.queued.value.get(props.choice.id) ?? null : null);
const locked = computed(() => Boolean(answeredText.value));
const chosen = computed(() => new Set(answeredText.value ? answeredValues(answeredText.value) : []));
const canAnswer = computed(() => Boolean(props.choice.ask && channel?.canSend.value && !locked.value));
const detailed = computed(() => props.choice.options.some((option) => option.pros?.length || option.cons?.length));
const currentItem = computed(() => props.choice.items?.[queueIndex.value]);
const queueValues = computed(() => locked.value ? answeredValues(answeredText.value ?? '') : queueAnswers.value);
const progress = computed(() => props.choice.items ? (locked.value ? 1 : queueIndex.value / props.choice.items.length) : 0);
const note = computed(() => {
  if (error.value) return error.value;
  if (locked.value) return 'Answered.';
  if (!props.choice.ask) return '';
  if (!channel) return 'Answer this in the live conversation.';
  if (!channel.canSend.value) return 'Only the window in control of this agent can answer.';
  return '';
});

function isPicked(value: string): boolean {
  return locked.value ? chosen.value.has(value) : selected.value === value;
}

function labelOf(value: string | undefined): string | undefined {
  return props.choice.options.find((option) => option.value === value)?.label;
}

function answerItem(value: string): void {
  if (!canAnswer.value || !props.choice.items) return;
  queueAnswers.value[queueIndex.value] = value;
  queueIndex.value++;
  if (queueIndex.value < props.choice.items.length) queueRef.value?.focus();
}

function onKey(event: KeyboardEvent): void {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const option = props.choice.options.find((item) => item.key === event.key.toLowerCase());
  if (!option || !props.choice.items || queueIndex.value >= props.choice.items.length) return;
  event.preventDefault();
  event.stopPropagation();
  answerItem(option.value);
}

async function send(text: string): Promise<void> {
  if (!channel || !canAnswer.value || sending.value) return;
  sending.value = true;
  error.value = '';
  try {
    await channel.send(text);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    sending.value = false;
  }
}

function sendOne(value: string): void {
  if (!props.choice.id) return;
  void send(drawnUiAnswerText(props.choice.id, [{ label: labelOf(value) ?? value, value }]));
}

function sendQueue(): void {
  if (!props.choice.id || !props.choice.items) return;
  void send(drawnUiAnswerText(props.choice.id, props.choice.items.map((item, index) => {
    const value = queueAnswers.value[index] ?? '';
    return { item: item.id, label: labelOf(value) ?? value, value };
  })));
}
</script>
