<template>
  <div class="min-w-0 overflow-x-auto">
    <table class="w-full border-collapse text-xs">
      <thead v-if="table.header !== false">
        <tr>
          <th v-for="column in table.columns" :key="column.key" class="border-b border-border pb-2 pr-3 text-left font-medium text-muted-foreground" :class="align(column.kind)">{{ column.label ?? '' }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, index) in table.rows" :key="index" class="group" :class="highlighted(row) ? 'bg-[var(--drawn-accent-wash)]' : ''">
          <td
            v-for="(column, columnIndex) in table.columns"
            :key="column.key"
            class="pr-3 align-top"
            :class="[align(column.kind), table.header === false ? 'py-1' : 'border-b border-border py-2 group-last:border-0', column.kind === 'mono' ? 'font-mono text-[11px]' : '', columnIndex === 0 && highlighted(row) ? 'pl-2 shadow-[inset_2px_0_0_var(--drawn-accent)]' : '']"
          >
            <template v-for="value in [cellOf(row[column.key], row)]" :key="0">
              <span v-if="value.state === 'unknown' || value.value === 'unknown'" class="drawn-hatch inline-block rounded px-1.5 text-muted-foreground">unknown</span>
              <span v-else-if="(column.kind === 'status' || column.kind === 'verdict') && glyph(value.value)" class="font-semibold" :style="{ color: glyph(value.value)!.color }" :title="String(value.value)">{{ glyph(value.value)!.text }}<span class="sr-only"> {{ value.value }}</span></span>
              <span v-else :class="value.state === 'projected' ? 'italic' : ''" :style="value.tone ? { color: toneColor(value.tone) } : undefined">{{ value.state === 'projected' ? '~' : '' }}{{ display(value.value) }}</span>
            </template>
            <span v-if="columnIndex === table.columns.length - 1 && typeof row.note === 'string'" class="block font-sans text-[11px] text-muted-foreground/70">{{ row.note }}</span>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-if="table.columns.some((column) => column.kind === 'status')" class="mt-2 flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-muted-foreground">
      <span :style="{ color: toneColor('good') }">✓ yes</span><span :style="{ color: toneColor('warn') }">! partly</span><span :style="{ color: toneColor('bad') }">✕ no</span><span class="drawn-hatch rounded px-1.5">unknown</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { formatDrawnNumber, type DrawnScalar, type DrawnState, type DrawnTable, type DrawnTone } from '../../../../app/Services/DrawnUi';
import { toneColor } from '../../lib/drawnUi';

const props = defineProps<{ table: DrawnTable }>();
type Cell = { value?: DrawnScalar | undefined; state?: DrawnState | undefined; tone?: DrawnTone | undefined };
const GLYPHS: Record<string, { text: string; tone: DrawnTone }> = {
  yes: { text: '✓', tone: 'good' }, partial: { text: '!', tone: 'warn' }, no: { text: '✕', tone: 'bad' },
  better: { text: '✓', tone: 'good' }, worse: { text: '✗', tone: 'bad' }, same: { text: '–', tone: 'muted' }
};

// A row's own state or tone applies to cells that set none.
function cellOf(raw: unknown, row?: Record<string, unknown>): Cell {
  const cell = raw && typeof raw === 'object' ? raw as Cell : { value: raw as DrawnScalar };
  const state = cell.state ?? (typeof row?.state === 'string' ? row.state as DrawnState : undefined);
  const tone = cell.tone ?? (typeof row?.tone === 'string' ? row.tone as DrawnTone : undefined);
  return { ...cell, ...(state ? { state } : {}), ...(tone ? { tone } : {}) };
}
function glyph(value: unknown): { text: string; color: string } | null {
  const entry = typeof value === 'string' ? GLYPHS[value] : undefined;
  return entry ? { text: entry.text, color: toneColor(entry.tone) } : null;
}
function display(value: unknown): string {
  return typeof value === 'number' ? formatDrawnNumber(value) : value === null || value === undefined ? '' : String(value);
}
function align(kind: string | undefined): string {
  return kind === 'status' || kind === 'verdict' ? 'text-center' : kind === 'number' ? 'text-right tabular-nums' : '';
}
function highlighted(row: Record<string, unknown>): boolean {
  const [key, value] = props.table.highlight ? Object.entries(props.table.highlight)[0]! : [];
  return key !== undefined && cellOf(row[key]).value === value;
}
</script>
