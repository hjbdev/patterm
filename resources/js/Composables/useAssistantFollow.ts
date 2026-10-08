import { computed, onBeforeUnmount, shallowRef, watch, type Ref } from 'vue';
import { useRoute, useRouter, type RouteLocationNormalized, type RouteLocationRaw } from 'vue-router';
import { deriveAssistantFocus, latestTurnId, type AssistantFocus, type FocusTarget } from '../lib/assistantFocus';
import { decideFollow, initialFollowState, routeChanged, showRequested } from '../lib/assistantFollow';
import { assistantLayout, setAssistantLayout } from '../lib/assistantLayout';
import { lastProjectLocation, resolveProjectReturnPath } from '../lib/projectLocations';
import type { TranscriptMessage } from '../lib/integratedConversation';
import { useWorkbench } from './useWorkbench';

// A turn that reads one agent and then acts on another settles before moving.
const SETTLE_MS = 400;
// Typing in the workspace this recently holds Follow back.
const TYPING_MS = 3_000;
// A route change this soon after a click or key press is the user's own.
// Opening a terminal can wait on a workbench refresh first.
const MANUAL_MS = 2_000;
// Pages focus their composer or terminal when they open; a Follow move keeps
// focus in the assistant for this long.
const KEEP_FOCUS_MS = 1_500;

// Follow: while the workspace is visible beside the assistant, show the agent,
// process, or project the conversation is about. Each device decides alone.
// Moving elsewhere by hand pauses Follow until the user raises a new topic.
export function useAssistantFollow(transcript: Ref<readonly TranscriptMessage[]>, loaded: Ref<boolean>, working: Ref<boolean>, visible: Ref<boolean>, dock: Ref<HTMLElement | null>) {
  const router = useRouter();
  const route = useRoute();
  const { projects } = useWorkbench();
  const focus = computed(() => deriveAssistantFocus(transcript.value, projects.value));
  // The focus after it settles, which the chip shows.
  const settled = shallowRef<AssistantFocus | null>(null);
  const state = shallowRef(initialFollowState());
  let following = false;
  let typedAt = 0;
  let inputAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // The latest turn once the first snapshot has loaded, even an empty one.
  // Taken from the transcript alone: the workbench may not have loaded yet.
  watch([transcript, loaded], ([rows, isLoaded]) => {
    if (state.value.baselineTurnId === undefined && isLoaded) state.value = { ...state.value, baselineTurnId: latestTurnId(rows) };
  }, { immediate: true });

  // A survey reads one agent after another, so a focus from tool calls only
  // counts once the turn ends; the user's own mention counts at once.
  watch([focus, working], ([next, busyTurn]) => {
    clearTimeout(timer);
    if (busyTurn && next?.source !== 'mention') return;
    timer = setTimeout(() => {
      settled.value = next;
      const decision = decideFollow(state.value, next, {
        enabled: assistantLayout.follow,
        visible: visible.value,
        shown: Boolean(next && shows(route, next.target)),
        busy: busy()
      });
      state.value = decision.state;
      if (decision.show && next) show(next.target);
    }, SETTLE_MS);
  });

  function show(target: FocusTarget): void {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    following = true;
    void router.push(location(target)).finally(() => { following = false; });
    if (active && dock.value?.contains(active)) keepFocus(active);
  }

  function location(target: FocusTarget): RouteLocationRaw {
    if (target.sessionId) return { name: 'agent', params: { projectId: target.projectId, sessionId: target.sessionId } };
    if (target.processId) return { name: 'process', params: { projectId: target.projectId, processId: target.processId } };
    const project = projects.value.find((item) => item.project.id === target.projectId);
    return resolveProjectReturnPath(project, lastProjectLocation(target.projectId)) ?? { name: 'project', params: { projectId: target.projectId } };
  }

  const stopWatchingRoutes = router.afterEach((to, from, failure) => {
    if (failure || following || to.path === from.path) return;
    const current = settled.value;
    state.value = routeChanged(state.value, {
      enabled: assistantLayout.follow,
      manual: Date.now() - inputAt < MANUAL_MS,
      showsFocus: Boolean(current && shows(to, current.target)),
      latestTurnId: latestTurnId(transcript.value),
      focus: current
    });
  });

  // Typing to the assistant is not navigating, but a click anywhere may be.
  function onPointerdown(): void {
    inputAt = Date.now();
  }
  function onKeydown(event: KeyboardEvent): void {
    const target = event.target instanceof Node ? event.target : null;
    if (target && dock.value?.contains(target)) return;
    inputAt = Date.now();
    if (target && document.getElementById('workbench-main')?.contains(target)) typedAt = inputAt;
  }
  window.addEventListener('pointerdown', onPointerdown, true);
  window.addEventListener('keydown', onKeydown, true);

  // Mid-sentence in the workspace or in a modal, moving would lose the user's
  // place. Popovers also use the dialog role but sit in a popper wrapper.
  function busy(): boolean {
    if (Date.now() - typedAt < TYPING_MS) return true;
    return [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')]
      .some((element) => !dock.value?.contains(element) && !element.closest('[data-reka-popper-content-wrapper]'));
  }

  function keepFocus(element: HTMLElement): void {
    const main = document.getElementById('workbench-main');
    const restore = (event: FocusEvent) => {
      if (event.target instanceof Node && main?.contains(event.target) && element.isConnected) element.focus({ preventScroll: true });
    };
    const stop = () => {
      clearTimeout(expiry);
      document.removeEventListener('focusin', restore, true);
      window.removeEventListener('pointerdown', stop, true);
    };
    const expiry = setTimeout(stop, KEEP_FOCUS_MS);
    document.addEventListener('focusin', restore, true);
    window.addEventListener('pointerdown', stop, true);
  }

  // What Follow would show but is not showing: paused, held back, or already
  // on screen when this client loaded.
  const pending = computed(() => {
    const current = settled.value;
    if (!assistantLayout.follow || !visible.value || !current || shows(route, current.target)) return null;
    return { target: current.target, paused: Boolean(state.value.paused) };
  });

  function showPending(): void {
    const current = settled.value;
    if (!current) return;
    state.value = showRequested(state.value, current);
    show(current.target);
  }

  function setFollow(value: boolean): void {
    setAssistantLayout({ follow: value });
    state.value = { ...state.value, paused: null };
    const current = settled.value ?? focus.value;
    if (value && current && visible.value && !shows(route, current.target)) {
      state.value = showRequested(state.value, current);
      show(current.target);
    }
  }

  onBeforeUnmount(() => {
    clearTimeout(timer);
    stopWatchingRoutes();
    window.removeEventListener('pointerdown', onPointerdown, true);
    window.removeEventListener('keydown', onKeydown, true);
  });

  return { pending, showPending, setFollow };
}

function shows(route: Pick<RouteLocationNormalized, 'params'>, target: FocusTarget): boolean {
  const { projectId, sessionId, processId } = route.params;
  if (projectId !== target.projectId) return false;
  if (target.sessionId) return sessionId === target.sessionId;
  if (target.processId) return processId === target.processId;
  return true;
}
