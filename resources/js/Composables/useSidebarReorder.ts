import { onBeforeUnmount, ref } from 'vue';
import { animateRowMoves } from '../lib/sidebarMotion';

// Vertical drag-to-reorder for sidebar rows. The dragged row follows the
// pointer, a line marks the drop point, and the move is committed on release
// as "between beforeKey and afterKey" so filtered lists can reorder too.
export interface ReorderRow { key: string; group: string }

function useVerticalReorder(options: {
  rows: () => readonly ReorderRow[];
  element: (key: string) => HTMLElement | undefined;
  onDrop: (key: string, beforeKey: string | null, afterKey: string | null) => void;
}) {
  const draggingKey = ref<string | null>(null);
  const dropLine = ref<{ key: string; edge: 'before' | 'after' } | null>(null);
  let press: { key: string; pointerId: number; startY: number; dragging: boolean } | null = null;
  let suppressClick: string | null = null;

  function onPointerDown(event: PointerEvent, key: string): void {
    if (event.button !== 0 || !event.isPrimary || event.pointerType === 'touch') return;
    press = { key, pointerId: event.pointerId, startY: event.clientY, dragging: false };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', cancel);
  }

  function groupRows(key: string): ReorderRow[] {
    const rows = options.rows();
    const group = rows.find((row) => row.key === key)?.group;
    return rows.filter((row) => row.group === group);
  }

  function onMove(event: PointerEvent): void {
    if (!press || event.pointerId !== press.pointerId) return;
    if (!press.dragging) {
      if (Math.abs(event.clientY - press.startY) < 5 || groupRows(press.key).length < 2) return;
      press.dragging = true;
      draggingKey.value = press.key;
    }
    const dragged = options.element(press.key);
    if (dragged) dragged.style.transform = `translateY(${event.clientY - press.startY}px)`;
    let line: typeof dropLine.value = null;
    for (const row of groupRows(press.key)) {
      if (row.key === press.key) continue;
      const rect = options.element(row.key)?.getBoundingClientRect();
      if (!rect) continue;
      if (event.clientY < rect.top + rect.height / 2) { line = { key: row.key, edge: 'before' }; break; }
      line = { key: row.key, edge: 'after' };
    }
    dropLine.value = line;
    event.preventDefault();
  }

  function onUp(): void {
    const current = press;
    const line = dropLine.value;
    if (!current?.dragging) {
      end();
      return;
    }
    suppressClick = current.key;
    const elements = options.rows().map((row) => options.element(row.key)).filter((element): element is HTMLElement => Boolean(element));
    // Measured while the dragged row still sits where it was let go.
    void animateRowMoves(elements, () => {
      end();
      if (!line) return;
      const rows = groupRows(current.key).filter((row) => row.key !== current.key);
      const index = rows.findIndex((row) => row.key === line.key);
      const before = line.edge === 'before' ? line.key : rows[index + 1]?.key ?? null;
      const after = line.edge === 'after' ? line.key : rows[index - 1]?.key ?? null;
      options.onDrop(current.key, before, after);
    });
  }

  function cancel(): void {
    end();
  }

  function end(): void {
    if (press) {
      const element = options.element(press.key);
      if (element) element.style.transform = '';
    }
    press = null;
    draggingKey.value = null;
    dropLine.value = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', cancel);
  }

  // Swallows the click that ends a drag so the row is not also selected.
  function consumeClick(event: MouseEvent, key: string): void {
    if (suppressClick !== key) return;
    suppressClick = null;
    event.preventDefault();
    event.stopPropagation();
  }

  onBeforeUnmount(end);
  return { draggingKey, dropLine, onPointerDown, consumeClick };
}

// Element bookkeeping plus reordering for a sidebar list.
export function useSidebarReorder(rows: () => readonly ReorderRow[], onDrop: (key: string, beforeKey: string | null, afterKey: string | null) => void) {
  const elements = new Map<string, HTMLElement>();
  function setElement(key: string, element: unknown): void {
    if (element instanceof HTMLElement) elements.set(key, element);
    else elements.delete(key);
  }
  const element = (key: string) => elements.get(key);
  return { setElement, element, ...useVerticalReorder({ rows, element, onDrop }) };
}
