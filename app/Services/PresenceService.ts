import { z } from 'zod';

export const presenceInput = z.object({
  visible: z.boolean(),
  focused: z.boolean(),
  route: z.string().max(500).default('')
});
export type PresenceState = z.infer<typeof presenceInput>;

// Clients report again at least this often while visible and focused.
const STALE_MS = 90_000;

interface ClientPresence extends PresenceState {
  seenAt: number;
}

// Advisory record of which clients the user is looking at. The user counts as
// present while any client is visible and focused; missing or stale reports
// count as away so notifications are sent rather than lost.
export class PresenceService {
  private readonly clients = new Map<string, ClientPresence>();

  constructor(private readonly now: () => number = Date.now) {}

  update(clientId: string, raw: unknown): void {
    this.clients.set(clientId, { ...presenceInput.parse(raw), seenAt: this.now() });
  }

  remove(clientId: string): void {
    this.clients.delete(clientId);
  }

  present(): boolean {
    return this.active().length > 0;
  }

  // True when an active client is already showing this route.
  viewing(route: string): boolean {
    return this.active().some((client) => client.route === route || client.route.startsWith(`${route}/`));
  }

  private active(): ClientPresence[] {
    const cutoff = this.now() - STALE_MS;
    const active: ClientPresence[] = [];
    for (const [id, client] of this.clients) {
      if (client.seenAt < cutoff) this.clients.delete(id);
      else if (client.visible && client.focused) active.push(client);
    }
    return active;
  }
}
