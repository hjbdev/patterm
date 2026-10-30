// Requests for a secret already brought to the user's attention, kept for the
// app's lifetime so dismissing one sticks across agents and pages.
const shown = new Set<string>();

// The requests among `secrets` not shown yet, which are now marked shown.
export function takeFreshRequests(secrets: readonly { id: string; status: string }[], seen: Set<string> = shown): string[] {
  const fresh = secrets.filter((secret) => secret.status === 'requested' && !seen.has(secret.id)).map((secret) => secret.id);
  for (const id of fresh) seen.add(id);
  return fresh;
}
