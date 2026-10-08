import { z } from 'zod';
import { HOST_NAME_PATTERN, HOST_NAME_RULE, PEER_PROTOCOL_VERSION, type HostService, type PeerHost } from '../Services/HostService';
import type { PeerLinkService, PeerLinkStatus } from '../Services/PeerLinkService';
import type { ProjectLink } from '../Services/ProjectLinkService';

export const PEER_PAIR_PATH = '/api/peer/pair';
const PAIR_TIMEOUT_MS = 15_000;

const hostName = z.string().trim().toLowerCase().regex(HOST_NAME_PATTERN, HOST_NAME_RULE);
const hostId = z.string().regex(/^host_[0-9a-f-]{36}$/, 'Invalid host ID');

// Tailnet hosts are reached over HTTPS. Plain HTTP is only for this machine,
// such as a second instance in a test.
export const hostUrl = z.string().trim().max(2000).transform((value, context) => {
  let url: URL;
  try { url = new URL(value); } catch {
    context.addIssue({ code: 'custom', message: 'Enter the other host’s address, such as https://workstation.example.ts.net' });
    return z.NEVER;
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) || url.username || url.password) {
    context.addIssue({ code: 'custom', message: 'Use an https:// address. Plain http:// is only allowed for this machine.' });
    return z.NEVER;
  }
  return url.origin;
});

export const renameHostInput = z.object({ name: hostName }).strict();
export const pairHostInput = z.object({ url: hostUrl, code: z.string().trim().min(1).max(40) }).strict();
export const hostIdInput = z.object({ host_id: hostId }).strict();
export const showAgentsInput = z.object({ host_id: hostId, show_agents: z.boolean() }).strict();

// Sent by the host that pairs; answered by the host showing the code.
export const peerPairRequest = z.object({
  protocol_version: z.number().int(),
  code: z.string().min(1).max(40),
  host_id: hostId,
  name: hostName
}).strict();

const peerPairResponse = z.object({
  protocol_version: z.number().int(),
  host_id: hostId,
  name: hostName,
  credential: z.string().startsWith('ptp_').max(200)
});

export interface HostOverview {
  self: { host_id: string; name: string };
  // Only a server reachable by other hosts can show a pairing code.
  accepts_pairing: boolean;
  // Why this host cannot pair or connect, if it cannot.
  pairing_blocked: string | null;
  // This server has a password, which pairing does not use.
  password_set: boolean;
  peers: Array<PeerHost & { link: PeerLinkStatus; projects: ProjectLink[] }>;
}

export class HostActions {
  constructor(
    private readonly hosts: HostService,
    private readonly links: PeerLinkService,
    private readonly options: { acceptsPairing: boolean; pairingBlocked?: () => string | null; passwordSet?: () => boolean; fetch?: typeof fetch; onChange?: () => void; projectLinks?: (hostId: string) => ProjectLink[]; onUnpaired?: (host: { host_id: string; name: string }) => void }
  ) {
    // A peer that unpairs or renames itself updates this host too.
    links.onEvent((event) => {
      if (event.event === 'peer.unpaired') {
        const peer = this.hosts.peer(event.host_id);
        this.hosts.removePeer(event.host_id);
        if (peer) this.options.onUnpaired?.(peer);
        this.links.refresh();
      } else if (event.event === 'peer.renamed') {
        const name = (event.payload as { name?: unknown } | undefined)?.name;
        if (typeof name !== 'string' || !this.hosts.updatePeerName(event.host_id, name)) return;
      } else return;
      this.options.onChange?.();
    });
  }

  overview(): HostOverview {
    const links = this.links.statuses();
    return {
      self: this.hosts.identity(),
      accepts_pairing: this.options.acceptsPairing && !this.options.pairingBlocked?.(),
      pairing_blocked: this.options.pairingBlocked?.() ?? null,
      password_set: this.options.passwordSet?.() ?? false,
      peers: this.hosts.peers().map((peer) => ({
        ...peer,
        link: links[peer.host_id] ?? { state: 'offline', error: null, since: peer.created_at },
        projects: this.options.projectLinks?.(peer.host_id) ?? []
      }))
    };
  }

  rename(raw: unknown): HostOverview {
    const { name } = this.hosts.rename(renameHostInput.parse(raw).name);
    for (const peer of this.hosts.peers()) this.links.emit(peer.host_id, 'peer.renamed', { name });
    return this.overview();
  }

  createPairingCode() {
    const blocked = this.options.pairingBlocked?.();
    if (blocked) throw new Error(blocked);
    if (!this.options.acceptsPairing) throw new Error('Only a Patterm server can accept pairing. Pair from this host to the server instead.');
    return this.hosts.createPairingCode();
  }

  cancelPairingCode(): void {
    this.hosts.cancelPairingCode();
  }

  // Asks another host to accept this one, using the code shown there, and
  // stores the credential it issues.
  async pair(raw: unknown): Promise<HostOverview> {
    const { url, code } = pairHostInput.parse(raw);
    const blocked = this.options.pairingBlocked?.();
    if (blocked) throw new Error(blocked);
    const self = this.hosts.identity();
    const request = (this.options.fetch ?? fetch)(`${url}${PEER_PAIR_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocol_version: PEER_PROTOCOL_VERSION, code, host_id: self.host_id, name: self.name }),
      redirect: 'error',
      signal: AbortSignal.timeout(PAIR_TIMEOUT_MS)
    });
    let response: Response;
    try { response = await request; } catch (error) {
      throw new Error(`Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : `${url} refused to pair (HTTP ${response.status}).`);
    const remote = peerPairResponse.parse(body);
    if (remote.protocol_version !== PEER_PROTOCOL_VERSION) throw new Error(`${url} uses an incompatible Patterm version. Update both hosts, then pair again.`);
    this.hosts.savePairedHost({ host_id: remote.host_id, name: remote.name, url, credential: remote.credential });
    this.links.refresh();
    return this.overview();
  }

  // Answers another host's pairing request.
  acceptPairing(raw: unknown) {
    const request = peerPairRequest.parse(raw);
    if (this.options.pairingBlocked?.()) throw new Error('This host is not accepting pairing.');
    const self = this.hosts.identity();
    if (request.protocol_version !== PEER_PROTOCOL_VERSION) {
      throw new Error('This host uses an incompatible Patterm version. Update both hosts, then pair again.');
    }
    const { credential } = this.hosts.redeemPairingCode(request.code, { host_id: request.host_id, name: request.name });
    return { protocol_version: PEER_PROTOCOL_VERSION, host_id: self.host_id, name: self.name, credential };
  }

  // Forgets the host here and, when it is connected, there too. A host
  // that is offline keeps its entry and can no longer connect.
  unpair(raw: unknown): HostOverview {
    const { host_id } = hostIdInput.parse(raw);
    const peer = this.hosts.peer(host_id);
    this.links.emit(host_id, 'peer.unpaired');
    this.hosts.removePeer(host_id);
    if (peer) this.options.onUnpaired?.(peer);
    this.links.refresh();
    return this.overview();
  }

  setShowAgents(raw: unknown): HostOverview {
    const { host_id, show_agents } = showAgentsInput.parse(raw);
    if (!this.hosts.setShowAgents(host_id, show_agents)) throw new Error('That host is not paired.');
    return this.overview();
  }
}
