import { ref } from 'vue';

// The new conversation page's unsent first message. It survives switching
// tabs, and a launch that fails hands its message back here.
export const newConversationDraft = ref('');

// Its attachments wait in one composer draft. Each upload goes to the machine
// the agent will start on: a paired host's route carries its name, which the
// upload endpoint reads to store the file there.
export const NEW_CONVERSATION_DRAFT = 'new-conversation';
export function newConversationRoute(host: string | null | undefined): string {
  return host ? `${host}:${NEW_CONVERSATION_DRAFT}` : NEW_CONVERSATION_DRAFT;
}

const HARNESS_KEY = 'patterm.newConversation.harness';

// The agent CLI the page last started, so it opens on that one again.
export function lastNewConversationHarness(): string | null {
  try {
    return localStorage.getItem(HARNESS_KEY);
  } catch {
    return null;
  }
}

export function rememberNewConversationHarness(harness: string): void {
  try {
    localStorage.setItem(HARNESS_KEY, harness);
  } catch {
    // Without storage the page opens on the first installed CLI.
  }
}
