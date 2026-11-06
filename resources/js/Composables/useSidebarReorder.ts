import { onBeforeUnmount, ref } from 'vue';
import { animateRowMoves } from '../lib/sidebarMotion';

// Vertical drag-to-reorder for sidebar rows. The dragged row follows the
// pointer, a line marks the drop point, and the move is committed on release
// as "between beforeKey and afterKey" so filtered lists can reorder too.
//
// Rows belong to groups. A row moves within its own group, and a tab can also
// move into a folder: dropped on the folder's row, or among the rows of its
// group, `folder:<id>`. A tab in a folder can move out to the list's rows.
// Rows in a group that isn't `sortable` keep an order of their own, so a drop
// there only changes which group the row is in.
export interface ReorderRow { key: string; group: string; folder?: boolean; sortable: boolean }
// `line` is where the drop line was drawn, beside which row.
export interface ReorderDrop { group: string; beforeKey: string | null; afterKey: string | null; into: string | null; line: { key: string; edge: 'before' | 'after' } | null }

type Target = { row: ReorderRow; edge: 'before' | 'after' | 'into' };

const isFolderGroup = (group: string) => group.startsWith('folder:');

function useVerticalReorder(options: {
  rows: () => readonly ReorderRow[];
  element: (key: string) => HTMLElement | undefined;
  onDrop: (key: string, drop: ReorderDrop) => void;
}) {
  const draggingKey = ref<string | null>(null);
  const dropLine = ref<{ key: string; edge: 'before' | 'after' } | null>(null);
  const dropInto = ref<string | null>(null);
  let press: { key: string; pointerId: number; startY: number; dragging: boolean } | null = null;
  let target: Target | null = null;
  let suppressClick: string | null = null;

  function onPointerDown(event: PointerEvent, key: string): void {
    if (event.button !== 0 || !event.isPrimary || event.pointerType === 'touch') return;
    press = { key, pointerId: event.pointerId, startY: event.clientY, dragging: false };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', cancel);
  }

  // Where each other row can take the dragged one: beside it, on it (a
  // folder's row, or a row in a folder kept in its own order), or nowhere.
  function placement(dragged: ReorderRow, row: ReorderRow): 'line' | 'into' | 'edges-or-into' | null {
    if (row.key === dragged.key) return null;
    if (dragged.folder) return row.group === dragged.group && row.sortable ? 'line' : null;
    if (row.folder) return row.group === dragged.group && row.sortable ? 'edges-or-into' : 'into';
    if (row.group === dragged.group) return row.sortable ? 'line' : null;
    if (isFolderGroup(row.group)) return row.sortable ? 'line' : 'into';
    return isFolderGroup(dragged.group) ? 'line' : null;
  }

  function candidates(key: string): Array<{ row: ReorderRow; mode: 'line' | 'into' | 'edges-or-into'; rect: DOMRect }> {
    const rows = options.rows();
    const dragged = rows.find((row) => row.key === key);
    if (!dragged) return [];
    return rows.flatMap((row) => {
      const mode = placement(dragged, row);
      const rect = mode && options.element(row.key)?.getBoundingClientRect();
      return mode && rect ? [{ row, mode, rect }] : [];
    }).sort((a, b) => a.rect.top - b.rect.top);
  }

  function targetAt(key: string, y: number): Target | null {
    const rows = candidates(key);
    const hit = rows.find(({ rect }) => y >= rect.top && y < rect.bottom);
    if (hit) {
      const offset = (y - hit.rect.top) / hit.rect.height;
      if (hit.mode === 'into' || (hit.mode === 'edges-or-into' && offset > 0.25 && offset < 0.75)) return { row: hit.row, edge: 'into' };
      return { row: hit.row, edge: offset < 0.5 ? 'before' : 'after' };
    }
    const next = rows.find(({ rect }) => y < rect.top + rect.height / 2);
    const nearest = next ?? rows[rows.length - 1];
    if (!nearest) return null;
    return { row: nearest.row, edge: nearest.mode === 'into' ? 'into' : next ? 'before' : 'after' };
  }

  function onMove(event: PointerEvent): void {
    if (!press || event.pointerId !== press.pointerId) return;
    if (!press.dragging) {
      if (Math.abs(event.clientY - press.startY) < 5 || !candidates(press.key).length) return;
      press.dragging = true;
      draggingKey.value = press.key;
    }
    const dragged = options.element(press.key);
    if (dragged) dragged.style.transform = `translateY(${event.clientY - press.startY}px)`;
    target = targetAt(press.key, event.clientY);
    dropLine.value = target && target.edge !== 'into' ? { key: target.row.key, edge: target.edge } : null;
    dropInto.value = target?.edge === 'into' ? target.row.key : null;
    event.preventDefault();
  }

  function onUp(): void {
    const current = press;
    const landed = target;
    if (!current?.dragging) {
      end();
      return;
    }
    suppressClick = current.key;
    const elements = options.rows().map((row) => options.element(row.key)).filter((element): element is HTMLElement => Boolean(element));
    // Measured while the dragged row still sits where it was let go.
    void animateRowMoves(elements, () => {
      end();
      if (!landed) return;
      const { row, edge } = landed;
      if (edge === 'into') {
        options.onDrop(current.key, { group: row.folder ? row.key : row.group, beforeKey: null, afterKey: null, into: row.folder ? row.key : row.group, line: null });
        return;
      }
      const rows = options.rows().filter((candidate) => candidate.group === row.group && candidate.key !== current.key);
      const index = rows.findIndex((candidate) => candidate.key === row.key);
      const beforeKey = edge === 'before' ? row.key : rows[index + 1]?.key ?? null;
      const afterKey = edge === 'after' ? row.key : rows[index - 1]?.key ?? null;
      options.onDrop(current.key, { group: row.group, beforeKey, afterKey, into: null, line: { key: row.key, edge } });
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
    target = null;
    draggingKey.value = null;
    dropLine.value = null;
    dropInto.value = null;
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
  return { draggingKey, dropLine, dropInto, onPointerDown, consumeClick };
}

// Element bookkeeping plus reordering for a sidebar list.
export function useSidebarReorder(rows: () => readonly ReorderRow[], onDrop: (key: string, drop: ReorderDrop) => void) {
  const elements = new Map<string, HTMLElement>();
  function setElement(key: string, element: unknown): void {
    if (element instanceof HTMLElement) elements.set(key, element);
    else elements.delete(key);
  }
  const element = (key: string) => elements.get(key);
  return { setElement, element, ...useVerticalReorder({ rows, element, onDrop }) };
}
