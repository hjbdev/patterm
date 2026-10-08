import { nextTick, watch, type Ref } from 'vue';

type FocusableRef = Ref<{ $el?: unknown } | HTMLElement | null>;

export function focusElement(target: FocusableRef | null | undefined): void {
  const candidate = target?.value;
  const element = candidate instanceof HTMLElement ? candidate : candidate?.$el;
  if (element instanceof HTMLElement) {
    element.focus();
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.select();
    }
  }
}

export function useAutofocus(open: Ref<boolean>, target: FocusableRef): void {
  watch(open, async (isOpen) => {
    if (!isOpen) return;
    await nextTick();
    focusElement(target);
  });
}
