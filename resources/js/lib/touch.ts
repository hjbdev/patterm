// Phones and tablets: no hover, and focusing a field opens the on-screen
// keyboard, so focus follows taps rather than navigation.
export function touchScreen(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches;
}
