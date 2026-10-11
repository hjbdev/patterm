import { onBeforeUnmount, shallowRef, type ShallowRef } from 'vue';

// A card beside the sidebar row you point at. It opens once the pointer has
// rested on a row for a moment, or at once for a row reached with the
// keyboard. While it's open, pointing at another row moves it there after a
// beat, so crossing rows on the way to the card doesn't flip it. It stays
// while the pointer is on the card or a menu is open, and goes on a click, on
// Esc, or shortly after the pointer leaves both.
const OPEN_MS = 450;
const SWITCH_MS = 110;
const CLOSE_MS = 160;
// Pointing at another row just after a card closed opens it at once, as tooltips do.
const WARM_MS = 400;

export interface RowHoverCard {
  // The row the card is beside, and the last one, which the card keeps while it fades out.
  row: Readonly<ShallowRef<HTMLElement | null>>;
  last: Readonly<ShallowRef<HTMLElement | null>>;
  close: () => void;
  // The card closed itself, on Esc or a click elsewhere: the row stays quiet until left.
  dismiss: () => void;
  // On the sidebar.
  onPointerMove: (event: PointerEvent) => void;
  onPointerLeave: () => void;
  onPointerDown: (event: PointerEvent) => void;
  onFocusIn: (event: FocusEvent) => void;
  onFocusOut: (event: FocusEvent) => void;
  // On the card.
  onCardEnter: () => void;
  onCardLeave: () => void;
}

// `rowAt` finds the row that has a card for an event's target; `card` is the card's element.
export function useRowHoverCard(rowAt: (target: EventTarget | null) => HTMLElement | null, card: () => HTMLElement | null): RowHoverCard {
  const row = shallowRef<HTMLElement | null>(null);
  const last = shallowRef<HTMLElement | null>(null);
  let pending: { row: HTMLElement; timer: ReturnType<typeof setTimeout> } | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let closedAt = 0;
  // A row clicked or dismissed shows no card until the pointer has left it.
  let quiet: HTMLElement | null = null;
  let onCard = false;
  let fromKeyboard = false;

  function cancelPending(): void {
    if (pending) clearTimeout(pending.timer);
    pending = null;
  }

  function show(next: HTMLElement): void {
    cancelPending();
    clearTimeout(closeTimer);
    row.value = next;
    last.value = next;
  }

  function close(): void {
    cancelPending();
    clearTimeout(closeTimer);
    if (row.value) closedAt = Date.now();
    row.value = null;
    onCard = false;
    fromKeyboard = false;
  }

  // A click on a row closes the card before the popover's own outside-click
  // does, so by then there's nothing open and the clicked row stays quiet.
  function dismiss(): void {
    if (row.value) quiet = row.value;
    close();
  }

  function menuOpen(): boolean {
    return Boolean(document.querySelector('[role="menu"][data-state="open"]'));
  }

  function scheduleClose(): void {
    clearTimeout(closeTimer);
    const check = (): void => {
      if (onCard) return;
      // A menu opened from the card keeps it until the menu closes.
      if (menuOpen()) {
        closeTimer = setTimeout(check, CLOSE_MS);
        return;
      }
      close();
    };
    closeTimer = setTimeout(check, CLOSE_MS);
  }

  function onPointerMove(event: PointerEvent): void {
    if (event.pointerType === 'touch') return;
    // Dragging a row to reorder it.
    if (event.buttons) return close();
    fromKeyboard = false;
    const target = rowAt(event.target);
    if (target !== quiet) quiet = null;
    if (!target || target === quiet) {
      cancelPending();
      if (row.value) scheduleClose();
      return;
    }
    clearTimeout(closeTimer);
    if (target === row.value) return cancelPending();
    if (pending?.row === target || menuOpen()) return;
    cancelPending();
    const delay = row.value ? SWITCH_MS : Date.now() - closedAt < WARM_MS ? 0 : OPEN_MS;
    pending = { row: target, timer: setTimeout(() => show(target), delay) };
  }

  function onPointerLeave(): void {
    cancelPending();
    quiet = null;
    if (row.value) scheduleClose();
  }

  // Clicking a row opens its agent; the card would only cover it.
  function onPointerDown(event: PointerEvent): void {
    close();
    quiet = rowAt(event.target);
  }

  function onFocusIn(event: FocusEvent): void {
    if (!(event.target instanceof Element) || !event.target.matches(':focus-visible')) return;
    const target = rowAt(event.target);
    if (target) {
      show(target);
      fromKeyboard = true;
    } else if (fromKeyboard) {
      close();
    }
  }

  function onFocusOut(event: FocusEvent): void {
    if (!fromKeyboard) return;
    const next = event.relatedTarget;
    if (next instanceof Node && ((event.currentTarget as HTMLElement).contains(next) || card()?.contains(next))) return;
    close();
  }

  function onCardEnter(): void {
    onCard = true;
    clearTimeout(closeTimer);
    cancelPending();
  }

  function onCardLeave(): void {
    onCard = false;
    scheduleClose();
  }

  onBeforeUnmount(close);
  return { row, last, close, dismiss, onPointerMove, onPointerLeave, onPointerDown, onFocusIn, onFocusOut, onCardEnter, onCardLeave };
}
