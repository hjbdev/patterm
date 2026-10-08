import type { NotificationChange, NotificationRecord } from './NotificationService';
import type { PresenceService } from './PresenceService';

// Normal urgency waits briefly so a request answered straight away is never
// pushed to a phone.
const DELAY_MS = { low: 5_000, normal: 5_000, high: 0 } as const;

export interface NotificationDeliveryTargets {
  current(id: string): NotificationRecord | null;
  push(notification: NotificationRecord): Promise<void>;
  desktop(notification: NotificationRecord): void;
  log(event: string, data: unknown): void;
}

// Sends desktop and push notifications while the user is away. The Sonner
// toast in each client is driven by the same change events in the renderer.
export class NotificationDelivery {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly presence: Pick<PresenceService, 'present'>,
    private readonly targets: NotificationDeliveryTargets
  ) {}

  handle(change: NotificationChange): void {
    if (change.type !== 'raised' || change.notification.delivery !== 'all') return;
    const { id, urgency } = change.notification;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.deliver(id);
    }, DELAY_MS[urgency]);
    timer.unref?.();
    this.timers.add(timer);
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private deliver(id: string): void {
    const notification = this.targets.current(id);
    if (!notification || notification.resolved_at || notification.read_at) return;
    if (this.presence.present()) return;
    this.targets.desktop(notification);
    void this.targets.push(notification).catch((error: unknown) => {
      this.targets.log('push.failed', { id, message: error instanceof Error ? error.message : String(error) });
    });
  }
}
