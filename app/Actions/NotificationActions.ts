import { z } from 'zod';
import { notificationUrgency, type NotificationSettings } from '../Services/NotificationSettings';
import { BODY_LIMIT, TITLE_LIMIT, type NotificationService } from '../Services/NotificationService';
import type { PresenceService } from '../Services/PresenceService';
import type { PushService } from '../Services/PushService';
import type { SettingsService } from '../Services/SettingsService';

const id = z.string().min(1).max(200);

export const notifyUserInput = z.object({
  title: z.string().trim().min(1).max(TITLE_LIMIT),
  message: z.string().max(BODY_LIMIT).default(''),
  urgency: notificationUrgency.default('normal')
}).strict();

export const notificationListInput = z.object({
  project_id: id.optional(),
  process_id: id.optional(),
  include_resolved: z.boolean().default(false),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().nonnegative().default(0),
  cursor: z.string().min(3).max(200).optional()
}).strict();

export const notificationReadInput = z.object({
  ids: z.array(id).max(200).optional(),
  process_id: id.optional(),
  session_id: id.optional(),
  all: z.boolean().optional()
}).strict();

export const notificationResolveInput = z.object({
  ids: z.array(id).max(200).optional(),
  process_id: id.optional()
}).strict();

export class NotificationActions {
  private readonly inputListeners = new Set<(processId: string) => void>();

  constructor(
    private readonly notifications: NotificationService,
    private readonly settings: Pick<SettingsService, 'notificationSettings' | 'updateNotificationSettings'>,
    private readonly presence: PresenceService,
    private readonly push: PushService
  ) {}

  // Agents notify only as themselves. Children are routed to their parent.
  notifyUser(processId: string, raw: unknown) {
    const input = notifyUserInput.parse(raw);
    return this.notifications.raise({ processId, source: 'mcp', kind: 'attention', urgency: input.urgency, title: input.title, body: input.message, dedupeKey: null });
  }

  list(raw: unknown) {
    return this.notifications.list(notificationListInput.parse(raw ?? {}));
  }

  state() {
    return { unread: this.notifications.unread() };
  }

  read(raw: unknown) {
    return { updated: this.notifications.markRead(notificationReadInput.parse(raw)) };
  }

  resolve(raw: unknown) {
    return { updated: this.notifications.resolve(notificationResolveInput.parse(raw)) };
  }

  // A message from this process could not be delivered to another host's
  // agent. The user decides what to do next.
  deliveryFailed(processId: string, title: string, body: string) {
    return this.notifications.raise({ processId, source: 'system', kind: 'failure', urgency: 'normal', title: title.slice(0, TITLE_LIMIT), body: body.slice(0, BODY_LIMIT), dedupeKey: null });
  }

  // A paired host refused this one, which needs the user to pair again or
  // update a host.
  hostRefused(hostName: string, reason: string) {
    return this.notifications.raise({ processId: null, source: 'system', kind: 'failure', urgency: 'normal', title: `Cannot connect to ${hostName}`.slice(0, TITLE_LIMIT), body: reason.slice(0, BODY_LIMIT), dedupeKey: `host-refused:${hostName}` });
  }

  // Input from the user answers any open request on that process.
  userInput(processId: string): void {
    this.notifications.resolveHandled(processId);
    for (const listener of this.inputListeners) listener(processId);
  }

  onUserInput(listener: (processId: string) => void): void {
    this.inputListeners.add(listener);
  }

  // A report ends the reporter's turn-ended notice.
  reported(processId: string): void {
    this.notifications.reported(processId);
  }

  readSettings(): NotificationSettings {
    return this.settings.notificationSettings();
  }

  updateSettings(raw: unknown): NotificationSettings {
    return this.settings.updateNotificationSettings(raw);
  }

  test() {
    return this.notifications.raise({ source: 'system', kind: 'message', urgency: 'high', title: 'Test notification', body: 'Notifications from Patterm will look like this.' });
  }

  updatePresence(clientId: string, raw: unknown): void {
    this.presence.update(clientId, raw);
  }

  removePresence(clientId: string): void {
    this.presence.remove(clientId);
  }

  pushKey() {
    return { publicKey: this.push.publicKey() };
  }

  pushSubscribe(raw: unknown) {
    return this.push.subscribe(raw);
  }

  pushUnsubscribe(raw: unknown) {
    return this.push.unsubscribe(raw);
  }

  pushSubscriptions() {
    return this.push.list();
  }
}
