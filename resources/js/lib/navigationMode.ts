// Ctrl+Space toggles a modal tab-navigation mode, so W/A/S/D and 1-9 can be
// repeated without a chord each time and without taking Ctrl+letter keys from
// terminals or the Integrated composer.

export type NavigationModeAction =
  | { type: 'none' }
  | { type: 'enter' }
  | { type: 'exit'; consume: boolean }
  | { type: 'tab'; delta: -1 | 1 }
  | { type: 'option'; delta: -1 | 1 }
  | { type: 'jump'; index: number };

export interface NavigationModeKey {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);

export function isNavigationModeToggle(event: NavigationModeKey): boolean {
  return event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && event.code === 'Space';
}

export function navigationModeAction(event: NavigationModeKey, active: boolean): NavigationModeAction {
  if (isNavigationModeToggle(event)) return active ? { type: 'exit', consume: true } : { type: 'enter' };
  if (!active || MODIFIER_KEYS.has(event.key)) return { type: 'none' };
  if (event.key === 'Escape' || event.key === 'Enter') return { type: 'exit', consume: true };
  if (event.ctrlKey || event.altKey || event.metaKey) return { type: 'exit', consume: false };

  // Physical key codes keep WASD in place on non-QWERTY layouts.
  switch (event.code) {
    case 'KeyA': return { type: 'tab', delta: -1 };
    case 'KeyD': return { type: 'tab', delta: 1 };
    case 'KeyW': return { type: 'option', delta: -1 };
    case 'KeyS': return { type: 'option', delta: 1 };
  }
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);
  if (digit) return { type: 'jump', index: Number(digit[1]) - 1 };
  // Any other key leaves the mode and reaches the focused terminal or input.
  return { type: 'exit', consume: false };
}
