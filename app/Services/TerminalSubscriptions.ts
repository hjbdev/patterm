import type { TerminalService } from './TerminalService';

// Who wants damage frames for each PTY: the desktop window, the browsers, and
// paired hosts. The sidecar streams a PTY while anyone wants it, so one
// subscriber leaving never stops another's frames.
export class TerminalSubscriptions {
  private readonly subscribers = new Map<string, Set<string>>();

  constructor(private readonly terminal: Pick<TerminalService, 'request'>) {}

  async set(subscriber: string, ptyProcessId: string, subscribed: boolean): Promise<unknown> {
    let current = this.subscribers.get(ptyProcessId);
    if (subscribed) {
      if (!current) this.subscribers.set(ptyProcessId, current = new Set());
      current.add(subscriber);
    } else {
      current?.delete(subscriber);
      if (current?.size === 0) this.subscribers.delete(ptyProcessId);
    }
    try {
      return await this.terminal.request('terminal.process.subscribe', { process_id: ptyProcessId, subscribed: this.subscribers.has(ptyProcessId) });
    } catch (error) {
      if (subscribed) {
        current?.delete(subscriber);
        if (current?.size === 0) this.subscribers.delete(ptyProcessId);
      }
      throw error;
    }
  }

  // Drops every subscription of one subscriber, such as a host whose link
  // closed.
  async release(subscriber: string): Promise<void> {
    for (const [ptyProcessId, current] of [...this.subscribers]) {
      if (current.has(subscriber)) await this.set(subscriber, ptyProcessId, false).catch(() => undefined);
    }
  }

  subscribersOf(ptyProcessId: string): ReadonlySet<string> {
    return this.subscribers.get(ptyProcessId) ?? new Set();
  }
}
