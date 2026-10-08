export type TerminalFrameMode = 'foreground' | 'background-visible' | 'hidden';

export interface TerminalFrameVisibilityState {
  visibilityState: DocumentVisibilityState | string;
  hasFocus: boolean;
}

export const BACKGROUND_VISIBLE_TERMINAL_FRAME_INTERVAL_MS = 100;

export function terminalFrameMode(state: TerminalFrameVisibilityState): TerminalFrameMode {
  if (state.visibilityState !== 'visible') {
    return 'hidden';
  }

  return state.hasFocus ? 'foreground' : 'background-visible';
}

export function shouldSubscribeTerminalFrames(mode: TerminalFrameMode): boolean {
  return mode !== 'hidden';
}

export function terminalFrameIntervalForMode(mode: TerminalFrameMode, estimatedFrameIntervalMs: number): number | null {
  if (mode === 'hidden') {
    return null;
  }

  if (mode === 'background-visible') {
    return BACKGROUND_VISIBLE_TERMINAL_FRAME_INTERVAL_MS;
  }

  return clampForegroundFrameInterval(estimatedFrameIntervalMs);
}

export function clampForegroundFrameInterval(value: number): number {
  return Math.max(2, Math.min(33, value));
}
