import { toast } from 'vue-sonner';

const CALLBACK_URL = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+\/\S*[?&](code|error)=/;

type PasteResult = { handled: false } | { handled: true; kind: 'patterm' | 'agent'; name?: string };

// A sign-in that fails in the browser leaves the user on a loopback address
// carrying the code. Cheap and synchronous, so ordinary pastes are unaffected.
export function isMcpCallbackPaste(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length < 8192 && !/\s/.test(trimmed) && trimmed.includes('state=') && CALLBACK_URL.test(trimmed);
}

// Returns true when the paste was taken over; the caller then cancels the
// default paste. Patterm finishes its own sign-in or replays an agent CLI's;
// anything it does not recognise is pasted normally through `fallback`.
export function interceptMcpCallbackPaste(text: string, fallback: (text: string) => void): boolean {
  if (!isMcpCallbackPaste(text)) return false;
  void (window.patterm.call('mcp_callback_paste', { url: text.trim() }) as Promise<PasteResult>)
    .then((result) => {
      if (!result.handled) { fallback(text); return; }
      toast.success(result.kind === 'patterm' ? `Signed in to ${result.name ?? 'the MCP server'}` : "Finished the agent's sign-in");
    })
    .catch(() => fallback(text));
  return true;
}
