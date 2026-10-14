import { onBeforeUnmount, onMounted, ref } from 'vue';

// A field can keep focus after the user dismisses the on-screen keyboard, so
// focus alone can't say whether the keyboard is up. It is up while a field has
// focus and the visual viewport is well short of its tallest height at this
// width. The margin ignores browser toolbars collapsing.
const KEYBOARD_MIN_HEIGHT = 150;

function editableFocused(): boolean {
  const element = document.activeElement;
  return element instanceof HTMLElement && (element.matches('input, textarea') || element.isContentEditable);
}

export function useSoftKeyboard() {
  const open = ref(false);
  let width = 0;
  let tallest = 0;

  function update(): void {
    const viewport = window.visualViewport;
    if (!viewport) return;
    // Rotating or resizing the window starts a new baseline.
    if (window.innerWidth !== width) {
      width = window.innerWidth;
      tallest = 0;
    }
    tallest = Math.max(tallest, viewport.height);
    open.value = editableFocused() && tallest - viewport.height > KEYBOARD_MIN_HEIGHT;
  }

  onMounted(() => {
    update();
    window.visualViewport?.addEventListener('resize', update);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
  });
  onBeforeUnmount(() => {
    window.visualViewport?.removeEventListener('resize', update);
    document.removeEventListener('focusin', update);
    document.removeEventListener('focusout', update);
  });

  return open;
}
