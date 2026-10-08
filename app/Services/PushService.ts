import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { z } from 'zod';
import type { DatabaseService } from './DatabaseService';
import type { NotificationRecord } from './NotificationService';

export const pushSubscriptionInput = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(256)
  }),
  label: z.string().trim().max(120).default('')
});

export const pushEndpointInput = z.object({ endpoint: z.string().max(2048) });

export interface PushSubscriptionSummary {
  id: string;
  endpoint: string;
  label: string;
  created_at: string;
  last_success_at: string | null;
  failure_count: number;
}

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

interface SubscriptionRow extends PushSubscriptionSummary {
  p256dh: string;
  auth: string;
}

type Sender = (subscription: webpush.PushSubscription, payload: string, options: webpush.RequestOptions) => Promise<unknown>;

// Browsers only hand out endpoints on their vendor's push service. Accepting
// nothing else keeps the server from being pointed at arbitrary hosts.
const PUSH_HOSTS = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'web.push.apple.com',
  'push.apple.com',
  'notify.windows.com'
];
const FAILURE_LIMIT = 5;
const SEND_TIMEOUT_MS = 10_000;
const TTL_SECONDS = { low: 60 * 60, normal: 4 * 60 * 60, high: 24 * 60 * 60 } as const;

export class PushService {
  private keys: VapidKeys | null = null;

  constructor(
    private readonly database: DatabaseService,
    private readonly appDataPath: string,
    private readonly subject: string,
    private readonly send: Sender = (subscription, payload, options) => webpush.sendNotification(subscription, payload, options)
  ) {}

  publicKey(): string {
    return this.vapid().publicKey;
  }

  subscribe(raw: unknown): PushSubscriptionSummary {
    const input = pushSubscriptionInput.parse(raw);
    assertPushEndpoint(input.endpoint);
    const now = new Date().toISOString();
    this.database.connection.prepare(`insert into push_subscriptions (id, endpoint, p256dh, auth, label, created_at)
      values (?, ?, ?, ?, ?, ?)
      on conflict(endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label, failure_count = 0`)
      .run(`push_${randomUUID()}`, input.endpoint, input.keys.p256dh, input.keys.auth, input.label, now);
    return this.list().find((row) => row.endpoint === input.endpoint)!;
  }

  unsubscribe(raw: unknown): { removed: boolean } {
    const { endpoint } = pushEndpointInput.parse(raw);
    return { removed: this.database.connection.prepare('delete from push_subscriptions where endpoint = ? or id = ?').run(endpoint, endpoint).changes > 0 };
  }

  list(): PushSubscriptionSummary[] {
    return this.database.connection.prepare(`select id, endpoint, label, created_at, last_success_at, failure_count
      from push_subscriptions order by created_at`).all() as unknown as PushSubscriptionSummary[];
  }

  async deliver(notification: NotificationRecord): Promise<void> {
    const rows = this.database.connection.prepare('select * from push_subscriptions').all() as unknown as SubscriptionRow[];
    if (!rows.length) return;
    const keys = this.vapid();
    const payload = JSON.stringify({
      id: notification.id,
      title: notification.title,
      body: notification.body,
      url: notification.url,
      tag: notification.process_id ?? notification.id,
      urgency: notification.urgency
    });
    const options: webpush.RequestOptions = {
      vapidDetails: { subject: this.subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
      TTL: TTL_SECONDS[notification.urgency],
      urgency: notification.urgency,
      // A newer notification for the same process replaces an undelivered one.
      topic: topic(notification.process_id ?? notification.id),
      timeout: SEND_TIMEOUT_MS
    };
    await Promise.all(rows.map(async (row) => {
      try {
        await this.send({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, payload, options);
        this.database.connection.prepare('update push_subscriptions set last_success_at = ?, failure_count = 0 where id = ?').run(new Date().toISOString(), row.id);
      } catch (error) {
        const status = (error as { statusCode?: unknown }).statusCode;
        if (status === 404 || status === 410 || row.failure_count + 1 >= FAILURE_LIMIT) {
          this.database.connection.prepare('delete from push_subscriptions where id = ?').run(row.id);
        } else {
          this.database.connection.prepare('update push_subscriptions set failure_count = failure_count + 1 where id = ?').run(row.id);
        }
      }
    }));
  }

  // Generated on first use and kept out of app.db so database backups and
  // archives never carry the private key.
  private vapid(): VapidKeys {
    if (this.keys) return this.keys;
    const file = path.join(this.appDataPath, 'push-vapid.json');
    try {
      const saved = z.object({ publicKey: z.string().min(1), privateKey: z.string().min(1) }).parse(JSON.parse(fs.readFileSync(file, 'utf8')));
      this.keys = saved;
      return saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Push keys at ${file} are unreadable; remove the file to generate new keys`);
    }
    const generated = webpush.generateVAPIDKeys();
    fs.writeFileSync(file, JSON.stringify(generated), { mode: 0o600, flag: 'wx' });
    this.keys = generated;
    return generated;
  }
}

export function assertPushEndpoint(endpoint: string): void {
  const url = new URL(endpoint);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
    || !PUSH_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
    throw new Error('Unsupported push service');
  }
}

export function pushSubject(publicOrigin: string | undefined): string {
  return publicOrigin?.startsWith('https://') ? publicOrigin : 'mailto:patterm@localhost';
}

function topic(key: string): string {
  return createHash('sha256').update(key).digest('base64url').slice(0, 32);
}
