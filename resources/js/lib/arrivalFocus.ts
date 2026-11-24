import { touchScreen } from './touch';

// The input a page focuses when you arrive at it: an agent's composer, a
// terminal, or the new conversation page's first message.
const ARRIVAL_INPUT = '[data-patterm-integrated-input], [data-patterm-terminal-input], [data-patterm-new-conversation-input]';

// A dialog that navigated somewhere hands focus to that page's input rather
// than back to the control that opened it, which the page has replaced.
// Returns whether an input took focus.
export function focusArrivalInput(): boolean {
  if (touchScreen()) return false;
  // Kept-alive pages and hidden panes keep their inputs in the document.
  const input = Array.from(document.querySelectorAll<HTMLElement>(ARRIVAL_INPUT)).find((element) => element.getClientRects().length > 0);
  if (!input) return false;
  input.focus();
  return true;
}
