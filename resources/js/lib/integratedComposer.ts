// Rich composer state for Integrated conversations. Drafts are keyed by
// process so switching tabs restores text, references, and attachments, and a
// rejected send can be retried without losing the user's edits. Pure helpers
// sit at the top so tests can exercise them directly.

import { reactive, ref } from 'vue';
import { containsReferenceToken, referenceToken } from '../../../app/Services/PromptReferences';
import { CHIP, type ComposerChip } from './composerDocument';
import { transcriptMessageKey, type IntegratedQueuedMessage, type TranscriptMessage } from './integratedConversation';
import { randomId } from './randomId';

export { referenceToken };

export interface ComposerReference {
  path: string;
  name: string;
}

export interface ComposerAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  image: boolean;
  status: 'uploading' | 'ready' | 'error';
  error?: string | undefined;
  serverPath?: string | undefined;
  previewUrl?: string | undefined;
}

export interface ComposerSubmission {
  state: 'sending' | 'uncertain';
  optimistic?: boolean;
  message: string;
  payload: ComposerSendPayload & { hash: string };
  hash: string;
}

export interface ComposerDraft {
  // Each mention chip is one CHIP character, matched in order with `chips`.
  text: string;
  // Files picked from the @ menu. The text is the source of truth: a picked
  // file is sent only while its token is still in the text, so deleting the
  // token removes the reference and a typed `@name` is never treated as one.
  references: ComposerReference[];
  // The mention chips in the text, in order.
  chips: ComposerChip[];
  attachments: ComposerAttachment[];
  lastAttempt?: { hash: string; messageId: string } | undefined;
  // In-flight or unresolved submission for this process. It is deliberately
  // independent of which pane is mounted so switching views cannot clear a
  // safety state or drop the identity of a submitted payload.
  submission?: ComposerSubmission | undefined;
}

export interface ComposerSendPayload {
  text: string;
  references: ComposerReference[];
  attachments: Array<{ path: string; name: string; mime: string }>;
  messageId: string;
}

const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const TEXT_MIME = /^text\/|^application\/(json|ld\+json|toml|x-toml|yaml|x-yaml|xml)$/;
const SUPPORTED_EXTENSIONS = new Set([
  'c', 'cc', 'cjs', 'conf', 'cpp', 'css', 'csv', 'cts', 'env', 'go', 'gql', 'graphql', 'h', 'hh', 'hpp',
  'htm', 'html', 'ini', 'java', 'js', 'json', 'jsx', 'log', 'md', 'mdx', 'mjs', 'mts', 'pdf', 'py', 'rb',
  'rs', 'sass', 'scss', 'sh', 'sql', 'toml', 'ts', 'tsx', 'txt', 'xml', 'yaml', 'yml', 'zsh'
]);
const MIME_BY_EXTENSION: Record<string, string> = {
  gif: 'image/gif', jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  json: 'application/json', md: 'text/markdown', pdf: 'application/pdf', toml: 'application/toml',
  yaml: 'application/yaml', yml: 'application/yaml'
};

function fileExtension(name: string): string {
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(index + 1).toLowerCase() : '';
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith('image/');
}

export function attachmentMime(file: { name: string; type: string }): string | null {
  const extension = fileExtension(file.name);
  if (IMAGE_MIME.has(file.type) || TEXT_MIME.test(file.type)) return file.type;
  if (SUPPORTED_EXTENSIONS.has(extension)) return file.type || MIME_BY_EXTENSION[extension] || 'application/octet-stream';
  return null;
}

// A mention starts at `@` after whitespace or at the start of the text, so an
// email address such as `me@example.com` does not open the file menu.
export function mentionQuery(text: string, caret: number): { query: string; start: number } | null {
  const match = text.slice(0, caret).match(/(?:^|\s)@([^\s@"]*)$/);
  if (!match) return null;
  const query = match[1] ?? '';
  return { query, start: caret - query.length - 1 };
}

export function sentReferences(draft: Pick<ComposerDraft, 'text' | 'references'>): ComposerReference[] {
  return draft.references.filter((reference) => containsReferenceToken(draft.text, reference.path));
}

// The text as sent: each chip becomes its token, an agent's process ID or a
// launch token.
export function outgoingText(draft: Pick<ComposerDraft, 'text' | 'chips'>): string {
  let next = 0;
  return draft.text.replaceAll(CHIP, () => draft.chips[next++]?.token ?? '').trim();
}

// Splits text into matched and unmatched runs for highlighting. `offset` is
// the index of `text` within the string the positions refer to.
export function highlightRuns(text: string, positions: readonly number[] | undefined, offset = 0): Array<{ text: string; match: boolean }> {
  const matched = new Set(positions ?? []);
  const runs: Array<{ text: string; match: boolean }> = [];
  for (let index = 0; index < text.length; index++) {
    const match = matched.has(offset + index);
    const last = runs[runs.length - 1];
    if (last && last.match === match) last.text += text[index];
    else runs.push({ text: text[index]!, match });
  }
  return runs;
}

export function slashQuery(text: string): { query: string } | null {
  const match = text.match(/^\/([^\s]*)$/);
  return match ? { query: match[1] ?? '' } : null;
}

// Ranks exact names first, then prefixes, then matches at a word boundary,
// then any substring. Shorter names win ties so `/compact` picks `compact`
// over `compact-history`. An empty query keeps the provider order.
export function rankCommands<T extends { name: string }>(commands: T[], query: string): T[] {
  const needle = query.toLowerCase();
  if (!needle) return commands;
  const rank = (name: string): number => {
    if (name === needle) return 0;
    if (name.startsWith(needle)) return 1;
    const index = name.indexOf(needle);
    if (index < 0) return -1;
    return /[^a-z0-9]/.test(name[index - 1]!) ? 2 : 3;
  };
  return commands
    .map((command, order) => ({ command, order, name: command.name.toLowerCase() }))
    .map((entry) => ({ ...entry, rank: rank(entry.name) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.name.length - b.name.length || a.order - b.order)
    .map((entry) => entry.command);
}

export function payloadHash(text: string, references: Array<{ path: string }>, attachments: Array<{ path: string }>): string {
  return JSON.stringify([text.trim(), references.map((reference) => reference.path), attachments.map((attachment) => attachment.path)]);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

const drafts = reactive(new Map<string, ComposerDraft>());
const files = new Map<string, File>();

interface OutgoingMessage {
  payload: ComposerSendPayload & { hash: string };
  row: TranscriptMessage;
  afterId: string | null;
  previewUrls: string[];
}

// Presentation state only. Native history remains authoritative, and matched
// rows are released after acknowledgement. Unresolved sends survive tab changes.
const outgoing = reactive(new Map<string, OutgoingMessage[]>());

export function outgoingFor(processId: string): OutgoingMessage[] {
  return outgoing.get(processId) ?? [];
}

export function beginOutgoingMessage(processId: string, payload: ComposerSendPayload & { hash: string }, messages: TranscriptMessage[], provider: string | null): OutgoingMessage {
  let entries = outgoing.get(processId);
  if (!entries) {
    entries = reactive([]) as OutgoingMessage[];
    outgoing.set(processId, entries);
  }
  let entry = entries.find((item) => item.payload.messageId === payload.messageId);
  if (!entry) {
    const draft = draftFor(processId);
    const attachments = payload.attachments.map((attachment) => {
      const preview = draft.attachments.find((item) => item.serverPath === attachment.path)?.previewUrl;
      return { name: attachment.name, mime: attachment.mime, ...(preview ? { url: preview } : {}) };
    });
    entry = {
      payload,
      afterId: messages.length ? transcriptMessageKey(messages.at(-1)!) : null,
      previewUrls: attachments.flatMap((attachment) => attachment.url ? [attachment.url] : []),
      row: {
        id: `${provider === 'opencode' ? 'msg_' : 'user_'}${payload.messageId}`,
        role: 'user', kind: 'text', text: payload.text,
        createdAt: new Date().toISOString(),
        attachments,
        fileReferences: payload.references.map((reference) => reference.path),
        delivery: { state: 'sending', messageId: payload.messageId }
      }
    };
    // Transfer image previews to the bubble before consuming this draft.
    consumeDraft(processId, payload, true);
    entries.push(entry);
    entry = entries.at(-1)!;
  }
  entry.row.delivery = { state: 'sending', messageId: payload.messageId };
  beginSubmission(processId, payload);
  draftFor(processId).submission!.optimistic = true;
  return entry;
}

function matchesOutgoing(entry: OutgoingMessage, message: TranscriptMessage): boolean {
  return message.role === 'user' && !message.parentId
    && (message.id === entry.row.id || message.clientMessageId === entry.payload.messageId);
}

// Native queues list the row id; Patterm's held queue lists the message id.
function isQueued(entry: OutgoingMessage, queued: Set<string>): boolean {
  return queued.has(entry.row.id) || queued.has(entry.payload.messageId);
}

export function outgoingTranscript(processId: string, messages: TranscriptMessage[], queue: IntegratedQueuedMessage[]): TranscriptMessage[] {
  const entries = outgoingFor(processId);
  if (!entries.length && !queue.length) return messages;
  const queued = new Set(queue.map((item) => item.id));
  const visible = queue.length ? messages.filter((message) => !queued.has(message.id)) : messages;
  const pending = entries.filter((entry) => !isQueued(entry, queued) && !messages.some((message) => matchesOutgoing(entry, message)));
  // Prompts the harness queued natively follow the running turn as greyed
  // messages, as a send does on the other harnesses. Patterm's held queue
  // keeps its own list above the composer.
  const waiting = queue.filter((item) => item.delivery === 'queue' || item.delivery === 'steer').map((item): TranscriptMessage => {
    const local = entries.find((entry) => entry.row.id === item.id || entry.payload.messageId === item.id)?.row;
    return {
      ...(local ?? { id: item.id, role: 'user', kind: 'text', text: item.text }),
      delivery: { state: 'queued', messageId: item.id }
    };
  });
  if (!pending.length) return waiting.length ? [...visible, ...waiting] : visible;
  // Keep the send beside the content visible at submission, even while more
  // assistant rows stream in. Entries sharing an anchor retain send order.
  const result = [...visible];
  const lastAtAnchor = new Map<string | null, string>();
  for (const entry of pending) {
    const afterId = lastAtAnchor.get(entry.afterId) ?? entry.afterId;
    const index = afterId === null ? -1 : result.findIndex((message) => transcriptMessageKey(message) === afterId);
    result.splice(index === -1 && afterId !== null ? result.length : index + 1, 0, entry.row);
    lastAtAnchor.set(entry.afterId, transcriptMessageKey(entry.row));
  }
  return [...result, ...waiting];
}

export function reconcileOutgoingMessages(processId: string, messages: TranscriptMessage[], queue: IntegratedQueuedMessage[]): void {
  const entries = outgoingFor(processId);
  const remaining = entries.filter((entry) => {
    const native = messages.some((message) => matchesOutgoing(entry, message));
    if (!native && !isQueued(entry, new Set(queue.map((item) => item.id)))) return true;
    completeSend(processId, entry.payload, { preserveDraft: true });
    // A queue acknowledgement proves acceptance, but keep the local copy
    // until its transcript row arrives, including the gap as it leaves a queue.
    if (!native) return true;
    for (const url of entry.previewUrls) URL.revokeObjectURL(url);
    return false;
  });
  if (remaining.length !== entries.length) {
    if (remaining.length) outgoing.set(processId, remaining);
    else outgoing.delete(processId);
  }
}

export function discardOutgoingMessage(processId: string, messageId: string): void {
  const entries = outgoingFor(processId);
  const remaining = entries.filter((entry) => entry.payload.messageId !== messageId);
  if (remaining.length === entries.length) return;
  for (const entry of entries) if (entry.payload.messageId === messageId) for (const url of entry.previewUrls) URL.revokeObjectURL(url);
  if (remaining.length) outgoing.set(processId, remaining);
  else outgoing.delete(processId);
}

export function failOutgoingMessage(processId: string, messageId: string, error: string): void {
  const entry = outgoingFor(processId).find((item) => item.payload.messageId === messageId);
  if (entry) entry.row.delivery = { state: 'failed', messageId, error };
  if (submissionFor(processId)?.payload.messageId === messageId) clearSubmission(processId);
}

// The session whose row is highlighted in the @ menu. The tab strip and the
// sidebar make that agent's tab or row glow, so the user can see which agent a
// title belongs to.
export const mentionPreview = ref<string | null>(null);

export function draftFor(processId: string): ComposerDraft {
  let draft = drafts.get(processId);
  if (!draft) {
    draft = reactive({ text: '', references: [], chips: [], attachments: [] }) as ComposerDraft;
    drafts.set(processId, draft);
  }
  return draft;
}

export function addReference(processId: string, path: string, name: string): void {
  const draft = draftFor(processId);
  if (!draft.references.some((reference) => reference.path === path)) draft.references.push({ path, name });
}

export async function addFiles(processId: string, incoming: File[]): Promise<void> {
  const draft = draftFor(processId);
  for (const file of incoming) {
    const mime = attachmentMime(file);
    const id = randomId();
    if (!mime) {
      draft.attachments.push({ id, name: file.name, mime: file.type || 'application/octet-stream', size: file.size, image: false, status: 'error', error: `${file.name} is not a supported attachment type` });
      continue;
    }
    files.set(id, file);
    const attachment: ComposerAttachment = {
      id, name: file.name, mime, size: file.size, image: isImageMime(mime),
      status: 'uploading',
      ...(isImageMime(mime) && typeof URL !== 'undefined' && URL.createObjectURL ? { previewUrl: URL.createObjectURL(file) } : {})
    };
    draft.attachments.push(attachment);
    void uploadAttachment(processId, id);
  }
}

export async function retryUpload(processId: string, attachmentId: string): Promise<void> {
  const attachment = draftFor(processId).attachments.find((item) => item.id === attachmentId);
  if (!attachment || !files.has(attachmentId)) return;
  attachment.status = 'uploading';
  attachment.error = undefined;
  await uploadAttachment(processId, attachmentId);
}

export function removeAttachment(processId: string, attachmentId: string): void {
  const draft = draftFor(processId);
  const attachment = draft.attachments.find((item) => item.id === attachmentId);
  if (attachment?.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  files.delete(attachmentId);
  draft.attachments = draft.attachments.filter((item) => item.id !== attachmentId);
}

export function payloadFor(processId: string): { ok: true; payload: ComposerSendPayload; hash: string } | { ok: false; error: string } {
  const draft = draftFor(processId);
  if (draft.attachments.some((attachment) => attachment.status === 'error')) {
    return { ok: false, error: 'Remove failed attachments before sending.' };
  }
  if (draft.attachments.some((attachment) => attachment.status !== 'ready')) {
    return { ok: false, error: 'Wait for attachments to finish uploading.' };
  }
  const text = outgoingText(draft);
  const references = sentReferences(draft).map((reference) => ({ path: reference.path, name: reference.name }));
  const attachments = draft.attachments.map((attachment) => ({ path: attachment.serverPath as string, name: attachment.name, mime: attachment.mime }));
  if (!text && !references.length && !attachments.length) return { ok: false, error: 'Message is empty.' };
  const hash = payloadHash(text, references, attachments);
  if (!draft.lastAttempt || draft.lastAttempt.hash !== hash) draft.lastAttempt = { hash, messageId: randomId() };
  return { ok: true, payload: { text, references, attachments, messageId: draft.lastAttempt.messageId }, hash };
}

// A successful send consumes the delivered attachments and the submission
// marker. It must be called with the originating process id so an
// acceptance that arrives while another pane is mounted still completes there.
export function completeSend(processId: string, submitted: ComposerSendPayload & { hash: string }, options: { preserveDraft?: boolean } = {}): void {
  const draft = draftFor(processId);
  const entry = outgoingFor(processId).find((item) => item.payload.messageId === submitted.messageId);
  if (entry && entry.row.delivery?.state !== 'accepted') entry.row.delivery = { state: 'accepted', messageId: submitted.messageId };
  if (draft.submission?.payload.messageId === submitted.messageId) draft.submission = undefined;
  if (!options.preserveDraft) consumeDraft(processId, submitted);
}

function consumeDraft(processId: string, submitted: ComposerSendPayload & { hash: string }, keepPreviews = false): void {
  const draft = draftFor(processId);
  const current = payloadHash(outgoingText(draft), sentReferences(draft), draft.attachments.map((attachment) => ({ path: attachment.serverPath ?? '' })));
  const deliveredAttachments = new Set(submitted.attachments.map((attachment) => attachment.path));
  for (const attachment of [...draft.attachments]) {
    if (!deliveredAttachments.has(attachment.serverPath ?? '')) continue;
    if (attachment.previewUrl && !keepPreviews) URL.revokeObjectURL(attachment.previewUrl);
    files.delete(attachment.id);
    draft.attachments = draft.attachments.filter((item) => item.id !== attachment.id);
  }
  // Picked references stay while newer text is kept: a token still in that
  // text must be sent again with it, and one no longer there is not sent.
  if (current === submitted.hash) {
    draft.text = '';
    draft.attachments = [];
    draft.references = [];
    draft.chips = [];
  }
  draft.lastAttempt = undefined;
}

export function submissionFor(processId: string): ComposerSubmission | undefined {
  return draftFor(processId).submission;
}

export function beginSubmission(processId: string, payload: ComposerSendPayload & { hash: string }): void {
  const draft = draftFor(processId);
  draft.submission = { state: 'sending', message: '', payload: { ...payload, references: [...payload.references], attachments: [...payload.attachments] }, hash: payload.hash };
}

export function markSubmissionUncertain(processId: string, message: string): void {
  const draft = draftFor(processId);
  if (!draft.submission) return;
  draft.submission = { ...draft.submission, state: 'uncertain', message };
  const entry = outgoingFor(processId).find((item) => item.payload.messageId === draft.submission!.payload.messageId);
  if (entry) entry.row.delivery = { state: 'uncertain', messageId: entry.payload.messageId, error: message };
}

export function clearSubmission(processId: string): void {
  draftFor(processId).submission = undefined;
}

// Browser and desktop transports report a lost reply differently from an
// application-level rejection. A lost reply may arrive after the backend
// already accepted the prompt, so it must stay uncertain rather than become a
// retryable error.
export function isAmbiguousTransportError(message: string): boolean {
  return /timed out|connection lost|disconnected|reconnecting|connection is too slow/i.test(message);
}

export function clearDrafts(): void {
  for (const entries of outgoing.values()) for (const entry of entries) for (const url of entry.previewUrls) URL.revokeObjectURL(url);
  outgoing.clear();
  for (const [processId, draft] of drafts) {
    for (const attachment of draft.attachments) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      files.delete(attachment.id);
    }
    drafts.delete(processId);
  }
}

// Uploads mutate the reactive item found by id. Mutating the raw object that
// was pushed into the array would not notify Vue.
async function uploadAttachment(processId: string, attachmentId: string): Promise<void> {
  const file = files.get(attachmentId);
  const draft = draftFor(processId);
  const update = (fields: Partial<ComposerAttachment>): void => {
    const current = draft.attachments.find((item) => item.id === attachmentId);
    if (current) Object.assign(current, fields);
  };
  if (!file) {
    update({ status: 'error', error: 'The file is no longer available. Remove it and add it again.' });
    return;
  }
  try {
    const upload = window.patterm.uploadFile;
    if (!upload) throw new Error('Attachments are unavailable in this client.');
    const path = await upload(file, processId);
    update({ serverPath: path, status: 'ready', error: undefined });
  } catch (cause) {
    update({ status: 'error', error: cause instanceof Error ? cause.message : String(cause) });
  }
}
