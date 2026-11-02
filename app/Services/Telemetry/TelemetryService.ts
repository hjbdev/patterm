import { randomUUID } from 'node:crypto';
import { TELEMETRY_HOSTS, telemetryFeedbackInput, telemetryRecordInput, telemetrySettingsUpdate, type TelemetrySettings } from './TelemetrySettings';

type Value = string | number | boolean | null | string[];
type Properties = Record<string, Value>;
interface QueuedEvent { event: string; properties: Properties; timestamp: string }
interface Tally { event: string; properties: Properties; count: number; errors: number; ms: number }

export interface TelemetryInventory {
  tools: string[];
  channels: string[];
  // Settings changed from their defaults, as dotted paths. Never values.
  settings: string[];
  // Row counts for the tables behind each feature.
  records: Record<string, number>;
}

export interface TelemetryOptions {
  settings: { telemetrySettings(): TelemetrySettings; saveTelemetrySettings(settings: TelemetrySettings): TelemetrySettings };
  // Properties sent with every event, such as the version and platform.
  context: Properties;
  inventory: () => TelemetryInventory;
  fetch?: typeof fetch;
  flushIntervalMs?: number;
  inventoryIntervalMs?: number;
  log?: (event: string, data?: unknown) => void;
}

const MAX_QUEUE = 500;
const MAX_TALLIES = 5000;

// Opt-in usage telemetry for finding the features nobody uses. Calls are
// counted in memory and sent to PostHog in batches. Only identifiers from
// Patterm's code are sent: tool, channel, route, and component names. Never
// arguments, results, paths, names, or terminal and conversation text.
export class TelemetryService {
  // IPC channels the routes registered, for the inventory.
  readonly channels = new Set<string>();
  private tallies = new Map<string, Tally>();
  private queue: QueuedEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private inventoryTimer: NodeJS.Timeout | null = null;
  private current: TelemetrySettings;
  private flushing: Promise<void> | null = null;
  // The first inventory waits for the first send, once every route is registered.
  private inventoryPending = false;

  constructor(private readonly options: TelemetryOptions) {
    this.current = options.settings.telemetrySettings();
  }

  get enabled(): boolean {
    return this.current.enabled && Boolean(this.current.apiKey) && Boolean(this.current.installId);
  }

  start(): void {
    this.flushTimer = setInterval(() => { void this.flush(); }, this.options.flushIntervalMs ?? 60_000);
    this.flushTimer.unref?.();
    this.inventoryTimer = setInterval(() => this.captureInventory(), this.options.inventoryIntervalMs ?? 24 * 60 * 60_000);
    this.inventoryTimer.unref?.();
    this.inventoryPending = true;
  }

  // epoch names this opt-in. Clients send it with their counts, so counts
  // made under an earlier opt-in, or while it was off, are refused.
  settings(): { enabled: boolean; apiKey: string; host: 'us' | 'eu'; epoch: string | null } {
    return { enabled: this.current.enabled, apiKey: this.current.apiKey, host: this.current.host, epoch: this.enabled ? this.current.installId : null };
  }

  update(raw: unknown): ReturnType<TelemetryService['settings']> {
    const input = telemetrySettingsUpdate.parse(raw);
    const turningOn = input.enabled && !this.current.enabled;
    const enabled = input.enabled && Boolean(input.apiKey);
    const installId = enabled ? (turningOn || !this.current.installId ? randomUUID() : this.current.installId) : null;
    if (!enabled) this.discard();
    this.current = this.options.settings.saveTelemetrySettings({ ...input, enabled, installId });
    if (enabled && turningOn) {
      this.capture('telemetry_enabled', {});
      this.inventoryPending = true;
    }
    return this.settings();
  }

  // Counts one use. Repeated uses are sent as one event with a count.
  count(event: string, properties: Properties, outcome: { ok?: boolean; ms?: number } = {}): void {
    if (!this.enabled) return;
    const tally = this.tally(event, properties);
    if (!tally) return;
    tally.count += 1;
    if (outcome.ok === false) tally.errors += 1;
    if (outcome.ms !== undefined) tally.ms += outcome.ms;
  }

  capture(event: string, properties: Properties): void {
    if (!this.enabled) return;
    if (this.queue.length >= MAX_QUEUE) this.queue.shift();
    this.queue.push({ event, properties, timestamp: new Date().toISOString() });
  }

  // What a client counted: clicks, page views, and time on each page.
  record(raw: unknown): { accepted: boolean } {
    const input = telemetryRecordInput.parse(raw);
    if (!this.enabled || input.epoch !== this.current.installId) return { accepted: false };
    const client = input.app_version ? { client_version: input.app_version } : {};
    for (const [feature, count] of Object.entries(input.clicks)) this.add('ui_clicked', { feature, ...client }, count);
    for (const [command, count] of Object.entries(input.commands)) this.add('command_run', { command, ...client }, count);
    for (const [page, count] of Object.entries(input.views)) this.add('page_viewed', { page, ...client }, count);
    for (const [page, seconds] of Object.entries(input.seconds)) this.add('page_time', { page, ...client }, 0, seconds);
    if (input.components) this.capture('ui_inventory', { components: [...new Set(input.components)].sort(), ...client });
    return { accepted: true };
  }

  feedback(raw: unknown): { accepted: boolean } {
    if (!this.enabled) return { accepted: false };
    const input = telemetryFeedbackInput.parse(raw);
    this.capture('feedback', { sentiment: input.sentiment, feature: input.feature ?? null, note: input.note || null });
    return { accepted: true };
  }

  async flush(): Promise<void> {
    if (this.flushing) return await this.flushing;
    this.flushing = this.send().finally(() => { this.flushing = null; });
    return await this.flushing;
  }

  async dispose(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.inventoryTimer) clearInterval(this.inventoryTimer);
    this.flushTimer = this.inventoryTimer = null;
    // A send already under way holds only what was counted before it began.
    await this.flushing;
    await this.flush();
  }

  private add(event: string, properties: Properties, count: number, seconds = 0): void {
    const tally = this.tally(event, properties);
    if (!tally) return;
    tally.count += count;
    tally.ms += seconds * 1000;
  }

  private tally(event: string, properties: Properties): Tally | null {
    const key = `${event}\u0000${JSON.stringify(properties)}`;
    let tally = this.tallies.get(key);
    if (!tally) {
      if (this.tallies.size >= MAX_TALLIES) return null;
      tally = { event, properties, count: 0, errors: 0, ms: 0 };
      this.tallies.set(key, tally);
    }
    return tally;
  }

  private captureInventory(): void {
    if (!this.enabled) return;
    try {
      const inventory = this.options.inventory();
      this.capture('feature_inventory', {
        tools: [...inventory.tools].sort(),
        channels: [...inventory.channels].sort(),
        settings_changed: [...inventory.settings].sort()
      });
      this.capture('record_counts', Object.fromEntries(Object.entries(inventory.records).map(([table, count]) => [`records_${table}`, count])));
    } catch (error) {
      this.options.log?.('telemetry.inventory_failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private discard(): void {
    this.tallies.clear();
    this.queue = [];
  }

  private async send(): Promise<void> {
    if (!this.enabled) { this.discard(); return; }
    if (this.inventoryPending) {
      this.inventoryPending = false;
      this.captureInventory();
    }
    const now = new Date().toISOString();
    for (const tally of this.tallies.values()) {
      const timing = tally.event === 'page_time' ? { seconds: Math.round(tally.ms / 1000) }
        : tally.ms ? { total_ms: Math.round(tally.ms), mean_ms: Math.round(tally.ms / tally.count) } : {};
      const counts = tally.event === 'page_time' ? {} : { count: tally.count, errors: tally.errors };
      this.queue.push({ event: tally.event, properties: { ...tally.properties, ...counts, ...timing }, timestamp: now });
    }
    this.tallies.clear();
    if (!this.queue.length) return;
    const batch = this.queue.splice(0, this.queue.length);
    const { apiKey, host, installId } = this.current;
    const body = {
      api_key: apiKey,
      batch: batch.map(({ event, properties, timestamp }) => ({
        event,
        timestamp,
        distinct_id: installId,
        properties: { ...this.options.context, ...properties, $process_person_profile: false, $geoip_disable: true }
      }))
    };
    try {
      const response = await (this.options.fetch ?? fetch)(`${TELEMETRY_HOSTS[host]}/batch/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) this.options.log?.('telemetry.send_failed', { status: response.status, events: batch.length });
    } catch (error) {
      // Dropped rather than retried, so an unreachable host never builds a backlog.
      this.options.log?.('telemetry.send_failed', { error: error instanceof Error ? error.message : String(error), events: batch.length });
    }
  }
}
