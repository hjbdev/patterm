import { z } from 'zod';
import type { PattermApplication } from '../App';
import type { ClientConversationSubscriptions } from './ClientConversationSubscriptions';
import { resolvePtyProcessId } from '../Services/ProcessIdentity';

const dimension = z.number().int().positive().max(1000);
// A subscriber may send its pane size. The size is applied before the
// subscription when that subscriber controls the terminal, so the first
// snapshot already has the pane's dimensions.
const subscriptionInput = z.object({
  process_id: z.string().min(1),
  subscribed: z.boolean(),
  cols: dimension.optional(),
  rows: dimension.optional(),
  cell_width: dimension.optional(),
  cell_height: dimension.optional(),
  resize_seq: z.number().int().nonnegative().max(0xfffffffe).optional()
});
const processInput = z.object({ process_id: z.string().min(1) });

export interface BrowserTerminalClient {
  subscriptions: Set<string>;
  sendEvent(event: string, payload: unknown): void;
  conversations?: ClientConversationSubscriptions;
}

// The sidecar owns one viewport/selection per PTY. One browser controls those
// shared properties; other browsers receive the same screen until taking over.
export class BrowserTerminalSessions {
  readonly clients = new Set<BrowserTerminalClient>();
  private readonly owners = new Map<string, BrowserTerminalClient>();
  private readonly resizeSequences = new Map<string, number>();

  constructor(private readonly application: PattermApplication) {
    // This host decides control of its own processes, between its browsers
    // and paired hosts. A paired host decides control of its processes.
    application.remote.trackLocalControl((key) => this.owners.has(key), (key) => this.revoke(key));
    application.remote.onControlLost((processId) => this.revoke(processId));
  }

  async subscribe(client: BrowserTerminalClient, raw: unknown): Promise<unknown> {
    const payload = subscriptionInput.parse(raw);
    const host = this.application.remote.target({ process_id: payload.process_id });
    if (host) return this.subscribeRemote(client, payload, host);
    const { id, integrated, active } = this.resolve(payload.process_id);
    let resized = false;
    if (payload.subscribed) {
      if (client.subscriptions.size >= 32 && !client.subscriptions.has(id)) throw new Error('Too many terminal subscriptions');
      if (integrated && !active) throw new Error('Integrated session is not active');
      const added = !client.subscriptions.has(id);
      const claimed = !this.owners.has(id) && !this.application.remote.peerControls(id);
      client.subscriptions.add(id);
      if (claimed) this.owners.set(id, client);
      // The sidecar subscription rejects unknown PTYs, so it also validates the
      // process without a separate status round trip.
      try {
        if (!integrated && payload.cols && payload.rows && this.owners.get(id) === client) {
          const resize = {
            process_id: id,
            cols: payload.cols,
            rows: payload.rows,
            ...(payload.cell_width ? { cell_width: payload.cell_width } : {}),
            ...(payload.cell_height ? { cell_height: payload.cell_height } : {}),
            resize_seq: this.nextResizeSequence(id, payload.resize_seq)
          };
          const host = this.application.remote.target(resize);
          if (host) await this.application.remote.relay(host, 'patterm:terminal:resize', resize);
          else await this.application.terminal.request('terminal.process.resize', resize);
          resized = true;
        }
        await this.sync(id);
      } catch (error) {
        if (added) client.subscriptions.delete(id);
        if (claimed && this.owners.get(id) === client) this.owners.delete(id);
        throw error;
      }
    } else {
      client.subscriptions.delete(id);
      if (this.owners.get(id) === client) this.owners.delete(id);
      await this.sync(id);
    }
    this.notifyControl(id);
    return { ok: true, process_id: id, controlling: this.owners.get(id) === client, ...(resized ? { resized: true } : {}) };
  }

  async takeControl(client: BrowserTerminalClient, raw: unknown): Promise<unknown> {
    const { id, active } = this.resolve(processInput.parse(raw).process_id);
    if (!active) throw new Error('Session is not active');
    if (!client.subscriptions.has(id)) throw new Error('Subscribe before taking terminal control');
    const host = this.application.remote.target({ process_id: id });
    if (host) await this.application.remote.relay(host, 'patterm:terminal:take-control', { process_id: id });
    else this.application.remote.claimLocal(id);
    this.owners.set(id, client);
    this.notifyControl(id);
    return { ok: true };
  }

  guard(client: BrowserTerminalClient, raw: unknown, resize = false): unknown {
    const { id, active } = this.resolve(processInput.parse(raw).process_id);
    if (!active) throw new Error('Session is not active');
    if (this.owners.get(id) !== client) throw new Error('Take control of this terminal first');
    if (!resize) return raw;
    const requested = z.object({ resize_seq: z.number().int().nonnegative().max(0xfffffffe).optional() }).parse(raw);
    return { ...(raw as object), resize_seq: this.nextResizeSequence(id, requested.resize_seq) };
  }

  // A paired host's process: the paired host says whether this host may
  // control it, and this host chooses which of its browsers does.
  private async subscribeRemote(client: BrowserTerminalClient, payload: z.infer<typeof subscriptionInput>, host: NonNullable<ReturnType<PattermApplication['remote']['target']>>): Promise<unknown> {
    const id = payload.process_id;
    let resized = false;
    if (payload.subscribed) {
      if (client.subscriptions.size >= 32 && !client.subscriptions.has(id)) throw new Error('Too many terminal subscriptions');
      const added = !client.subscriptions.has(id);
      const wantsControl = !this.owners.has(id);
      client.subscriptions.add(id);
      try {
        const result = await this.application.remote.relay(host, 'patterm:terminal:subscribe', { process_id: id, subscribed: true }) as { controlling?: boolean } | null;
        if (wantsControl && result?.controlling) this.owners.set(id, client);
        if (payload.cols && payload.rows && this.owners.get(id) === client) {
          await this.application.remote.relay(host, 'patterm:terminal:resize', {
            process_id: id, cols: payload.cols, rows: payload.rows,
            ...(payload.cell_width ? { cell_width: payload.cell_width } : {}),
            ...(payload.cell_height ? { cell_height: payload.cell_height } : {}),
            resize_seq: this.nextResizeSequence(id, payload.resize_seq)
          });
          resized = true;
        }
      } catch (error) {
        if (added) client.subscriptions.delete(id);
        if (this.owners.get(id) === client) this.owners.delete(id);
        throw error;
      }
    } else {
      client.subscriptions.delete(id);
      if (this.owners.get(id) === client) this.owners.delete(id);
      await this.sync(id);
    }
    this.notifyControl(id);
    return { ok: true, process_id: id, controlling: this.owners.get(id) === client, ...(resized ? { resized: true } : {}) };
  }

  // Another viewer, here or on a paired host, took control.
  private revoke(id: string): void {
    if (this.owners.delete(id)) this.notifyControl(id);
  }

  // Resize sequences only grow per PTY, whichever browser sends them.
  private nextResizeSequence(id: string, requested: number | undefined): number {
    const sequence = Math.max((this.resizeSequences.get(id) ?? 0) + 1, requested ?? 0);
    this.resizeSequences.set(id, sequence);
    return sequence;
  }

  // Clipboard writes and link opens act on one person's machine, so they go
  // only to the client that controls the PTY.
  sendToController(processId: string, event: string, payload: unknown): boolean {
    const owner = this.owners.get(processId);
    owner?.sendEvent(event, payload);
    return Boolean(owner);
  }

  async disconnect(client: BrowserTerminalClient): Promise<void> {
    this.clients.delete(client);
    client.conversations?.dispose();
    for (const id of client.subscriptions) {
      if (this.owners.get(id) === client) this.owners.delete(id);
      await this.sync(id).catch(() => {});
      this.notifyControl(id);
    }
    client.subscriptions.clear();
  }

  private async sync(id: string): Promise<void> {
    if (this.resolve(id).integrated) return;
    const subscribed = [...this.clients].some((client) => client.subscriptions.has(id));
    // A paired host's terminal streams through that host.
    const host = this.application.remote.target({ process_id: id });
    if (host) {
      await this.application.remote.relay(host, 'patterm:terminal:subscribe', { process_id: id, subscribed });
      return;
    }
    await this.application.terminalSubscriptions.set('browsers', id, subscribed);
  }

  private resolve(processId: string): { id: string; integrated: boolean; active: boolean } {
    // The paired host checks its own records when the request reaches it.
    if (this.application.remote.target({ process_id: processId })) return { id: processId, integrated: false, active: true };
    const integrated = this.application.database.connection.prepare(`select processes.id, processes.status, sessions.exited_at from processes join sessions on sessions.process_id = processes.id
      where processes.id = ? and sessions.interface_mode = 'integrated' order by sessions.started_at desc limit 1`).get(processId) as { id: string; status: string; exited_at: string | null } | undefined;
    return integrated
      ? { id: integrated.id, integrated: true, active: integrated.status === 'running' && integrated.exited_at === null }
      : { id: resolvePtyProcessId(this.application.database, processId), integrated: false, active: true };
  }

  private notifyControl(id: string): void {
    for (const client of this.clients) {
      if (client.subscriptions.has(id)) client.sendEvent('terminal-control', { processId: id, controlling: this.owners.get(id) === client });
    }
  }
}
