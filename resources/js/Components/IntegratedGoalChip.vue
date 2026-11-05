<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        class="h-8 min-w-0 max-w-64 gap-1.5 px-2 text-xs font-[440] text-muted-foreground hover:text-foreground"
        :aria-label="`${goalStatusLabel(goal.status)}: ${goal.objective}. Show goal`"
        data-component="integrated-goal-chip"
        :data-status="goal.status"
      >
        <component :is="goal.status === 'complete' ? CircleCheck : Target" class="h-3.5 w-3.5 shrink-0" :class="tint" aria-hidden="true" />
        <span class="min-w-0 truncate max-[480px]:hidden">{{ goal.status === 'complete' ? 'Goal met' : goal.objective }}</span>
        <span v-if="goal.rounds !== undefined && goal.status !== 'complete'" class="shrink-0 tabular-nums text-[10px] text-muted-foreground/80" aria-hidden="true">{{ goal.rounds }}</span>
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" class="w-80 max-w-[calc(100vw-2rem)] p-3 text-xs" aria-label="Goal">
      <div class="flex items-center gap-1.5">
        <Target class="h-3.5 w-3.5 shrink-0" :class="tint" aria-hidden="true" />
        <p class="min-w-0 flex-1 truncate font-medium text-foreground">{{ goalStatusLabel(goal.status) }}</p>
        <p v-if="roundLabel" class="shrink-0 tabular-nums text-muted-foreground">{{ roundLabel }}</p>
      </div>
      <p class="mt-2 max-h-40 overflow-y-auto overscroll-contain whitespace-pre-wrap break-words text-sm leading-5 text-foreground">{{ goal.objective }}</p>
      <p v-if="usageLabel" class="mt-2 tabular-nums text-muted-foreground">{{ usageLabel }}</p>
      <div
        v-if="budgetShare !== null"
        class="mt-1.5 h-1 overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-label="Token budget used"
        :aria-valuenow="Math.round(budgetShare * 100)"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <div class="h-full rounded-full" :class="budgetShare >= 0.9 ? 'bg-warning' : 'bg-foreground/60'" :style="{ width: `${Math.round(budgetShare * 100)}%` }" />
      </div>
      <p v-if="goal.reason" class="mt-2 whitespace-pre-wrap break-words text-muted-foreground">{{ goal.reason }}</p>
      <div v-if="actions" class="-mx-1 mt-3 flex flex-wrap items-center justify-end gap-1">
        <Button v-if="support.canEdit && goal.status !== 'complete'" size="sm" variant="ghost" class="h-7 px-2 text-xs" :disabled="disabled" @click="act('edit')">Edit</Button>
        <Button v-if="support.canPause && goal.status === 'active'" size="sm" variant="ghost" class="h-7 px-2 text-xs" :disabled="disabled" @click="act('pause')">Pause</Button>
        <Button v-else-if="support.canResume && canResume" size="sm" variant="ghost" class="h-7 px-2 text-xs" :disabled="disabled" @click="act('resume')">Resume</Button>
        <Button size="sm" variant="ghost" class="h-7 px-2 text-xs" :disabled="disabled" @click="act('clear')">Clear</Button>
      </div>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { CircleCheck, Target } from 'lucide-vue-next';
import { Button } from './ui/button';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { goalStatusLabel, type IntegratedGoal, type IntegratedGoalSupport } from '../lib/integratedConversation';
import { compactTokens } from '../lib/integratedUsage';

const props = defineProps<{
  goal: IntegratedGoal;
  support: IntegratedGoalSupport;
  // Without control the popover only shows the goal.
  actions: boolean;
  disabled: boolean;
}>();
const emit = defineEmits<{ action: [action: 'edit' | 'pause' | 'resume' | 'clear'] }>();
const open = ref(false);

const tint = computed(() => ({
  active: 'text-primary',
  paused: 'text-warning',
  limited: 'text-warning',
  complete: 'text-success',
  blocked: 'text-destructive',
  failed: 'text-destructive'
})[props.goal.status]);
const canResume = computed(() => props.goal.status === 'paused' || props.goal.status === 'blocked' || props.goal.status === 'limited');
const roundLabel = computed(() => {
  const { rounds, maxRounds } = props.goal;
  if (rounds === undefined) return '';
  return maxRounds ? `Round ${rounds} of ${maxRounds}` : `${rounds} ${rounds === 1 ? 'round' : 'rounds'}`;
});
const usageLabel = computed(() => {
  const { tokensUsed, tokenBudget, timeUsedSeconds } = props.goal;
  const parts: string[] = [];
  if (tokensUsed !== undefined) parts.push(tokenBudget ? `${compactTokens(tokensUsed)} of ${compactTokens(tokenBudget)} tokens` : `${compactTokens(tokensUsed)} tokens`);
  if (timeUsedSeconds !== undefined) parts.push(duration(timeUsedSeconds));
  return parts.join(' · ');
});
const budgetShare = computed(() => props.goal.tokenBudget && props.goal.tokensUsed !== undefined ? Math.min(1, props.goal.tokensUsed / props.goal.tokenBudget) : null);

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function act(action: 'edit' | 'pause' | 'resume' | 'clear'): void {
  open.value = false;
  emit('action', action);
}
</script>
