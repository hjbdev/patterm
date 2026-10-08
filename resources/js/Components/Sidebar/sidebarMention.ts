import { computed, nextTick, watch, type ComputedRef } from 'vue';
import { mentionPreview } from '../../lib/integratedComposer';
import type { StripTab } from '../../lib/tabStrip';

export interface SidebarMention {
  // The highlighted agent's session.
  sessionId: string;
  // Its family's tab, and the agents above it within that family.
  tabKey: string;
  ancestors: ReadonlySet<string>;
}

// An agent highlighted in a composer's @ menu glows in the sidebar, as its tab
// does in the strip. `rowFor` finds the element to bring into view; the list
// scrolls back when the highlight ends.
export function useSidebarMention(
  tabs: () => readonly StripTab[],
  scroller: () => HTMLElement | null | undefined,
  rowFor: (mention: SidebarMention) => HTMLElement | null | undefined
): ComputedRef<SidebarMention | null> {
  const mention = computed<SidebarMention | null>(() => {
    const sessionId = mentionPreview.value;
    if (!sessionId) return null;
    for (const tab of tabs()) {
      if (tab.kind !== 'agent') continue;
      const sessions = new Map(tab.family.options.map((option) => [option.session.id, option.session]));
      const session = sessions.get(sessionId);
      if (!session) continue;
      const ancestors = new Set<string>();
      for (let parent = session.parentId ? sessions.get(session.parentId) : undefined; parent && !ancestors.has(parent.id); parent = parent.parentId ? sessions.get(parent.parentId) : undefined) {
        ancestors.add(parent.id);
      }
      return { sessionId, tabKey: tab.key, ancestors };
    }
    return null;
  });

  let scrollBefore: number | null = null;
  watch(mention, async (current) => {
    const list = scroller();
    if (!current) {
      if (list && scrollBefore !== null) list.scrollTop = scrollBefore;
      scrollBefore = null;
      return;
    }
    scrollBefore ??= list?.scrollTop ?? null;
    // Wait for the list to settle: a folded family opening around the row
    // grows from no height, and one revealed for an earlier highlight may be
    // shrinking above it. Activity spinners run forever, so skip them.
    await nextTick();
    const moving = (list?.getAnimations({ subtree: true }) ?? [])
      .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
      .map((animation) => animation.finished);
    await Promise.allSettled(moving);
    // `finished` resolves before the finish event that removes a shrunk branch.
    await new Promise(requestAnimationFrame);
    if (mention.value !== current) return;
    rowFor(current)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });

  return mention;
}
