import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DatabaseService } from './DatabaseService';
import { HOST_NAME_PATTERN, type HostService, type PeerHost } from './HostService';
import { PeerRequestError, type PeerIdentity, type PeerLinkService } from './PeerLinkService';
import type { ProjectLinkService } from './ProjectLinkService';
import type { TimelineService } from './TimelineService';

// Agents read everything in a linked project on another host, but only
// through tools that change nothing. Context reads run as the owner within
// the linked project; the rest run as a caller scoped to it.
export const REMOTE_CONTEXT_READ_TOOLS = new Set([
  'todo_list', 'todo_get', 'scratchpad_list', 'scratchpad_get', 'reference_list'
]);
export const REMOTE_READ_TOOLS = new Set([
  'list_processes', 'get_process_status', 'get_project_status', 'get_process_output', 'get_conversation_output',
  'search_output', 'get_process_ports', 'worktree_list', 'diff_current', 'diff_file',
  ...REMOTE_CONTEXT_READ_TOOLS
]);

// Routine tools an agent may call on a paired host. The routine is saved,
// owned, and run there; starting a run from another host is not allowed.
export const REMOTE_ROUTINE_TOOLS = new Set([
  'routine_list', 'routine_get', 'routine_create', 'routine_schedule_once',
  'routine_update', 'routine_delete', 'routine_runs', 'routine_log', 'routine_run'
]);

const READ_TIMEOUT_MS = 20_000;
const MESSAGE_TIMEOUT_MS = 30_000;
export const MESSAGE_MAX_BYTES = 64 * 1024;

export type PeerMessageStatus = 'queued' | 'delivered' | 'uncertain' | 'bounced';

export interface RemoteAddress { host: PeerHost; process_id: string; address: string }
export interface MessageSender { session_id: string; project_id: string; process_id: string | null }
export interface SendResult { status: PeerMessageStatus; peer_message_id: string; detail?: string }

// A delivery into a local agent; Integrated agents may report it uncertain.
export type Deliver = (processId: string, text: string) => Promise<'delivered' | 'uncertain'>;

const id = z.string().min(1).max(200);
const incomingMessage = z.object({
  peer_message_id: id,
  project_id: id,
  from_process_id: id,
  to_process_id: id,
  body: z.string().min(1).refine((value) => Buffer.byteLength(value, 'utf8') <= MESSAGE_MAX_BYTES, 'Message is too large')
}).strict();
const messageReply = z.object({ status: z.enum(['delivered', 'uncertain', 'bounced']), error: z.string().max(1000).nullish() });
type MessageReply = z.infer<typeof messageReply>;
const readRequest = z.object({ project_id: id, tool: z.string().max(100), arguments: z.record(z.string(), z.unknown()).default({}) }).strict();
const routineAgent = z.object({ session_id: id, process_id: id.nullable(), name: z.string().min(1).max(200) }).strict();
const routineRequest = readRequest.extend({ agent: routineAgent });
export type RoutineAgent = z.infer<typeof routineAgent>;

interface OutRow { id: string; host_id: string; project_id: string | null; from_process_id: string; to_process_id: string; body: string; status: PeerMessageStatus }

export interface CrossHostOptions {
  deliver: Deliver;
  // Runs a read tool for another host, within one of this host's projects.
  read: (tool: string, args: Record<string, unknown>, scope: { host: PeerIdentity; project_id: string }) => Promise<unknown>;
  // Runs a routine tool for an agent on another host, within one of this
  // host's projects.
  routine?: (tool: string, args: Record<string, unknown>, scope: { host: PeerIdentity; project_id: string; agent: RoutineAgent }) => Promise<unknown>;
  // A message from a local agent bounced; tell the user.
  bounced?: (processId: string, title: string, body: string) => void;
  now?: () => number;
}

// Addresses, reads, and messages between agents on paired hosts. Every
// message is recorded on both hosts, and the sending host keeps it until
// the other host answers, so a host being offline delays it but never
// loses it. The receiving host remembers each message, so a resend after a
// lost answer is delivered once.
export class CrossHostService {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly receiving = new Map<string, Promise<MessageReply>>();

  constructor(
    private readonly database: DatabaseService,
    private readonly hosts: HostService,
    private readonly peers: PeerLinkService,
    private readonly links: ProjectLinkService,
    private readonly timeline: TimelineService,
    private readonly options: CrossHostOptions
  ) {
    peers.handle('agents.read', (raw, peer) => this.serveRead(raw, peer));
    peers.handle('agents.routine', (raw, peer) => this.serveRoutine(raw, peer));
    peers.handle('agents.message', (raw, peer) => this.receive(raw, peer));
    peers.onConnected((hostId) => void this.flush(hostId));
  }

  private stamp(): string {
    return new Date((this.options.now ?? Date.now)()).toISOString();
  }

  // `workstation:process_7` names an agent on a paired host. Local process IDs
  // never contain a colon.
  parseAddress(value: string): RemoteAddress | null {
    const separator = value.indexOf(':');
    if (separator <= 0) return null;
    const name = value.slice(0, separator);
    const processId = value.slice(separator + 1);
    if (!HOST_NAME_PATTERN.test(name) || !processId || processId.includes(':')) return null;
    return { host: this.host(name), process_id: processId, address: `${name}:${processId}` };
  }

  host(name: string): PeerHost {
    const host = this.hosts.peers().find((peer) => peer.name === name);
    if (!host) throw new Error(`No paired host is called ${name}. Paired hosts: ${this.hosts.peers().map((peer) => peer.name).join(', ') || 'none'}.`);
    return host;
  }

  // The project on the other host that a local project is linked to.
  remoteProject(hostId: string, projectId: string): string {
    const link = this.links.links(hostId).find((candidate) => candidate.project_id === projectId);
    if (!link) throw new Error(`This project is not linked with ${this.hosts.peer(hostId)?.name ?? 'that host'}. Link it in Settings → Hosts.`);
    return link.remote_project_id;
  }

  async read(projectId: string, hostId: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    if (!REMOTE_READ_TOOLS.has(tool)) throw new Error(`${tool} cannot run on another host. Agents on other hosts can only be read and messaged.`);
    return this.peers.request(hostId, 'agents.read', { project_id: this.remoteProject(hostId, projectId), tool, arguments: args }, READ_TIMEOUT_MS);
  }

  // Saves or reads routines on another host, in the project linked with the
  // caller's.
  async routine(projectId: string, hostId: string, tool: string, args: Record<string, unknown>, agent: RoutineAgent): Promise<unknown> {
    if (!REMOTE_ROUTINE_TOOLS.has(tool)) throw new Error(`${tool} cannot run on another host.`);
    return this.peers.request(hostId, 'agents.routine', { project_id: this.remoteProject(hostId, projectId), tool, arguments: args, agent }, READ_TIMEOUT_MS);
  }

  // Agents on the hosts a project is linked with, addressed as host:process.
  async remoteProcesses(projectId: string, args: Record<string, unknown> = {}): Promise<{ processes: Array<Record<string, unknown>>; unavailable: string[] }> {
    const processes: Array<Record<string, unknown>> = [];
    const unavailable: string[] = [];
    await Promise.all(this.links.links().filter((link) => link.project_id === projectId).map(async (link) => {
      const host = this.hosts.peer(link.host_id);
      if (!host) return;
      try {
        const result = await this.read(projectId, host.host_id, 'list_processes', args) as { processes?: Array<Record<string, unknown>> };
        for (const row of result.processes ?? []) {
          processes.push({
            ...row,
            process_id: `${host.name}:${String(row.process_id)}`,
            ...(typeof row.parent_process_id === 'string' ? { parent_process_id: `${host.name}:${row.parent_process_id}` } : {}),
            is_current: false,
            host: host.name
          });
        }
      } catch {
        unavailable.push(host.name);
      }
    }));
    return { processes, unavailable: unavailable.sort() };
  }

  // Queues a message for an agent on another host and tries to deliver it.
  async send(sender: MessageSender, target: RemoteAddress, body: string): Promise<SendResult> {
    if (!sender.process_id) throw new Error('send_message: only agents can message agents on other hosts');
    if (Buffer.byteLength(body, 'utf8') > MESSAGE_MAX_BYTES) throw new Error('send_message: messages to other hosts are limited to 64 KB; put details in a scratchpad and point to it');
    this.remoteProject(target.host.host_id, sender.project_id);
    const messageId = `pmsg_${randomUUID()}`;
    const stamp = this.stamp();
    this.database.connection.prepare(`insert into peer_messages(id, direction, host_id, project_id, from_process_id, to_process_id, body, status, created_at, updated_at)
      values(?, 'out', ?, ?, ?, ?, ?, 'queued', ?, ?)`).run(messageId, target.host.host_id, sender.project_id, sender.process_id, target.process_id, body, stamp, stamp);
    this.timeline.append({
      event_type: 'message.sent', project_id: sender.project_id, session_id: sender.session_id, process_id: sender.process_id,
      actor_type: 'agent', actor_id: sender.session_id,
      metadata: { to_host_id: target.host.host_id, to_process_id: target.process_id, body, peer_message_id: messageId }
    });
    await this.flush(target.host.host_id);
    const row = this.outRow(messageId)!;
    const detail = row.status === 'queued' ? `${target.host.name} is not connected. The message will be delivered when it reconnects.`
      : row.status === 'uncertain' ? 'The agent may or may not have received this message. Do not resend it blindly.'
      : row.status === 'bounced' ? (this.outError(messageId) ?? 'The message could not be delivered.') : undefined;
    return { status: row.status, peer_message_id: messageId, ...(detail ? { detail } : {}) };
  }

  // Delivers queued messages to a host in the order they were sent.
  flush(hostId: string): Promise<void> {
    const next = (this.queues.get(hostId) ?? Promise.resolve()).then(async () => {
      while (this.peers.connected(hostId)) {
        const row = this.database.connection.prepare(`select * from peer_messages where direction = 'out' and host_id = ? and status = 'queued'
          order by created_at, rowid limit 1`).get(hostId) as OutRow | undefined;
        if (!row) return;
        if (!(await this.attempt(row))) return;
      }
    });
    const settled = next.catch(() => undefined);
    this.queues.set(hostId, settled);
    return settled;
  }

  // Returns false when the link failed, leaving the message queued.
  private async attempt(row: OutRow): Promise<boolean> {
    const db = this.database.connection;
    db.prepare(`update peer_messages set attempts = attempts + 1, updated_at = ? where id = ? and direction = 'out'`).run(this.stamp(), row.id);
    let reply: z.infer<typeof messageReply>;
    try {
      let remoteProject: string | null = null;
      try { remoteProject = row.project_id ? this.remoteProject(row.host_id, row.project_id) : null; } catch { remoteProject = null; }
      if (!remoteProject) throw new BounceError('The project is no longer linked with that host.');
      reply = messageReply.parse(await this.peers.request(row.host_id, 'agents.message', {
        peer_message_id: row.id, project_id: remoteProject, from_process_id: row.from_process_id, to_process_id: row.to_process_id, body: row.body
      }, MESSAGE_TIMEOUT_MS));
    } catch (error) {
      // Only a link failure keeps the message queued; a refusal, from this host
      // or the other, is final and must not hold up the messages behind it.
      if (!(error instanceof BounceError) && !(error instanceof PeerRequestError) && this.hosts.peer(row.host_id)) {
        // The other host keeps every message it receives, so sending this
        // one again after a lost answer cannot deliver it twice.
        return false;
      }
      reply = { status: 'bounced', error: error instanceof Error ? error.message : String(error) };
    }
    db.prepare(`update peer_messages set status = ?, error = ?, updated_at = ? where id = ? and direction = 'out'`).run(reply.status, reply.error ?? null, this.stamp(), row.id);
    if (reply.status === 'bounced') await this.bounce(row, reply.error ?? 'The message could not be delivered.');
    return true;
  }

  // A host was unpaired: its queued messages can never be delivered.
  async bounceQueued(hostId: string, hostName: string): Promise<void> {
    const rows = this.database.connection.prepare(`select * from peer_messages where direction = 'out' and host_id = ? and status = 'queued' order by created_at`).all(hostId) as unknown as OutRow[];
    const reason = `${hostName} was unpaired before the message was delivered.`;
    for (const row of rows) {
      this.database.connection.prepare(`update peer_messages set status = 'bounced', error = ?, updated_at = ? where id = ? and direction = 'out'`).run(reason, this.stamp(), row.id);
      await this.bounce(row, reason, hostName);
    }
  }

  private async bounce(row: OutRow, reason: string, hostName?: string): Promise<void> {
    const name = hostName ?? this.hosts.peer(row.host_id)?.name ?? 'another host';
    const address = `${name}:${row.to_process_id}`;
    if (row.project_id) {
      this.timeline.append({
        event_type: 'message.bounced', project_id: row.project_id, process_id: row.from_process_id, actor_type: 'system',
        metadata: { to_host_id: row.host_id, to_process_id: row.to_process_id, peer_message_id: row.id, reason }
      });
    }
    await this.options.deliver(row.from_process_id, `[delivery failed: your message to ${address} bounced]\n${reason}`).catch(() => undefined);
    this.options.bounced?.(row.from_process_id, `Message to ${address} bounced`, reason);
  }

  // Delivers a message from an agent on a paired host to a local agent. A
  // repeat of a message being delivered waits for that delivery, so a retry
  // after a reconnect cannot type it twice.
  private receive(raw: unknown, peer: PeerIdentity): Promise<MessageReply> {
    const input = incomingMessage.parse(raw);
    const pending = this.receiving.get(input.peer_message_id);
    if (pending) return pending;
    const task = this.receiveOnce(input, peer).finally(() => this.receiving.delete(input.peer_message_id));
    this.receiving.set(input.peer_message_id, task);
    return task;
  }

  private async receiveOnce(input: z.infer<typeof incomingMessage>, peer: PeerIdentity): Promise<MessageReply> {
    const db = this.database.connection;
    const self = this.hosts.identity().name;
    // A message is recorded before it is typed. One still marked queued was
    // interrupted mid-delivery, so it may or may not have arrived.
    const known = db.prepare(`select status, error from peer_messages where id = ? and direction = 'in'`).get(input.peer_message_id) as { status: PeerMessageStatus; error: string | null } | undefined;
    if (known) return known.status === 'queued' ? { status: 'uncertain', error: 'An earlier delivery of this message was interrupted.' } : { status: known.status, error: known.error };
    const from = `${peer.name}:${input.from_process_id}`;
    const stamp = this.stamp();
    const insert = (status: PeerMessageStatus, error: string | null, projectId: string | null) => {
      db.prepare(`insert into peer_messages(id, direction, host_id, project_id, from_process_id, to_process_id, body, status, error, created_at, updated_at)
        values(?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.peer_message_id, peer.host_id, projectId, input.from_process_id, input.to_process_id, input.body, status, error, stamp, stamp);
    };
    const bounce = (error: string, projectId: string | null): MessageReply => {
      insert('bounced', error, projectId);
      return { status: 'bounced', error };
    };
    const linked = this.links.links(peer.host_id).some((link) => link.project_id === input.project_id);
    if (!linked) return bounce(`That project is no longer linked with ${self}.`, null);
    // Only agents receive messages. Typing a message into a shell or command
    // would run it, which would let another host control this one.
    const target = db.prepare(`select processes.status, processes.kind, sessions.exited_at, sessions.id as session_id from processes
      left join sessions on sessions.process_id = processes.id
      where processes.id = ? and processes.project_id = ?
      order by sessions.started_at desc limit 1`).get(input.to_process_id, input.project_id) as { status: string; kind: string; exited_at: string | null; session_id: string | null } | undefined;
    if (!target) return bounce(`${self} has no process ${input.to_process_id} in this project.`, input.project_id);
    if (target.kind !== 'agent' || !target.session_id) return bounce(`${self}:${input.to_process_id} is not an agent. Messages only reach agents.`, input.project_id);
    if (target.status !== 'running' || target.exited_at) return bounce(`${self}:${input.to_process_id} has exited.`, input.project_id);
    insert('queued', null, input.project_id);
    const settle = (status: PeerMessageStatus, error: string | null): MessageReply => {
      db.prepare(`update peer_messages set status = ?, error = ?, updated_at = ? where id = ? and direction = 'in'`).run(status, error, this.stamp(), input.peer_message_id);
      return { status: status === 'queued' ? 'uncertain' : status, error };
    };
    const text = `[message from ${from}]\n${input.body}\n\n(Reply with send_message target_process_id "${from}".)`;
    let delivery: 'delivered' | 'uncertain';
    try {
      delivery = await this.options.deliver(input.to_process_id, text);
    } catch (error) {
      return settle('bounced', `Delivery to ${self}:${input.to_process_id} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.timeline.append({
      event_type: 'message.received', project_id: input.project_id, session_id: target.session_id, process_id: null,
      actor_type: 'remote_agent', actor_id: from,
      metadata: { from_host_id: peer.host_id, from_process_id: input.from_process_id, to_process_id: input.to_process_id, body: input.body, peer_message_id: input.peer_message_id, ...(delivery === 'uncertain' ? { delivery } : {}) }
    });
    return settle(delivery, delivery === 'uncertain' ? 'The agent may or may not have received this message.' : null);
  }

  private async serveRead(raw: unknown, peer: PeerIdentity): Promise<unknown> {
    const input = readRequest.parse(raw);
    if (!REMOTE_READ_TOOLS.has(input.tool)) throw new Error(`${input.tool} cannot run for another host.`);
    if (!this.links.links(peer.host_id).some((link) => link.project_id === input.project_id)) throw new Error(`That project is not linked with ${peer.name}.`);
    return this.options.read(input.tool, input.arguments, { host: peer, project_id: input.project_id });
  }

  private async serveRoutine(raw: unknown, peer: PeerIdentity): Promise<unknown> {
    const input = routineRequest.parse(raw);
    if (!REMOTE_ROUTINE_TOOLS.has(input.tool) || !this.options.routine) throw new Error(`${input.tool} cannot run for another host.`);
    if (!this.links.links(peer.host_id).some((link) => link.project_id === input.project_id)) throw new Error(`That project is not linked with ${peer.name}.`);
    return this.options.routine(input.tool, input.arguments, { host: peer, project_id: input.project_id, agent: input.agent });
  }

  private outRow(messageId: string): OutRow | null {
    return (this.database.connection.prepare(`select * from peer_messages where id = ? and direction = 'out'`).get(messageId) as OutRow | undefined) ?? null;
  }

  private outError(messageId: string): string | null {
    return (this.database.connection.prepare(`select error from peer_messages where id = ? and direction = 'out'`).get(messageId) as { error: string | null } | undefined)?.error ?? null;
  }
}

class BounceError extends Error {}
