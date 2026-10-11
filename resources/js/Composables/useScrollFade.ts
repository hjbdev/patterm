import { computed, ref, type ComputedRef, type Ref, type StyleValue } from 'vue';
import { useResizeObserver } from '@vueuse/core';

// Fades a scroller's top or bottom edge while there's more to show past it,
// so a cut-off row reads as more to scroll to rather than a clipped one.
// Watches both the scroller and its content; call `measure` on scroll.
export function useScrollFade(scroller: Ref<HTMLElement | null>, content: Ref<HTMLElement | null>): { style: ComputedRef<StyleValue | undefined>; measure: () => void } {
  const edges = ref({ top: false, bottom: false });

  function measure(): void {
    const element = scroller.value;
    if (!element) return;
    const top = element.scrollTop > 1;
    const bottom = element.scrollTop + element.clientHeight < element.scrollHeight - 1;
    // Scrolling fires often; only a change at an edge needs a new mask.
    if (top !== edges.value.top || bottom !== edges.value.bottom) edges.value = { top, bottom };
  }
  useResizeObserver(scroller, measure);
  useResizeObserver(content, measure);

  const style = computed<StyleValue | undefined>(() => {
    const { top, bottom } = edges.value;
    if (!top && !bottom) return undefined;
    const mask = `linear-gradient(to bottom, ${top ? 'transparent, #000 20px' : '#000'}, ${bottom ? '#000 calc(100% - 20px), transparent' : '#000'})`;
    return { maskImage: mask, WebkitMaskImage: mask };
  });
  return { style, measure };
}
