export const TERMINAL_FONT_SIZE_STORAGE_KEY = 'patterm.terminal.fontSizePx';
export const DEFAULT_TERMINAL_FONT_SIZE_PX = 14;
export const MIN_TERMINAL_FONT_SIZE_PX = 10;
export const MAX_TERMINAL_FONT_SIZE_PX = 24;
export const TERMINAL_FONT_SIZE_STEP_PX = 1;

export type TerminalFontSizeDirection = 'increase' | 'decrease';

export interface TerminalFontSizeShortcutEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function clampTerminalFontSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TERMINAL_FONT_SIZE_PX;
  return Math.max(MIN_TERMINAL_FONT_SIZE_PX, Math.min(MAX_TERMINAL_FONT_SIZE_PX, Math.round(value)));
}

export function nextTerminalFontSize(current: number, direction: TerminalFontSizeDirection): number {
  const delta = direction === 'increase' ? TERMINAL_FONT_SIZE_STEP_PX : -TERMINAL_FONT_SIZE_STEP_PX;
  return clampTerminalFontSize(current + delta);
}

export function terminalFontSizeShortcutDirection(event: TerminalFontSizeShortcutEventLike): TerminalFontSizeDirection | null {
  if (!event.ctrlKey || event.metaKey || event.altKey) {
    return null;
  }

  if (event.key === '+' || event.key === '=' || event.code === 'NumpadAdd') {
    return 'increase';
  }

  if (event.key === '-' || event.code === 'NumpadSubtract') {
    return 'decrease';
  }

  return null;
}

export function readStoredTerminalFontSize(storage: Pick<Storage, 'getItem'> = localStorage): number {
  const raw = storage.getItem(TERMINAL_FONT_SIZE_STORAGE_KEY);
  if (raw === null || raw.trim() === '') return DEFAULT_TERMINAL_FONT_SIZE_PX;
  return clampTerminalFontSize(Number(raw));
}

export function writeStoredTerminalFontSize(fontSizePx: number, storage: Pick<Storage, 'setItem'> = localStorage): void {
  storage.setItem(TERMINAL_FONT_SIZE_STORAGE_KEY, String(clampTerminalFontSize(fontSizePx)));
}
