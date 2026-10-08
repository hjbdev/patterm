import { onBeforeUnmount, ref } from 'vue';

// One hover popover among many, keyed by its trigger. It opens on hover or
// focus and closes shortly after the pointer leaves both trigger and popover,
// unless a context menu opened from inside it is still showing.
export function useHoverPopover(blocked: () => boolean = () => false) {
  const hoverKey = ref<string | null>(null);
  let menuKey: string | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelClose(): void {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = null;
  }

  function open(key: string): void {
    if (blocked()) return;
    cancelClose();
    hoverKey.value = key;
  }

  function close(): void {
    cancelClose();
    hoverKey.value = null;
  }

  function scheduleClose(): void {
    if (menuKey) return;
    cancelClose();
    closeTimer = setTimeout(() => {
      hoverKey.value = null;
      closeTimer = null;
    }, 100);
  }

  // For a popover's `update:open`.
  function update(key: string, isOpen: boolean): void {
    if (isOpen) open(key);
    else if (hoverKey.value === key) hoverKey.value = null;
  }

  // A context menu opening or closing inside the popover for `key`.
  function holdForMenu(key: string, isOpen: boolean): void {
    if (isOpen) {
      cancelClose();
      hoverKey.value = key;
      menuKey = key;
    } else if (menuKey === key) {
      menuKey = null;
      scheduleClose();
    }
  }

  onBeforeUnmount(cancelClose);
  return { hoverKey, open, close, scheduleClose, cancelClose, update, holdForMenu };
}
