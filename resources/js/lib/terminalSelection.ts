export interface TerminalSelectionEntry {
  id: string;
}

export interface TerminalSelectionInput<T extends TerminalSelectionEntry> {
  next: readonly T[];
  previous: readonly T[];
  activeTerminalId: string | null;
  pendingExplicitTerminalId: string | null;
}

export function resolveActiveTerminalSelection<T extends TerminalSelectionEntry>(input: TerminalSelectionInput<T>): string | null {
  if (input.pendingExplicitTerminalId && hasTerminal(input.next, input.pendingExplicitTerminalId)) {
    return input.pendingExplicitTerminalId;
  }

  if (input.activeTerminalId && hasTerminal(input.next, input.activeTerminalId)) {
    return input.activeTerminalId;
  }

  return input.next[0]?.id ?? null;
}

function hasTerminal(entries: readonly TerminalSelectionEntry[], terminalId: string): boolean {
  return entries.some((entry) => entry.id === terminalId);
}
