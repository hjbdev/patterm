<template>
  <div class="relative flex h-full min-h-0 flex-col">
    <!-- The task drawer covers the conversation; keep focus and assistive
         technology out of what it hides. -->
    <div class="contents" :inert="openedTask ? true : undefined">
      <div class="relative flex min-h-0 flex-1 flex-col">
        <LoadingBar :active="loadingTranscript" label="Loading conversation" :inline="embedded === true" />
        <div class="min-h-0 flex-1">
          <ConversationTranscript ref="transcriptRef" :key="processId" :messages="transcriptMessages" :truncated="historyTruncated" :history-unavailable="historyUnavailable" :has-older="Boolean(historyCursor)" :loading-older="loadingOlder" :history-error="historyError" :process-id="processId" :live="streaming" :working="streamStatus === 'working' && !ended" :settling="loadingTranscript" :can-retry="canReply && !submission" auto-load-older @load-older="loadOlder" @retry-message="retryMessage" />
        </div>
        <p v-if="displayError" role="alert" class="shrink-0 break-words px-5 pb-4 text-sm text-destructive">{{ displayError }}</p>
      </div>
      <p v-if="ended" role="status" class="shrink-0 border-t border-border/60 px-5 py-3 text-sm text-muted-foreground">This agent session has ended. The transcript is read-only.</p>
      <div v-if="permissions.length || questions.length || forms.length || (closeRequest && !ended)" class="shrink-0 pb-2">
        <!-- The same width and inset as the composer below. -->
        <div class="mx-auto max-h-[55vh] w-full max-w-[50rem] space-y-2 overflow-y-auto overscroll-contain px-4 2xl:max-w-[1000px]" role="group" aria-label="Pending requests">
        <div v-if="permissions.length" class="relative pb-2">
          <div v-if="permissions.length > 2" aria-hidden="true" class="absolute inset-x-3 bottom-0 top-3 rounded-xl border border-border bg-background" />
          <div v-if="permissions.length > 1" aria-hidden="true" class="absolute inset-x-1.5 bottom-1 top-1.5 rounded-xl border border-border bg-background" />
          <section
            v-for="permission in permissions.slice(0, 1)"
            :key="permission.id"
            class="relative flex max-h-[calc(55vh-1rem)] flex-col rounded-xl border border-border bg-background p-4 text-sm shadow-sm [&>*]:shrink-0"
            :aria-label="`Permission: ${permission.action}`"
          >
            <p v-if="permissions.length > 1" class="mb-0.5 text-xs text-muted-foreground">1 of {{ permissions.length }} requests</p>
            <p class="font-medium text-foreground">{{ permission.action }}</p>
            <p v-if="permission.detail" class="mt-0.5 whitespace-pre-wrap break-words text-xs text-muted-foreground">{{ permission.detail }}</p>
            <pre v-if="permission.command" class="mt-3 max-h-40 min-h-12 !shrink overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 px-3 py-2 font-mono text-xs leading-5">{{ permission.command }}</pre>
            <p v-if="permission.cwd" class="mt-1 break-all font-mono text-xs text-muted-foreground">in {{ permission.cwd }}</p>
            <!-- A long plan, command, or change scrolls inside the card, so its
                 buttons stay in view. Plan headings keep the card's text size. -->
            <div v-if="permission.plan" class="mt-3 min-h-24 !shrink overflow-y-auto overscroll-contain rounded-lg bg-muted/40 px-3 py-2 [&_h1]:!text-sm [&_h2]:!text-sm [&_h3]:!text-sm" aria-label="Proposed plan"><Markdown :source="permission.plan" /></div>
            <pre v-if="permission.patch" class="mt-3 max-h-56 min-h-12 !shrink overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 px-3 py-2 font-mono text-xs leading-5" aria-label="Proposed change"><span v-for="(line, index) in permission.patch.split('\n')" :key="index" :class="patchLineClass(line)">{{ line }}
  </span></pre>
            <p v-if="shownResources(permission.resources).length && !permission.command && !permission.patch && !permission.plan" class="mt-3 break-all rounded-lg bg-muted/40 px-3 py-2 font-mono text-xs leading-5 text-muted-foreground">{{ shownResources(permission.resources).join(', ') }}</p>
            <input
              v-if="permission.feedback"
              v-model="denyFeedback[permission.id]"
              :class="['-mx-2 mt-2 w-[calc(100%+1rem)]', INLINE_INPUT_CLASS]"
              :placeholder="permission.plan ? 'What should change in the plan? (optional)' : 'Tell the agent what to do instead (optional)'"
              :aria-label="`Feedback if you deny ${permission.action}`"
            >
            <div class="mt-3 flex flex-wrap items-center justify-end gap-2">
              <p v-if="permission.always === false && !permission.plan" class="mr-auto text-xs text-muted-foreground">Only this request can be allowed.</p>
              <Button size="sm" class="h-7 px-2.5" variant="ghost" :disabled="!canReply || isResponding(permission.id)" @click="replyPermission(permission.id, 'reject')">{{ permission.rejectLabel ?? 'Deny' }}</Button>
              <Button v-if="permission.always !== false" size="sm" class="h-7 px-2.5" variant="secondary" :disabled="!canReply || isResponding(permission.id)" @click="replyPermission(permission.id, 'always')">{{ permission.alwaysLabel ?? 'Always allow' }}</Button>
              <Button size="sm" class="h-7 px-2.5" :disabled="!canReply || isResponding(permission.id)" @click="replyPermission(permission.id, 'once')">{{ permission.onceLabel ?? 'Allow once' }}</Button>
            </div>
          </section>
        </div>
        <IntegratedQuestionCard
          v-for="request in questions"
          :key="request.id"
          :request="request"
          :multiple="questionAnswers"
          :single="singleQuestionAnswers"
          :custom="customQuestionAnswers"
          :disabled="!canReply || isResponding(request.id)"
          @choose="chooseQuestionAnswer"
          @custom="setCustomQuestionAnswer"
          @reply="replyQuestion(request)"
        />
        <template v-for="form in forms" :key="form.id">
          <IntegratedQuestionCard
            v-if="formQuestions(form)"
            :request="formQuestions(form)!"
            v-bind="formQuestionState(activeFields(form), formAnswers[form.id] ?? {})"
            :disabled="!canReply || isResponding(form.id)"
            :declinable="form.declinable"
            :note="form.detail"
            :error="formErrors[form.id]"
            @choose="(question, label, checked) => chooseFormOption(form, question.key, label, checked)"
            @custom="(question, text) => setFormCustom(form, question.key, text)"
            @reply="replyForm(form)"
            @decline="declineForm(form)"
          />
          <section
            v-else
            class="rounded-xl border border-border bg-background p-4 text-sm shadow-sm"
            :aria-label="form.title"
          >
            <p class="font-medium text-foreground">{{ form.title }}</p>
            <p v-if="form.detail" class="mt-0.5 text-xs text-muted-foreground">{{ form.detail }}</p>
            <div v-for="field in activeFields(form)" :key="field.key" class="mt-3">
              <label :for="`${form.id}-${field.key}`" class="block text-xs font-medium">
                {{ field.title || field.key }}<span v-if="field.required" class="text-destructive" aria-hidden="true"> *</span>
              </label>
              <p v-if="field.description" class="mt-0.5 text-xs text-muted-foreground">{{ field.description }}</p>
              <label v-if="field.type === 'boolean'" class="mt-1 inline-flex items-center gap-2 text-xs">
                <input
                  :id="`${form.id}-${field.key}`"
                  type="checkbox"
                  :checked="formAnswers[form.id]?.[field.key] === true"
                  @change="setFormAnswer(form.id, field.key, ($event.target as HTMLInputElement).checked)"
                >
                {{ field.title || 'Yes' }}
              </label>
              <template v-else-if="field.type === 'multiselect'">
                <div class="mt-1 flex flex-wrap gap-2">
                  <label v-for="option in field.options" :key="option.value" class="inline-flex items-center gap-1.5 rounded-md border border-input px-2 py-1 text-xs">
                    <input
                      type="checkbox"
                      :checked="multiselectValue(form.id, field.key).includes(option.value)"
                      @change="toggleMultiselect(form.id, field.key, option.value, ($event.target as HTMLInputElement).checked)"
                    >
                    {{ option.label }}
                  </label>
                </div>
                <input
                  v-if="field.custom"
                  :id="`${form.id}-${field.key}`"
                  type="text"
                  class="mt-1 block h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  placeholder="Other"
                  :value="customValue(form.id, field.key)"
                  @input="setFormAnswer(form.id, `${field.key}:custom`, ($event.target as HTMLInputElement).value)"
                >
              </template>
              <input
                v-else-if="field.type === 'number' || field.type === 'integer'"
                :id="`${form.id}-${field.key}`"
                type="number"
                :step="field.type === 'integer' ? 1 : 'any'"
                :min="field.minimum"
                :max="field.maximum"
                class="mt-1 block h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                :value="formAnswers[form.id]?.[field.key] ?? ''"
                @input="setFormAnswer(form.id, field.key, ($event.target as HTMLInputElement).value)"
              >
              <a
                v-else-if="field.type === 'external' && field.url"
                :href="field.url"
                target="_blank"
                rel="noreferrer"
                class="mt-1 inline-block break-all text-xs text-primary underline"
              >{{ field.url }}</a>
              <select
                v-else-if="field.options.length && !field.custom"
                :id="`${form.id}-${field.key}`"
                class="mt-1 block h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                :value="formAnswers[form.id]?.[field.key] ?? ''"
                @change="setFormAnswer(form.id, field.key, ($event.target as HTMLSelectElement).value)"
              >
                <option value="">Select an answer</option>
                <option v-for="option in field.options" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
              <input
                v-else
                :id="`${form.id}-${field.key}`"
                type="text"
                :placeholder="field.placeholder"
                class="mt-1 block h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                :value="formAnswers[form.id]?.[field.key] ?? ''"
                @input="setFormAnswer(form.id, field.key, ($event.target as HTMLInputElement).value)"
              >
            </div>
            <p v-if="formErrors[form.id]" role="alert" class="mt-2 text-xs text-destructive">{{ formErrors[form.id] }}</p>
            <div class="mt-3 flex justify-end gap-2">
              <Button v-if="form.declinable" size="sm" class="h-7 px-2.5" variant="ghost" :disabled="!canReply || isResponding(form.id)" @click="declineForm(form)">Decline</Button>
              <Button size="sm" class="h-7 px-2.5" :disabled="!canReply || isResponding(form.id)" @click="replyForm(form)">Submit</Button>
            </div>
          </section>
        </template>
        <CloseRequestCard v-if="closeRequest && !ended" :key="`${processId}:${closeRequest.requestedAt}`" :process-id="processId" :request="closeRequest" :subagents="closeSubagents" />
        </div>
      </div>
      <section v-if="queue.length && !ended" class="mx-auto mb-2 w-full max-w-[50rem] px-4 2xl:max-w-[1000px]" aria-label="Queued messages" data-component="integrated-queue">
        <ul class="space-y-1 rounded-lg border border-border/60 px-3 py-1.5 text-xs">
          <li v-for="item in queue" :key="item.id" class="flex min-w-0 items-center gap-2">
            <span class="shrink-0" :class="item.error ? 'text-destructive' : 'text-muted-foreground'" :title="item.delivery === 'unconfirmed' ? `${item.error ?? ''} It may already have reached the agent; check before sending it again.`.trim() : item.error">{{ queueLabel(item) }}</span>
            <span class="min-w-0 flex-1 truncate">{{ item.text }}</span>
            <Button v-if="item.delivery === 'unconfirmed'" size="sm" variant="ghost" class="h-6 shrink-0 px-2 text-xs" :disabled="isResponding(`queue:${item.id}`)" @click="checkHeldDelivery(item)">Check delivery</Button>
            <Button v-else-if="item.delivery === 'queue' || item.error" size="sm" variant="ghost" class="h-6 shrink-0 px-2 text-xs" :disabled="!canReply || isResponding(`queue:${item.id}`)" @click="updateQueued(item, 'steer')">Send now</Button>
            <Button size="sm" variant="ghost" class="h-6 shrink-0 px-2 text-xs" :disabled="!canReply || isResponding(`queue:${item.id}`)" @click="updateQueued(item, 'cancel')">{{ item.delivery === 'unconfirmed' ? 'Dismiss' : 'Cancel' }}</Button>
          </li>
        </ul>
      </section>
      <p v-if="streamStatus === 'reconnecting'" role="status" class="mx-auto mb-2 w-full max-w-[50rem] 2xl:max-w-[1000px] px-4 text-xs text-muted-foreground">Reconnecting to the native agent…</p>
      <p v-else-if="streamStatus === 'error'" role="status" class="mx-auto mb-2 w-full max-w-[50rem] 2xl:max-w-[1000px] break-words px-4 text-xs text-destructive">{{ statusDetail ? `The last turn ended with an error: ${statusDetail}` : 'The last turn ended with an error; see the transcript.' }}</p>
      <div v-if="uncertain" role="status" class="mx-auto mb-3 w-full max-w-[50rem] 2xl:max-w-[1000px] rounded-lg border border-border bg-muted/20 p-3 text-sm">
        <p class="font-medium">Delivery uncertain</p>
        <p class="mt-1 text-xs text-muted-foreground">{{ uncertain.message }} The prompt may already be running; check the transcript before sending again.</p>
        <div class="mt-2 flex gap-2">
          <Button size="sm" variant="outline" @click="reconcileDelivery">Check delivery</Button>
          <Button size="sm" variant="secondary" @click="sendRequest(uncertain.payload, { force: true })">Send again</Button>
        </div>
        <p class="mt-1 text-[10px] text-muted-foreground">Sending again starts a new native submission and can run the prompt twice for Codex.</p>
      </div>
      <IntegratedTaskShelf
        v-if="tasks.length && !ended"
        :tasks="tasks"
        :can-open="canOpenTasks"
        :can-stop="canReply"
        :stopping="(taskId) => isResponding(`task:${taskId}`)"
        @open="openTask"
        @stop="stopTask"
      />
      <IntegratedComposer
        :process-id="processId"
        :provider="provider"
        :controls="controls"
        :controlling="controlling"
        :sending="sending"
        :pending="!!submission"
        :ended="ended"
        :working="streamStatus === 'working' && !ended"
        :agents="mentionAgents"
        :launchers="mentionLaunchers"
        @send="sendRequest"
        @command="runPattermCommand($event, '')"
        @invalid="error = $event"
        @interrupt="interrupt"
        @configure="configure"
        @take-control="takeControl"
      >
        <!-- Narrow screens keep the label for screen readers; the border
             comet shows the work. -->
        <template v-if="!ended" #status>
          <span v-if="streamStatus === 'working'" role="status" class="sr-only text-xs text-muted-foreground sm:not-sr-only"><ShimmerText text="Working…" /></span>
          <IntegratedModelActivity v-else-if="modelActivityAt" :at="modelActivityAt" class="text-xs text-muted-foreground" />
          <IntegratedUsageMeter v-if="usage" :usage="usage" />
        </template>
      </IntegratedComposer>
      <ResumeConversationDialog
        v-if="projectId && provider"
        v-model:open="resumeOpen"
        :project-id="projectId"
        :process-id="processId"
        :provider="provider"
        :provider-label="providerLabel"
        :initial-query="resumeQuery"
        @launched="props.onLaunched?.($event)"
      />
    </div>
    <Transition
      enter-active-class="transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none"
      enter-from-class="translate-x-6 opacity-0"
      leave-active-class="transition-[transform,opacity] duration-150 ease-in motion-reduce:transition-none"
      leave-to-class="translate-x-6 opacity-0"
    >
      <IntegratedTaskDrawer
        v-if="openedTask"
        :process-id="processId"
        :task="openedTask"
        :project-path="projectPath ?? null"
        :can-stop="canReply"
        :stopping="isResponding(`task:${openedTask.id}`)"
        @close="closeTask"
        @stop="stopTask(openedTask.id)"
      />
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { randomId } from '../lib/randomId';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { Button } from './ui/button';
import CloseRequestCard from './CloseRequestCard.vue';
import ConversationTranscript from './ConversationTranscript.vue';
import IntegratedComposer from './IntegratedComposer.vue';
import IntegratedModelActivity from './IntegratedModelActivity.vue';
import IntegratedQuestionCard from './IntegratedQuestionCard.vue';
import IntegratedTaskShelf from './IntegratedTaskShelf.vue';
import IntegratedTaskDrawer from './IntegratedTaskDrawer.vue';
import IntegratedUsageMeter from './IntegratedUsageMeter.vue';
import LoadingBar from './LoadingBar.vue';
import ShimmerText from './ShimmerText.vue';
import Markdown from './Markdown.vue';
import ResumeConversationDialog from './ResumeConversationDialog.vue';
import type { MentionAgent, MentionLauncher } from '../lib/agentMentions';
import { archiveTranscript } from '../lib/historyTranscript';
import type { CloseRequestRecord, ConversationMessageRecord } from '../types';
import {
  applyConversationStreamEvent,
  buildFormAnswer,
  formAsQuestions,
  formOptionValue,
  formQuestionState,
  buildQuestionAnswers,
  cachedConversation,
  forgetConversation,
  formFieldVisible,
  HELD_QUEUE_EVENT_ID,
  isSessionUnavailableError,
  mergeTranscriptWindows,
  normaliseConversation,
  normaliseMessages,
  rememberConversation,
  type ConversationStreamEvent,
  type IntegratedControls,
  type IntegratedFormField,
  type IntegratedFormRequest,
  type IntegratedQuestion,
  type IntegratedUsage,
  type IntegratedTask,
  type IntegratedQueuedMessage,
  type IntegratedPermission,
  type IntegratedQuestionRequest,
  type TranscriptMessage
} from '../lib/integratedConversation';
import { completeSend, discardOutgoingMessage, beginSubmission, beginOutgoingMessage, outgoingFor, outgoingTranscript, reconcileOutgoingMessages, failOutgoingMessage, markSubmissionUncertain, clearSubmission, isAmbiguousTransportError, submissionFor, type ComposerSendPayload } from '../lib/integratedComposer';
import { publishIntegratedControls } from '../lib/integratedControlsRegistry';
import { onWorkspaceRequest, type WorkspaceRequest } from '../lib/workspaceRequests';

// `embedded` conversations live outside the workbench main area, such as the assistant panel.
// `onLaunched` is a prop rather than an emit: /new and /resume close this tab
// before they answer, which can unmount the pane, and Vue drops emits from an
// unmounted component.
const props = defineProps<{ processId: string; projectId?: string | null; projectPath?: string | null; exited?: boolean; mentionAgents?: MentionAgent[]; mentionLaunchers?: MentionLauncher[]; embedded?: boolean; closeRequest?: CloseRequestRecord | null | undefined; closeSubagents?: number | undefined; onLaunched?: (sessionId: string) => void }>();
const emit = defineEmits<{ transcript: [messages: TranscriptMessage[], status: string, loaded: boolean] }>();
// Conversation state is replaced, never mutated in place (stream events and
// snapshots produce new arrays), so shallow refs skip deep proxying of every
// message and tool record.
const messages = shallowRef<TranscriptMessage[]>([]);
const permissions = shallowRef<IntegratedPermission[]>([]);
const questions = shallowRef<IntegratedQuestionRequest[]>([]);
const forms = shallowRef<IntegratedFormRequest[]>([]);
const usage = shallowRef<IntegratedUsage | null>(null);
const tasks = shallowRef<IntegratedTask[]>([]);
const queue = shallowRef<IntegratedQueuedMessage[]>([]);
const transcriptMessages = computed(() => outgoingTranscript(props.processId, messages.value, queue.value));
watch([messages, queue, () => outgoingFor(props.processId).map((entry) => entry.row.delivery?.state)], () => {
  reconcileOutgoingMessages(props.processId, messages.value, queue.value);
});
// The drawer keeps the last known state of its task after Claude drops a
// finished one from the snapshot.
const openedTask = shallowRef<IntegratedTask | null>(null);
// Amp keeps subagent conversations and shell output to itself.
const canOpenTasks = computed(() => provider.value === 'claude' || provider.value === 'codex' || provider.value === 'opencode');
watch(tasks, (current) => {
  const task = openedTask.value && current.find((item) => item.id === openedTask.value!.id);
  if (task) openedTask.value = task;
});
// Requests are constant during a turn, so the timer only shows between turns.
const modelActivityAt = computed(() => streamStatus.value === 'working' ? null : usage.value?.lastModelActivityAt ?? null);
const questionAnswers = ref<Record<string, string[]>>({});
const singleQuestionAnswers = ref<Record<string, string>>({});
const customQuestionAnswers = ref<Record<string, string>>({});
const formAnswers = ref<Record<string, Record<string, unknown>>>({});
const formErrors = ref<Record<string, string>>({});
const denyFeedback = ref<Record<string, string>>({});
// Requests disable duplicate submission while their reply is in flight, and
// answers/errors survive the round trip.
const responding = ref<Record<string, boolean>>({});
const ended = ref(Boolean(props.exited));
const error = ref('');
const refreshError = ref('');
const controlsError = ref('');
const controlling = ref(window.patterm.runtime !== 'browser');
const provider = ref<string | null>(null);
const submission = computed(() => submissionFor(props.processId));
const sending = computed(() => submission.value?.state === 'sending');
const uncertain = computed(() => submission.value?.state === 'uncertain' ? submission.value : null);
const streamStatus = ref<'working' | 'idle' | 'error' | 'reconnecting' | ''>('');
// The native reason for an error status, when the provider reports one.
const statusDetail = ref('');
const historyTruncated = ref(false);
const historyUnavailable = ref(false);
const historyCursor = ref<string | null>(null);
const loadingOlder = ref(false);
// True while begin() takes the first snapshot for the current process.
const loadingTranscript = ref(false);
// Set once the first snapshot for the current process has loaded, even an
// empty one, so a parent can tell an empty conversation from one still loading.
const transcriptLoaded = ref(false);
const historyError = ref('');
let historyLoaded = false;
// Providers that expose a native event stream set this in their snapshot.
const streaming = ref(false);
// The assistant's voice view summarises the same conversation as an action log.
// Post-flush, so the first emit never re-renders the parent mid-mount.
watch([transcriptMessages, streamStatus, transcriptLoaded], ([rows, status, loaded]) => emit('transcript', rows, status, loaded), { immediate: true, flush: 'post' });
// A failed subscription falls back to bounded polling until a reconnect retries
// the stream, so the pane never freezes without updates.
let streamUnavailable = false;
// A plain function, not a computed: streamUnavailable is not reactive, so a
// cached computed would keep claiming push after the stream failed.
const pushCapable = (): boolean => streaming.value && canSubscribe();
const providerLabel = computed(() => {
  if (provider.value === 'codex') return 'Codex';
  if (provider.value === 'opencode') return 'OpenCode';
  if (provider.value === 'claude') return 'Claude';
  if (provider.value === 'amp') return 'Amp';
  return 'The agent';
});
const controls = shallowRef<IntegratedControls>({ selectors: [], commands: [] });
const transcriptRef = ref<InstanceType<typeof ConversationTranscript> | null>(null);
const INITIAL_HISTORY_MESSAGES = 30;
const resumeOpen = ref(false);
const resumeQuery = ref('');
let startingNew = false;
const displayError = computed(() => error.value || refreshError.value || controlsError.value);
const canReply = computed(() => controlling.value && !ended.value);

let timer: ReturnType<typeof setTimeout> | undefined;
let controlsRetry: ReturnType<typeof setTimeout> | undefined;
let stopped = false;
// Every process change and unmount starts a new generation. Results from an
// older generation are dropped instead of leaking into the wrong transcript.
let generation = 0;
let refreshSequence = 0;
let appliedSequence = 0;
let stopControlListener: (() => void) | undefined;
let stopConversationListener: (() => void) | undefined;
let stopConnectionListener: (() => void) | undefined;
let stopWorkspaceRequests: (() => void) | undefined;
let conversationProcess: string | null = null;
// Stream events are held whenever a snapshot is in flight, then applied in
// revision order. The snapshot's revision is its exact boundary, so events it
// already contains are dropped and newer ones are not lost.
let snapshotDepth = 0;
let streamRevision = -1;
let bufferedStreamEvents: ConversationStreamEvent[] = [];
let subscribedProcessId: string | null = null;
let subscriptionSequence = 0;
let reconciling = false;
let lastConversation = '';

// Paint the last state shown for this process before the first render; the
// snapshot that begin() takes replaces it.
restoreState(props.processId);

onMounted(() => {
  registerControlListener();
  registerConversationListener();
  stopWorkspaceRequests = onWorkspaceRequest(handleWorkspaceRequest);
  stopConnectionListener = window.patterm.onConnectionChanged?.((state) => {
    if (state !== 'connected') return;
    streamUnavailable = false;
    if (pushCapable()) void startConversationStream(props.processId, true);
  });
  void begin(props.processId);
});
onBeforeUnmount(() => {
  rememberState(props.processId);
  publishIntegratedControls(props.processId, null);
  stopWorkspaceRequests?.();
  stopWorkspaceRequests = undefined;
  stopped = true;
  generation++;
  clearTimeout(timer);
  clearTimeout(controlsRetry);
  stopControlListener?.();
  stopControlListener = undefined;
  stopConnectionListener?.();
  stopConnectionListener = undefined;
  void stopConversationStream();
  void setSubscription(subscribedProcessId, false);
});
watch(() => props.processId, (processId, previousId) => {
  openedTask.value = null;
  rememberState(previousId);
  generation++;
  clearTimeout(timer);
  clearTimeout(controlsRetry);
  void stopConversationStream();
  void setSubscription(previousId, false);
  resetState();
  restoreState(processId);
  if (!stopped) void begin(processId);
});
// The command palette offers these selectors for the open conversation.
watch([() => props.processId, controls, ended], ([processId, value, isEnded], previous) => {
  if (previous?.[0] && previous[0] !== processId) publishIntegratedControls(previous[0], null);
  publishIntegratedControls(processId, isEnded ? null : value);
}, { immediate: true });
watch(() => props.exited, (value) => {
  if (value) forgetConversation(props.processId);
  if (Boolean(value) === ended.value) return;
  ended.value = Boolean(value);
  clearTimeout(timer);
  clearTimeout(controlsRetry);
  if (!ended.value && !stopped) void begin(props.processId);
});

async function begin(processId: string): Promise<void> {
  if (stopped || ended.value) return;
  const token = generation;
  loadingTranscript.value = true;
  try {
    await loadTranscript(processId, token);
  } finally {
    if (token === generation) {
      loadingTranscript.value = false;
      transcriptLoaded.value = true;
    }
  }
}

async function loadTranscript(processId: string, token: number): Promise<void> {
  // Control ownership and native controls never gate the transcript, so they
  // load alongside it. Both already ignore stale replies.
  void setSubscription(processId, true);
  void loadControls();
  // Streaming providers subscribe first and take a single snapshot, so a
  // switch costs one read. Subscribing is a no-op for providers without a
  // native stream; a process last seen polling skips straight to the read.
  if (canSubscribe() && cachedConversation(processId)?.streaming !== false) {
    await startConversationStream(processId, true);
    if (token !== generation || stopped || ended.value) return;
    if (!pushCapable() && conversationProcess === processId) {
      void stopConversationStream();
      scheduleRefresh();
    }
  } else {
    await refresh();
    if (token !== generation || stopped || ended.value) return;
    if (pushCapable()) void startConversationStream(processId);
    else scheduleRefresh();
  }
  // Returning to a process with an unresolved submission reconciles it.
  if (submissionFor(processId)?.state === 'uncertain') void reconcileDelivery();
}

function canSubscribe(): boolean {
  return !streamUnavailable
    && typeof window.patterm.conversationSubscribe === 'function'
    && typeof window.patterm.onConversationEvent === 'function';
}

// Called while the pane still shows processId: before a switch resets state,
// and on unmount.
function rememberState(processId: string | undefined): void {
  if (!processId) return;
  if (ended.value) {
    forgetConversation(processId);
    return;
  }
  // Nothing was loaded yet; keep any older entry rather than caching a blank.
  if (!provider.value && !messages.value.length) return;
  rememberConversation(processId, {
    messages: messages.value,
    permissions: permissions.value,
    questions: questions.value,
    forms: forms.value,
    usage: usage.value,
    tasks: tasks.value,
    queue: queue.value,
    controls: controls.value,
    provider: provider.value,
    streaming: streaming.value,
    historyTruncated: historyTruncated.value,
    historyUnavailable: historyUnavailable.value,
    historyCursor: historyCursor.value,
    historyLoaded
  });
}

function restoreState(processId: string): void {
  if (props.exited) return;
  const cached = cachedConversation(processId);
  if (!cached) return;
  messages.value = cached.messages;
  permissions.value = cached.permissions;
  applyQuestions(cached.questions);
  applyForms(cached.forms);
  usage.value = cached.usage;
  tasks.value = cached.tasks;
  queue.value = cached.queue;
  controls.value = cached.controls;
  provider.value = cached.provider;
  historyTruncated.value = cached.historyTruncated;
  historyUnavailable.value = cached.historyUnavailable;
  historyCursor.value = cached.historyCursor;
  historyLoaded = cached.historyLoaded;
}

function resetState(): void {
  messages.value = [];
  permissions.value = [];
  questions.value = [];
  forms.value = [];
  usage.value = null;
  tasks.value = [];
  queue.value = [];
  questionAnswers.value = {};
  singleQuestionAnswers.value = {};
  customQuestionAnswers.value = {};
  formAnswers.value = {};
  formErrors.value = {};
  denyFeedback.value = {};
  responding.value = {};
  error.value = '';
  refreshError.value = '';
  controlsError.value = '';
  controls.value = { selectors: [], commands: [] };
  controlling.value = window.patterm.runtime !== 'browser';
  provider.value = null;
  streamStatus.value = '';
  statusDetail.value = '';
  historyTruncated.value = false;
  historyUnavailable.value = false;
  historyCursor.value = null;
  loadingOlder.value = false;
  loadingTranscript.value = false;
  transcriptLoaded.value = false;
  historyError.value = '';
  historyLoaded = false;
  streamRevision = -1;
  bufferedStreamEvents = [];
  streamUnavailable = false;
  streaming.value = false;
  ended.value = Boolean(props.exited);
  lastConversation = '';
}

const readConversation = () => window.patterm.call('patterm.integrated.get', { process_id: props.processId }) as Promise<Record<string, unknown>>;
let refreshInFlight: { generation: number; done: Promise<void> } | null = null;
let refreshAgain = false;

// Reads requested while one is in flight for the same process share a single
// read that starts after it, so a write followed by status and pending events
// reads once. A switch never waits for the previous process's read.
function refresh(): Promise<void> {
  if (refreshInFlight?.generation === generation) {
    refreshAgain = true;
    return refreshInFlight.done;
  }
  const owner = generation;
  const done = (async () => {
    do {
      refreshAgain = false;
      await applySnapshot(readConversation);
    } while (refreshAgain && owner === generation);
  })().finally(() => { if (refreshInFlight?.done === done) refreshInFlight = null; });
  refreshInFlight = { generation: owner, done };
  return done;
}

async function applySnapshot(load: () => Promise<Record<string, unknown>>): Promise<void> {
  if (stopped || ended.value) return;
  const token = generation;
  const request = ++refreshSequence;
  beginSnapshot();
  try {
    const result = await load();
    if (token !== generation || stopped || request < appliedSequence) return;
    appliedSequence = request;
    if (typeof result.provider === 'string') provider.value = result.provider;
    historyTruncated.value = historyLoaded ? historyCursor.value !== null : result.history_truncated === true;
    historyUnavailable.value = result.history_unavailable === true;
    if (!historyLoaded) {
      const cursor = result.history_cursor as Record<string, unknown> | null | undefined;
      historyCursor.value = result.history_truncated === true && typeof cursor?.next === 'string' ? cursor.next : null;
    }
    streaming.value = result.streaming === true;
    // Claude changes its own mode when it enters plan mode or a plan is
    // approved, and Codex leaves Plan mode when a plan is approved; the
    // snapshot that follows reports the new mode.
    const mode = (result.provider === 'claude' || result.provider === 'codex') && typeof result.mode === 'string' ? result.mode : null;
    if (mode && controls.value.selectors.some((item) => item.id === 'mode' && item.value !== mode)) {
      controls.value = { ...controls.value, selectors: controls.value.selectors.map((item) => item.id === 'mode' ? { ...item, value: mode } : item) };
    }
    if (pushCapable() && typeof result.revision === 'number') streamRevision = Math.max(streamRevision, result.revision);
    if (pushCapable()) {
      const status = result.status === 'working' || result.status === 'permission' ? 'working' : result.status === 'failed' ? 'error' : result.status === 'unknown' ? 'unknown' : 'idle';
      if (status === 'working') streamStatus.value = 'working';
      else if (status === 'error') {
        streamStatus.value = 'error';
        if (typeof result.status_detail === 'string') statusDetail.value = result.status_detail;
      }
      else if (status === 'idle' && streamStatus.value !== 'error') streamStatus.value = 'idle';
    }
    // The 750ms poll mostly re-reads an unchanged conversation, so polled
    // payloads are compared before re-projecting. No cheaper exact signal
    // exists: polled providers carry no revision, and a snapshot revision is
    // captured before its payload, so equal revisions can hold different
    // content. Streamed snapshots are only taken on switch, reconnect, gaps,
    // and status or pending events, so they apply without the comparison.
    const conversation = pushCapable() ? '' : JSON.stringify([result.messages, result.permissions, result.questions, result.forms, result.usage, result.tasks, result.queue]);
    if (!conversation || conversation !== lastConversation) {
      lastConversation = conversation;
      const projection = normaliseConversation(result);
      messages.value = historyLoaded ? mergeTranscriptWindows(messages.value, projection.messages) : projection.messages;
      permissions.value = projection.permissions;
      applyQuestions(projection.questions);
      applyForms(projection.forms);
      usage.value = projection.usage;
      tasks.value = projection.tasks;
      queue.value = projection.queue;
    }
    refreshError.value = '';
    // A resumed conversation opens with little or nothing live, so show its
    // earlier turns without waiting for a scroll.
    if (!historyLoaded && historyCursor.value && messages.value.length < INITIAL_HISTORY_MESSAGES) void loadOlder();
  } catch (cause) {
    if (token !== generation || stopped || request < appliedSequence) return;
    appliedSequence = request;
    const message = cause instanceof Error ? cause.message : String(cause);
    if (isSessionUnavailableError(message)) {
      ended.value = true;
      forgetConversation(props.processId);
      clearTimeout(timer);
      refreshError.value = '';
    } else {
      refreshError.value = message;
    }
  } finally {
    endSnapshot();
  }
}

async function loadOlder(): Promise<void> {
  const cursor = historyCursor.value;
  if (!cursor || loadingOlder.value || stopped) return;
  const token = generation;
  loadingOlder.value = true;
  historyError.value = '';
  try {
    const page = await window.patterm.call('patterm.integrated.history', { process_id: props.processId, cursor }) as Record<string, unknown>;
    if (token !== generation || stopped || historyCursor.value !== cursor) return;
    const older = Array.isArray(page.archived_messages)
      ? archiveTranscript(page.archived_messages as ConversationMessageRecord[], { projectPath: props.projectPath ?? null, showReasoning: true })
      : normaliseMessages(page.messages);
    messages.value = mergeTranscriptWindows(older, messages.value);
    historyLoaded = true;
    historyCursor.value = typeof page.cursor === 'string' ? page.cursor : null;
    historyTruncated.value = historyCursor.value !== null;
  } catch (cause) {
    if (token === generation && !stopped) historyError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (token === generation) loadingOlder.value = false;
  }
}

function scheduleRefresh(): void {
  clearTimeout(timer);
  if (stopped || ended.value || pushCapable()) return;
  timer = setTimeout(() => { void poll(); }, 750);
}

async function poll(): Promise<void> {
  await refresh();
  if (submissionFor(props.processId)?.state === 'uncertain') await reconcileDelivery();
  // A process whose first read failed may turn out to stream; hand it over to
  // the stream instead of stopping without updates.
  if (pushCapable()) void startConversationStream(props.processId);
  else scheduleRefresh();
}

// Native evidence that an ambiguous prompt was admitted. Absence from one
// bounded read is unknown; the state stays visible and recoverable.
async function reconcileDelivery(): Promise<void> {
  const processId = props.processId;
  const token = generation;
  const pending = submissionFor(processId);
  if (!pending || pending.state !== 'uncertain' || reconciling) return;
  reconciling = true;
  try {
    const result = await window.patterm.call('patterm.integrated.delivery', { process_id: processId, message_id: pending.payload.messageId }) as { state?: string };
    if (token !== generation || props.processId !== processId) return;
    if (result?.state === 'accepted') {
      completeSend(processId, pending.payload, { preserveDraft: Boolean(pending.optimistic) });
      await refresh();
    }
  } catch {
    // Keep the uncertain state; the next poll retries reconciliation.
  } finally {
    reconciling = false;
  }
}

// One polling chain exists per process; manual refreshes join it instead of
// arming another timer. Submission identity lives in the per-process draft, so
// an acceptance that arrives while another pane is mounted still completes the
// originating draft.
async function sendRequest(request: ComposerSendPayload & { hash: string }, options: { force?: boolean } = {}): Promise<void> {
  const processId = props.processId;
  const token = generation;
  const mounted = () => token === generation && props.processId === processId;
  if (ended.value || (submissionFor(processId) && !options.force)) return;
  const local = pattermCommand(request);
  if (local) {
    completeSend(processId, request);
    runPattermCommand(local.name, local.text);
    return;
  }
  // Explicit new intent mints a new identity instead of reusing an unresolved
  // one; providers without native dedup would otherwise risk a second turn
  // under a supposedly-safe retry id.
  const outgoing = options.force ? { ...request, messageId: randomId() } : request;
  error.value = '';
  // Sending returns to the live edge so the reply is followed.
  transcriptRef.value?.followEnd();
  const command = nativeCommand(outgoing);
  if (command) beginSubmission(processId, outgoing);
  const optimistic = command ? null : beginOutgoingMessage(processId, outgoing, transcriptMessages.value, provider.value);
  try {
    let result: unknown;
    if (command) {
      result = await mutate('patterm.integrated.command', { process_id: processId, name: command.name, text: command.text });
    } else {
      result = await mutate('patterm.integrated.send', {
        process_id: processId,
        text: outgoing.text,
        ...(outgoing.references.length ? { references: outgoing.references } : {}),
        ...(outgoing.attachments.length ? { attachments: outgoing.attachments } : {}),
        message_id: outgoing.messageId
      });
    }
    // A native echo can prove admission before the send reply arrives. Its
    // completion must not touch a newer submission or regress delivery state.
    if (optimistic?.row.delivery?.state === 'accepted') return;
    const delivery = result && typeof result === 'object' ? result as Record<string, unknown> : {};
    if (delivery.delivery === 'uncertain') {
      markSubmissionUncertain(processId, typeof delivery.error === 'string' ? delivery.error : 'Delivery could not be confirmed.');
      if (mounted()) void reconcileDelivery();
      return;
    }
    completeSend(processId, outgoing, { preserveDraft: !command });
    // Commands such as /fast change settings the pickers show.
    if (command && mounted()) void loadControls();
    if (mounted()) await refresh();
  } catch (cause) {
    if (optimistic?.row.delivery?.state === 'accepted') return;
    const message = cause instanceof Error ? cause.message : String(cause);
    // A lost transport reply may arrive after native acceptance, so keep it
    // uncertain instead of offering a blind retry.
    if (isAmbiguousTransportError(message)) {
      markSubmissionUncertain(processId, message);
      if (mounted()) void reconcileDelivery();
    } else {
      if (command) {
        clearSubmission(processId);
        if (mounted()) error.value = message;
      } else failOutgoingMessage(processId, outgoing.messageId, message);
    }
  }
}

// Held messages wait for a native turn that takes no input, such as
// compaction, and are sent when it ends.
function queueLabel(item: IntegratedQueuedMessage): string {
  if (item.delivery === 'steer') return 'Steering';
  if (item.delivery === 'unconfirmed') return 'Not confirmed';
  if (item.delivery !== 'held') return 'Queued';
  if (item.error) return 'Not sent';
  return item.reason === 'compact' ? 'After compaction' : item.reason === 'review' ? 'After review' : 'Waiting';
}

function retryMessage(messageId: string): void {
  const entry = outgoingFor(props.processId).find((item) => item.payload.messageId === messageId);
  if (entry?.row.delivery?.state === 'failed' && canReply.value) void sendRequest(entry.payload);
}

function nativeCommand(request: ComposerSendPayload): { name: string; text: string } | null {
  const command = slashCommand(request);
  return command && command.source !== 'patterm' ? command : null;
}

function pattermCommand(request: ComposerSendPayload): { name: string; text: string } | null {
  const command = slashCommand(request);
  return command?.source === 'patterm' ? command : null;
}

function slashCommand(request: ComposerSendPayload): { name: string; text: string; source: 'patterm' | undefined } | null {
  if (request.references.length || request.attachments.length) return null;
  const slash = request.text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  const command = slash && controls.value.commands.find((item) => item.name === slash[1]);
  return command ? { name: command.name, text: slash[2] ?? '', source: command.source } : null;
}

function runPattermCommand(name: string, text: string): void {
  if (name === 'new') {
    void startNewSession();
    return;
  }
  if (name !== 'resume') return;
  resumeQuery.value = text.trim();
  resumeOpen.value = true;
}

// The backend replaces this tab when the agent is idle and opens the new
// session beside it otherwise. Either way the new session is shown.
async function startNewSession(): Promise<void> {
  if (startingNew || !props.projectId) return;
  const token = generation;
  startingNew = true;
  error.value = '';
  try {
    const result = await mutate('patterm.integrated.new', { process_id: props.processId, project_id: props.projectId }) as { session_id?: unknown };
    if (typeof result?.session_id === 'string') props.onLaunched?.(result.session_id);
  } catch (cause) {
    if (token === generation) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    startingNew = false;
  }
}

async function loadControls(): Promise<void> {
  if (stopped || ended.value) return;
  const token = generation;
  try {
    const result = await window.patterm.call('patterm.integrated.controls', { process_id: props.processId }) as Partial<IntegratedControls>;
    if (token !== generation || stopped || ended.value) return;
    controls.value = { selectors: Array.isArray(result.selectors) ? result.selectors : [], commands: Array.isArray(result.commands) ? result.commands : [] };
    controlsError.value = '';
  } catch (cause) {
    if (token !== generation || stopped || ended.value) return;
    controlsError.value = `Controls unavailable: ${cause instanceof Error ? cause.message : String(cause)}`;
    controlsRetry = setTimeout(() => void loadControls(), 2_000);
  }
}

async function configure(selectorId: string, value: string): Promise<void> {
  await runMutation('patterm.integrated.configure', { process_id: props.processId, selector: selectorId, value });
  const selector = controls.value.selectors.find((item) => item.id === selectorId);
  if (!error.value && selector) {
    controls.value = { ...controls.value, selectors: controls.value.selectors.map((item) => item === selector ? { ...item, value } : item) };
    if (selectorId === 'model') await loadControls();
  }
}

async function updateQueued(item: IntegratedQueuedMessage, action: 'steer' | 'cancel'): Promise<void> {
  await respond(`queue:${item.id}`, async () => {
    await runMutation('patterm.integrated.queue.update', { process_id: props.processId, message_id: item.id, action });
    // A cancelled held message never reaches the agent, so no native row will
    // replace its local copy.
    if (action === 'cancel' && (item.delivery === 'held' || item.delivery === 'unconfirmed') && !error.value) discardOutgoingMessage(props.processId, item.id);
  });
}

// Native evidence settles an unconfirmed held message; the refresh drops it.
async function checkHeldDelivery(item: IntegratedQueuedMessage): Promise<void> {
  await respond(`queue:${item.id}`, async () => {
    try {
      await window.patterm.call('patterm.integrated.delivery', { process_id: props.processId, message_id: item.id });
      await refresh();
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  });
}

function openTask(task: IntegratedTask): void {
  openedTask.value = task;
}

function closeTask(): void {
  const id = openedTask.value?.id;
  openedTask.value = null;
  // Return focus to the row that opened the drawer, or to the shelf's toggle
  // when the list has closed.
  if (id) void nextTick(() => (document.querySelector<HTMLElement>(`[data-component="integrated-tasks"] [data-task-id="${CSS.escape(id)}"]`) ?? document.querySelector<HTMLElement>('[data-component="integrated-tasks"] [data-tasks-trigger]'))?.focus());
}

async function stopTask(taskId: string): Promise<void> {
  await respond(`task:${taskId}`, () => runMutation('patterm.integrated.task.stop', { process_id: props.processId, task_id: taskId }));
}

async function interrupt(): Promise<void> {
  await runMutation('patterm.integrated.interrupt', { process_id: props.processId });
}

// Palette actions for this conversation run here, through the same control
// checks and error display as the composer.
function handleWorkspaceRequest(request: WorkspaceRequest): boolean {
  if (request.kind !== 'integrated' || request.processId !== props.processId || ended.value) return false;
  if (request.action === 'interrupt') void interrupt();
  else if (request.action === 'new') void startNewSession();
  else if (request.action === 'configure') void configure(request.selector, request.value);
  return true;
}

async function replyPermission(requestId: string, reply: 'once' | 'always' | 'reject'): Promise<void> {
  transcriptRef.value?.followEnd();
  const message = reply === 'reject' ? denyFeedback.value[requestId]?.trim() : '';
  await respond(requestId, () => runMutation('patterm.integrated.permission.reply', { process_id: props.processId, request_id: requestId, reply, ...(message ? { message } : {}) }));
}

// Inputs inside request cards read as rows, without a border until used.
const INLINE_INPUT_CLASS = 'block rounded-lg bg-transparent px-2 py-1.5 text-xs transition-colors placeholder:text-muted-foreground hover:bg-muted/40 focus:bg-muted/40 focus:outline-none';

// A tool called without input has nothing worth showing.
function shownResources(resources: string[]): string[] {
  return resources.filter((resource) => resource !== '{}');
}

function patchLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-muted-foreground';
  if (line.startsWith('@@')) return 'text-primary';
  if (line.startsWith('+')) return 'text-diff-add';
  if (line.startsWith('-')) return 'text-diff-remove';
  return 'text-muted-foreground';
}

// A single answer is either a chosen option or your own text, so choosing one
// clears the other; your own text joins the chosen options of a multiple answer.
function chooseQuestionAnswer(question: IntegratedQuestion, label: string, checked: boolean): void {
  if (question.multiple) {
    const chosen = questionAnswers.value[question.key] ?? [];
    questionAnswers.value = { ...questionAnswers.value, [question.key]: checked ? [...chosen, label] : chosen.filter((item) => item !== label) };
    return;
  }
  singleQuestionAnswers.value = { ...singleQuestionAnswers.value, [question.key]: label };
  customQuestionAnswers.value = { ...customQuestionAnswers.value, [question.key]: '' };
}

function setCustomQuestionAnswer(question: IntegratedQuestion, text: string): void {
  customQuestionAnswers.value = { ...customQuestionAnswers.value, [question.key]: text };
  if (!question.multiple) singleQuestionAnswers.value = { ...singleQuestionAnswers.value, [question.key]: '' };
}

async function replyQuestion(request: IntegratedQuestionRequest): Promise<void> {
  const built = buildQuestionAnswers(request.questions, {
    multiple: questionAnswers.value,
    single: singleQuestionAnswers.value,
    custom: customQuestionAnswers.value
  });
  if (!built.ok) {
    error.value = built.error;
    return;
  }
  transcriptRef.value?.followEnd();
  await respond(request.id, () => runMutation('patterm.integrated.question.reply', { process_id: props.processId, request_id: request.id, answers: built.answers }));
}

function isResponding(id: string): boolean {
  return responding.value[id] === true;
}

// One reply per request: a second click while the first is awaiting is ignored
// instead of sending a duplicate native answer.
async function respond(id: string, action: () => Promise<void>): Promise<void> {
  if (responding.value[id]) return;
  responding.value = { ...responding.value, [id]: true };
  try {
    await action();
  } finally {
    if (responding.value[id]) {
      const next = { ...responding.value };
      delete next[id];
      responding.value = next;
    }
  }
}

// Keep in-progress typed answers for still-pending forms and seed native
// defaults so every rendered field has a value to bind.
function applyForms(next: IntegratedFormRequest[]): void {
  const answers: Record<string, Record<string, unknown>> = {};
  for (const form of next) {
    const seeded: Record<string, unknown> = { ...(formAnswers.value[form.id] ?? {}) };
    for (const field of form.fields) {
      if (seeded[field.key] === undefined && field.defaultValue !== undefined) seeded[field.key] = field.defaultValue;
    }
    answers[form.id] = seeded;
  }
  forms.value = next;
  formAnswers.value = answers;
  const errors: Record<string, string> = {};
  for (const [id, message] of Object.entries(formErrors.value)) if (answers[id]) errors[id] = message;
  formErrors.value = errors;
}

function activeFields(form: IntegratedFormRequest): IntegratedFormField[] {
  return form.fields.filter((field) => formFieldVisible(field, formAnswers.value[form.id] ?? {}, form.fields));
}

// A form made only of choices shows as questions; see formAsQuestions.
function formQuestions(form: IntegratedFormRequest): IntegratedQuestionRequest | null {
  return formAsQuestions(form, activeFields(form));
}

function chooseFormOption(form: IntegratedFormRequest, key: string, label: string, checked: boolean): void {
  const field = form.fields.find((item) => item.key === key);
  if (!field) return;
  const value = formOptionValue(field, label);
  if (field.type === 'multiselect') toggleMultiselect(form.id, key, value, checked);
  else setFormAnswer(form.id, key, value);
}

// Your own text is the single answer itself, or joins a multiple answer.
function setFormCustom(form: IntegratedFormRequest, key: string, text: string): void {
  const field = form.fields.find((item) => item.key === key);
  if (field) setFormAnswer(form.id, field.type === 'multiselect' ? `${key}:custom` : key, text);
}

function setFormAnswer(formId: string, key: string, value: unknown): void {
  formAnswers.value = { ...formAnswers.value, [formId]: { ...(formAnswers.value[formId] ?? {}), [key]: value } };
}

function multiselectValue(formId: string, key: string): string[] {
  const value = formAnswers.value[formId]?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function toggleMultiselect(formId: string, key: string, option: string, checked: boolean): void {
  const current = multiselectValue(formId, key);
  setFormAnswer(formId, key, checked ? [...current, option] : current.filter((item) => item !== option));
}

function customValue(formId: string, key: string): string {
  const value = formAnswers.value[formId]?.[`${key}:custom`];
  return typeof value === 'string' ? value : '';
}

async function replyForm(form: IntegratedFormRequest): Promise<void> {
  const built = buildFormAnswer(form, formAnswers.value[form.id] ?? {});
  if (!built.ok) {
    formErrors.value = { ...formErrors.value, [form.id]: built.error };
    return;
  }
  formErrors.value = { ...formErrors.value, [form.id]: '' };
  transcriptRef.value?.followEnd();
  await respond(form.id, async () => {
    try {
      await mutate('patterm.integrated.form.reply', { process_id: props.processId, form_id: form.id, answer: built.answer });
      await refresh();
    } catch (cause) {
      formErrors.value = { ...formErrors.value, [form.id]: cause instanceof Error ? cause.message : String(cause) };
    }
  });
}

async function declineForm(form: IntegratedFormRequest): Promise<void> {
  formErrors.value = { ...formErrors.value, [form.id]: '' };
  await respond(form.id, async () => {
    try {
      await mutate('patterm.integrated.form.reply', { process_id: props.processId, form_id: form.id, answer: {}, action: 'decline' });
      await refresh();
    } catch (cause) {
      formErrors.value = { ...formErrors.value, [form.id]: cause instanceof Error ? cause.message : String(cause) };
    }
  });
}

async function takeControl(): Promise<void> {
  await window.patterm.terminalTakeControl?.({ process_id: props.processId });
}

function mutate(tool: string, args: { process_id: string } & Record<string, unknown>): Promise<unknown> {
  return window.patterm.integratedCall ? window.patterm.integratedCall(tool, args) : window.patterm.call(tool, args);
}

type SnapshotLoader = () => Promise<Record<string, unknown>>;

// A conversation that arrived with a reply, or null when the reply has none.
function replySnapshot(reply: unknown): SnapshotLoader | null {
  const value = reply && typeof reply === 'object' ? reply as { snapshot?: unknown; snapshot_error?: unknown } : {};
  if (value.snapshot && typeof value.snapshot === 'object') return async () => value.snapshot as Record<string, unknown>;
  if (typeof value.snapshot_error === 'string') return async () => { throw new Error(value.snapshot_error as string); };
  return null;
}

function refreshAfter(snapshot: SnapshotLoader | null): Promise<void> {
  return snapshot ? applySnapshot(snapshot) : refresh();
}

async function runMutation(tool: string, args: { process_id: string } & Record<string, unknown>): Promise<void> {
  const token = generation;
  error.value = '';
  try {
    await mutate(tool, args);
    if (token !== generation) return;
    await refresh();
  } catch (cause) {
    if (token === generation) error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

// Keep in-progress answers for still-pending questions and seed multi-select
// models so the checkbox bindings always have an array to update.
function applyQuestions(next: IntegratedQuestionRequest[]): void {
  const multiple: Record<string, string[]> = {};
  const single: Record<string, string> = {};
  const custom: Record<string, string> = {};
  for (const request of next) {
    for (const question of request.questions) {
      multiple[question.key] = questionAnswers.value[question.key] ?? [];
      single[question.key] = singleQuestionAnswers.value[question.key] ?? '';
      custom[question.key] = customQuestionAnswers.value[question.key] ?? '';
    }
  }
  questions.value = next;
  questionAnswers.value = multiple;
  singleQuestionAnswers.value = single;
  customQuestionAnswers.value = custom;
}

function registerControlListener(): void {
  stopControlListener?.();
  stopControlListener = window.patterm.onTerminalControl?.((state) => {
    if (state.processId === props.processId) controlling.value = state.controlling;
  });
}

function registerConversationListener(): void {
  stopConversationListener?.();
  stopConversationListener = window.patterm.onConversationEvent?.((event) => handleConversationEvent(event as ConversationStreamEvent));
}

// Subscribe first, then take an authoritative snapshot. Events that arrive
// while any snapshot is in flight are buffered and applied afterwards only when
// their revision is newer than the snapshot boundary. On a switch this runs
// before the provider is known to stream, and that single snapshot decides.
async function startConversationStream(processId: string, force = false): Promise<void> {
  if (stopped || ended.value || !canSubscribe()) return;
  const token = generation;
  if (conversationProcess === processId && !force) return;
  if (conversationProcess && conversationProcess !== processId) await stopConversationStream();
  conversationProcess = processId;
  beginSnapshot();
  try {
    // The reply carries the first snapshot, so a switch takes one round trip.
    const reply = await window.patterm.conversationSubscribe?.({ process_id: processId, subscribed: true, snapshot: true });
    if (token !== generation || conversationProcess !== processId) return;
    await refreshAfter(replySnapshot(reply));
    if (token !== generation || conversationProcess !== processId) return;
  } catch (cause) {
    if (token === generation && conversationProcess === processId) {
      // A failed subscription must not freeze the pane; fall back to bounded
      // polling until a reconnect retries the stream.
      streamUnavailable = true;
      conversationProcess = null;
      refreshError.value = cause instanceof Error ? cause.message : String(cause);
      void poll();
    }
  } finally {
    endSnapshot();
  }
}

async function stopConversationStream(): Promise<void> {
  const previous = conversationProcess;
  conversationProcess = null;
  bufferedStreamEvents = [];
  streamStatus.value = '';
  streamRevision = -1;
  if (previous) await window.patterm.conversationSubscribe?.({ process_id: previous, subscribed: false });
}

function beginSnapshot(): void {
  snapshotDepth++;
}

function endSnapshot(): void {
  if (snapshotDepth > 0) snapshotDepth--;
  if (snapshotDepth > 0) return;
  const buffered = bufferedStreamEvents.sort((left, right) => left.revision - right.revision);
  bufferedStreamEvents = [];
  for (const event of buffered) applyStreamEvent(event);
}

function handleConversationEvent(event: ConversationStreamEvent): void {
  if (stopped || !event || conversationProcess !== event.processId || props.processId !== event.processId) return;
  if (snapshotDepth > 0) {
    bufferedStreamEvents.push(event);
    return;
  }
  applyStreamEvent(event);
}

function applyStreamEvent(event: ConversationStreamEvent): void {
  if (conversationProcess !== event.processId || props.processId !== event.processId) return;
  // Connection state is transport, not transcript content: it is not subject to
  // the snapshot revision boundary, and it must never inflate the native
  // revision domain that snapshots and deltas share.
  if (event.kind === 'reconnecting' || event.id === 'connection_error') {
    if (event.kind === 'reconnecting') streamStatus.value = 'reconnecting';
    if (event.id === 'connection_error') {
      streamStatus.value = 'error';
      messages.value = applyConversationStreamEvent(messages.value, event);
    }
    return;
  }
  // Patterm's held queue changed. Re-read it without touching the native
  // revision order.
  if (event.id === HELD_QUEUE_EVENT_ID) {
    void refresh();
    return;
  }
  if (!Number.isFinite(event.revision) || event.revision <= streamRevision) return;
  // A revision jump means events were missed (for example a dropped transport).
  // Apply what arrived, then re-read the authoritative snapshot to heal it.
  const gap = streamRevision >= 0 && event.revision > streamRevision + 1;
  streamRevision = event.revision;
  if (event.kind === 'replace' || event.kind === 'append' || event.kind === 'error') {
    messages.value = applyConversationStreamEvent(messages.value, event);
    if (event.kind === 'error') streamStatus.value = 'error';
    if (gap) void refresh();
    return;
  }
  if (event.kind === 'status' && event.status) {
    streamStatus.value = event.status === 'unknown' ? '' : event.status;
    statusDetail.value = event.status === 'error' ? event.detail ?? '' : '';
    // Completion and interruption re-read the authoritative snapshot.
    if (event.status !== 'working' || gap) void refresh();
    return;
  }
  if (event.kind === 'pending' || gap) void refresh();
}

async function setSubscription(processId: string | null, subscribed: boolean): Promise<void> {
  if (!processId || window.patterm.runtime !== 'browser' || !window.patterm.terminalSubscribe) return;
  // Track the intended subscription synchronously, and clear it before awaiting
  // an unsubscribe. Acknowledgements are ordered by this sequence so an older
  // A-B-A reply cannot clobber the newest intent.
  const token = ++subscriptionSequence;
  if (subscribed) subscribedProcessId = processId;
  else if (subscribedProcessId === processId) subscribedProcessId = null;
  try {
    const result = await window.patterm.terminalSubscribe({ process_id: processId, subscribed }) as { controlling?: boolean } | undefined;
    if (token !== subscriptionSequence) return;
    if (subscribed && processId === props.processId && typeof result?.controlling === 'boolean') controlling.value = result.controlling;
  } catch { /* Terminal subscription only tracks browser control ownership. */ }
}
</script>
