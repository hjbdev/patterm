import { nextTick } from 'vue';
import { animateRowMoves, sidebarBlocks } from '../lib/sidebarMotion';

// Keyboard movement through a sidebar's rows, like a file tree:
// Up/Down/Home/End move, Right expands or steps in, Left collapses or steps
// out to the parent, and Alt+Up/Down moves a top-level row. Rows are buttons
// marked `data-sidebar-row`, with `data-row-key`, `data-parent` (the parent
// row's key), and, on rows that fold, `data-node` (the agent's session ID),
// `data-expandable`, and `data-expanded`.
export function useSidebarKeys(options: {
  toggle: (sessionId: string, open: boolean) => void;
  move?: (key: string, beforeKey: string | null, afterKey: string | null) => void;
}) {
  function onKeydown(event: KeyboardEvent): void {
    const container = event.currentTarget as HTMLElement;
    const current = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-sidebar-row]');
    if (!current || !container.contains(current) || event.isComposing) return;
    const rows = [...container.querySelectorAll<HTMLElement>('[data-sidebar-row]')].filter((row) => row.getClientRects().length > 0);
    const index = rows.indexOf(current);
    let target: HTMLElement | undefined;
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      moveRow(rows, current, event.key === 'ArrowUp' ? -1 : 1);
      event.preventDefault();
      return;
    }
    switch (event.key) {
      case 'ArrowDown': target = rows[index + 1]; break;
      case 'ArrowUp': target = rows[index - 1]; break;
      case 'Home': target = rows[0]; break;
      case 'End': target = rows[rows.length - 1]; break;
      case 'ArrowRight':
        if (current.dataset.expandable && current.dataset.expanded !== 'true') options.toggle(current.dataset.node!, true);
        else if (current.dataset.expanded === 'true') target = rows[index + 1];
        else return;
        break;
      case 'ArrowLeft':
        if (current.dataset.expanded === 'true') options.toggle(current.dataset.node!, false);
        else if (current.dataset.parent) target = rows.find((row) => row.dataset.rowKey === current.dataset.parent);
        else return;
        break;
      default: return;
    }
    event.preventDefault();
    target?.focus();
  }

  // Swaps a top-level row with its neighbour in the same group (named by the
  // nearest `data-sidebar-group`) and keeps it focused.
  function moveRow(rows: HTMLElement[], current: HTMLElement, direction: -1 | 1): void {
    const key = current.dataset.rowKey;
    if (!options.move || !key || current.dataset.parent) return;
    const groupOf = (row: HTMLElement) => row.closest<HTMLElement>('[data-sidebar-group]')?.dataset.sidebarGroup;
    const group = groupOf(current);
    const topLevel = rows.filter((row) => !row.dataset.parent && groupOf(row) === group && row.dataset.rowKey?.match(/^(agent|process):/));
    const neighbour = topLevel[topLevel.indexOf(current) + direction]?.dataset.rowKey;
    if (!neighbour) return;
    const move = options.move;
    void animateRowMoves(sidebarBlocks(), () => {
      if (direction < 0) move(key, neighbour, null);
      else move(key, null, neighbour);
    });
    void nextTick(() => document.querySelector<HTMLElement>(`[data-sidebar-row][data-row-key="${CSS.escape(key)}"]`)?.focus());
  }

  return { onKeydown };
}
