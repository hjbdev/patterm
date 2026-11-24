<template>
  <Transition
    enter-active-class="transition duration-300 ease-out motion-reduce:transition-none"
    enter-from-class="translate-y-2 opacity-0"
    leave-active-class="transition duration-200 ease-in motion-reduce:transition-none"
    leave-to-class="opacity-0"
    mode="out-in"
  >
    <section v-if="finished" key="done" aria-live="polite" :class="cn(CARD, 'flex items-center gap-2.5 px-3 py-3 text-[13px]')">
      <span class="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-success text-[hsl(142_70%_10%)]"><Check class="h-3 w-3" :stroke-width="3" /></span>
      <span class="font-medium">Setup complete</span>
    </section>
    <section v-else-if="status?.show" key="list" aria-label="Get started" :class="CARD">
      <div class="flex items-center gap-1 py-1.5 pl-3 pr-1.5">
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          :aria-expanded="!collapsed"
          @click="collapsed = !collapsed"
        >
          <span class="text-[13px] font-semibold">Get started</span>
          <span class="ml-auto text-[12px] tabular-nums text-muted-foreground">{{ doneCount }} of {{ steps.length }}</span>
          <ChevronDown class="h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none" :class="collapsed && '-rotate-90'" />
        </button>
        <button type="button" :class="ICON_BUTTON" aria-label="Hide Get started" title="Hide" @click="hide">
          <X class="h-3.5 w-3.5" />
        </button>
      </div>
      <div class="mx-3 h-0.5 overflow-hidden rounded-full bg-white/[0.06]" :class="collapsed && 'mb-2.5'">
        <div class="h-full rounded-full bg-success transition-[width] duration-500 ease-out motion-reduce:transition-none" :style="{ width: `${(doneCount / steps.length) * 100}%` }" />
      </div>
      <div v-if="!collapsed" class="p-1.5 pt-2">
        <p v-if="doneCount <= 1" class="px-1.5 pb-1.5 text-[12.5px] leading-[1.45] text-muted-foreground">Patterm runs coding agents that you install separately.</p>
        <div v-for="step in steps" :key="step.id" class="rounded-lg" :class="openStep === step.id && 'bg-white/[0.04]'">
          <button
            type="button"
            class="flex w-full items-center gap-2.5 rounded-lg px-1.5 text-left hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            :class="placement === 'phone' ? 'min-h-11 text-[14px]' : 'py-1.5 text-[13px]'"
            :aria-expanded="openStep === step.id"
            @click="choose(step.id)"
          >
            <span
              class="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border transition-colors duration-300"
              :class="step.done ? 'border-success bg-success text-[hsl(142_70%_10%)]' : 'border-white/20'"
            >
              <Check v-if="step.done" class="h-3 w-3" :stroke-width="3" />
            </span>
            <span :class="step.done && 'text-muted-foreground'">{{ step.label }}</span>
            <span class="sr-only">{{ step.done ? '(done)' : '' }}</span>
          </button>

          <div v-if="openStep === step.id" class="grid gap-2 pb-2.5 pl-[34px] pr-2 text-[12.5px] leading-[1.45] text-muted-foreground">
            <ul v-if="step.id === 'install'" class="grid">
              <li v-for="harness in status.harnesses" :key="harness.harness" class="flex h-8 items-center gap-2">
                <AgentIcon :harness="harness.harness" class="h-3.5 w-3.5 text-foreground/80" />
                <span class="min-w-0 flex-1 truncate text-foreground/90">{{ harness.name }}</span>
                <span v-if="harness.installed" class="flex items-center gap-1.5 font-mono text-[11.5px]">
                  <span class="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
                  <span class="sr-only">Installed</span>{{ harness.version }}
                </span>
                <a
                  v-else-if="harness.installUrl"
                  :href="harness.installUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="-mr-1.5 inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium hover:bg-white/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  :aria-label="`Install ${harness.name} (opens its website)`"
                >Install <ArrowUpRight class="h-3 w-3" /></a>
              </li>
              <li v-if="status.harnesses.some((harness) => !harness.installed)" class="pt-1">Not showing up? Restart Patterm.</li>
            </ul>

            <template v-else-if="step.id === 'signIn'">
              <p v-if="!installed.length">Install an agent first.</p>
              <template v-else>
                <p v-for="line in signInLines" :key="line.harness">
                  {{ line.before }}<code v-if="line.command" class="rounded bg-white/[0.06] px-1 py-px font-mono text-[11.5px] text-foreground/90">{{ line.command }}</code>{{ line.after }}
                </p>
                <div v-if="!step.done">
                  <Button variant="outline" size="sm" class="h-7 px-2.5 text-[12px]" :disabled="checking" @click="checkAgain">
                    <Loader2 v-if="checking" class="h-3 w-3 animate-spin" />
                    {{ checking ? 'Checking' : 'Check again' }}
                  </Button>
                </div>
              </template>
            </template>

            <template v-else-if="step.id === 'project'">
              <p v-if="projectName">{{ projectName }} is added.</p>
              <template v-else>
                <p>Add a folder that holds your code.</p>
                <div>
                  <NewProjectDialog @created="openCreated">
                    <template #trigger>
                      <Button variant="outline" size="sm" class="h-7 px-2.5 text-[12px]">Add project</Button>
                    </template>
                  </NewProjectDialog>
                </div>
              </template>
            </template>

            <template v-else>
              <p v-if="!installed.length">Install an agent first.</p>
              <template v-else>
                <p v-if="placement === 'page'">Open a project and press <b class="font-medium text-foreground/90">+</b>.</p>
                <p v-else>Press <b class="font-medium text-foreground/90">+</b> {{ LAUNCH_HINT[placement] }}.</p>
                <div v-if="placement !== 'page'">
                  <Button variant="outline" size="sm" class="h-7 px-2.5 text-[12px]" @click="pointAtLaunch">Show</Button>
                </div>
              </template>
            </template>
          </div>
        </div>
      </div>
    </section>
  </Transition>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ArrowUpRight, Check, ChevronDown, Loader2, X } from 'lucide-vue-next';
import { useOnboarding, type OnboardingHarness, type OnboardingStatus } from '../Composables/useOnboarding';
import { useWorkbench } from '../Composables/useWorkbench';
import { useWorkbenchNavigation } from '../Composables/useWorkbenchNavigation';
import { navigationLayoutHint } from '../appearance/AppearanceSettings';
import { pointAtLaunch } from '../lib/launchPointer';
import { phoneLayout } from '../lib/phoneLayout';
import { cn } from '../lib/utils';
import AgentIcon from './AgentIcon.vue';
import NewProjectDialog from './NewProjectDialog.vue';
import { Button } from './ui/button';

// The Get started checklist. The server decides each step from what is
// already true, so steps tick by themselves. Where it shows decides how it
// points at the + that starts an agent:
//   docked: above the sidebar's footer, with + next to the project name;
//   floating: over the workspace in tabs mode, with + after the tabs;
//   phone: at the top of a phone's list, with + at the bottom;
//   page: on the Projects page, which has no + of its own.
type GetStartedPlacement = 'docked' | 'floating' | 'phone' | 'page';
const props = defineProps<{ placement: GetStartedPlacement }>();

const CARD = 'shrink-0 overflow-hidden rounded-xl border border-white/[0.08] bg-[hsl(0_0%_7%)]';
const ICON_BUTTON = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-white/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

const { projects, refresh } = useWorkbench();
const { pickProject } = useWorkbenchNavigation();
const { status, finished, collapsed, recheck, dismiss } = useOnboarding();
const LAUNCH_HINT: Record<GetStartedPlacement, string> = {
  docked: 'next to the project name',
  floating: 'at the top',
  phone: 'at the bottom of the screen',
  page: ''
};
const REOPEN_HINT: Record<GetStartedPlacement, string> = {
  docked: 'Reopen it from the settings menu.',
  floating: 'Reopen it from the ⋯ menu.',
  phone: 'Reopen it from Library.',
  page: ''
};
// The Projects page has no menu of its own, so it names the one a project has.
function reopenHint(): string {
  if (props.placement !== 'page') return REOPEN_HINT[props.placement];
  if (phoneLayout.value) return REOPEN_HINT.phone;
  return navigationLayoutHint() === 'sidebar' ? 'Reopen it from the settings menu in a project.' : 'Reopen it from the ⋯ menu in a project.';
}
const hide = () => dismiss(reopenHint());

type StepId = keyof OnboardingStatus['steps'];
const LABELS: Record<StepId, string> = {
  install: 'Install an agent',
  signIn: 'Sign in to it',
  project: 'Add a project folder',
  start: 'Start your first agent'
};
const steps = computed(() => (Object.keys(LABELS) as StepId[]).map((id) => ({ id, label: LABELS[id], done: Boolean(status.value?.steps[id]) })));
const doneCount = computed(() => steps.value.filter((step) => step.done).length);
const installed = computed(() => status.value?.harnesses.filter((harness) => harness.installed) ?? []);
// The Personal project is built in, so it doesn't count.
const projectName = computed(() => projects.value.find(({ project }) => project.kind === 'workspace' && !project.host)?.project.name ?? null);

// The first step still to do is open. A step you choose stays open, or
// closed, until it gets done; then the next one opens.
const openStep = ref<StepId | null>(null);
const chosen = ref(false);
watch(steps, (next, previous) => {
  const justDone = Boolean(openStep.value)
    && next.find((step) => step.id === openStep.value)?.done
    && !previous?.find((step) => step.id === openStep.value)?.done;
  if (!chosen.value || justDone) {
    chosen.value = false;
    openStep.value = next.find((step) => !step.done)?.id ?? null;
  }
}, { immediate: true });

function choose(id: StepId): void {
  chosen.value = true;
  openStep.value = openStep.value === id ? null : id;
}

// A new project or agent ticks its step without waiting for the next poll.
watch(() => `${projects.value.length}:${projects.value.reduce((count, project) => count + project.projectSessions.length, 0)}`, () => {
  if (status.value?.show) void recheck(false);
});

interface SignInLine { harness: string; before: string; command?: string; after?: string }

// One line per installed agent, signed-in ones first.
const signInLines = computed((): SignInLine[] => {
  const order = (harness: OnboardingHarness) => harness.signIn === 'signed_in' ? 0 : 1;
  return [...installed.value].sort((a, b) => order(a) - order(b)).map((harness): SignInLine => {
    const { harness: id, name, signInCommand: command } = harness;
    if (harness.signIn === 'signed_in' || harness.signIn === null) return { harness: id, before: `${name} is signed in.` };
    if (harness.signIn === 'unknown') return { harness: id, before: `Couldn’t check whether ${name} is signed in.` };
    if (harness.signInOptional) {
      return command
        ? { harness: id, before: `${name} has no saved sign-in. If it needs one, run `, command, after: ' in a terminal.' }
        : { harness: id, before: `${name} has no saved sign-in.` };
    }
    return command
      ? { harness: id, before: `${name} isn’t signed in. Run `, command, after: ' in a terminal and sign in.' }
      : { harness: id, before: `${name} isn’t signed in.` };
  });
});

const checking = ref(false);
async function checkAgain(): Promise<void> {
  checking.value = true;
  try { await recheck(true); }
  finally { checking.value = false; }
}

async function openCreated(projectId: string): Promise<void> {
  await refresh();
  void pickProject(projectId);
  void recheck(false);
}
</script>
