import { ref } from 'vue';

// The new conversation page's unsent first message. It survives switching
// tabs, and a launch that fails hands its message back here.
export const newConversationDraft = ref('');

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
