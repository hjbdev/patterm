import os from 'node:os';
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseService } from './DatabaseService';

// Incompatible hosts refuse to pair or connect instead of failing partway.
export const PEER_PROTOCOL_VERSION = 1;

// Names prefix remote addresses such as `workstation:process_7`, so they are
// short, lowercase, and never contain a colon.
export const HOST_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export const HOST_NAME_RULE = 'Host names use 1–32 lowercase letters, digits, and hyphens, and start and end with a letter or digit.';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_LIFETIME_MS = 10 * 60_000;
const CODE_ATTEMPTS = 5;

export interface HostIdentity { host_id: string; name: string }

// A paired host. Pairing is two-way, but the connection has a direction:
// this host dials an `outbound` peer, and an `inbound` peer dials this host.
export interface PeerHost {
  host_id: string;
  name: string;
  direction: 'outbound' | 'inbound';
  // Where an outbound peer is reached.
  url: string | null;
  // The credential an inbound peer presents.
  grant_id: string | null;
  show_agents: boolean;
  created_at: string;
  last_connected_at: string | null;
  last_error: string | null;
}

export interface PairingCode { code: string; expires_at: string }

interface PairedRow {
  host_id: string; name: string; url: string; credential: string; show_agents: number;
  created_at: string; last_connected_at: string | null; last_error: string | null;
}

interface GrantRow { id: string; host_id: string; name: string; show_agents: number; created_at: string; last_used_at: string | null }

export function defaultHostName(hostname = os.hostname()): string {
  const name = hostname.split('.')[0]!.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
  return HOST_NAME_PATTERN.test(name) ? name : 'host';
}

export function normaliseHostName(value: string): string {
  const name = value.trim().toLowerCase();
  if (!HOST_NAME_PATTERN.test(name)) throw new Error(HOST_NAME_RULE);
  return name;
}

// Users type the code shown on the other host; case, spaces, and the
// separator do not matter.
export function normalisePairingCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

// Owns this host's identity and its paired hosts: the hosts it dials, with
// the credentials they issued, and the hosts that dial it, whose credentials
// are stored only as hashes.
export class HostService {
  private code: { hash: Buffer; expiresAt: number; attempts: number } | null = null;

  constructor(private readonly database: DatabaseService, private readonly now: () => number = Date.now) {}

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  identity(): HostIdentity {
    const db = this.database.connection;
    const row = db.prepare('select host_id, name from host_identity where singleton = 1').get() as HostIdentity | undefined;
    if (row) return row;
    const stamp = this.stamp();
    db.prepare('insert or ignore into host_identity(singleton, host_id, name, created_at, updated_at) values(1, ?, ?, ?, ?)')
      .run(`host_${randomUUID()}`, defaultHostName(), stamp, stamp);
    return db.prepare('select host_id, name from host_identity where singleton = 1').get() as HostIdentity;
  }

  rename(value: string): HostIdentity {
    const name = normaliseHostName(value);
    const self = this.identity();
    if (this.peers().some((peer) => peer.name === name)) throw new Error(`A paired host is already called ${name}.`);
    this.database.connection.prepare('update host_identity set name = ?, updated_at = ? where singleton = 1').run(name, this.stamp());
    return { ...self, name };
  }

  // Paired hosts, one entry per host. A host paired in both directions is
  // dialled, not waited for.
  peers(): PeerHost[] {
    const db = this.database.connection;
    const grants = new Map((db.prepare(`select id, host_id, name, show_agents, created_at, last_used_at from peer_grants
      where revoked_at is null`).all() as unknown as GrantRow[]).map((grant) => [grant.host_id, grant]));
    const peers: PeerHost[] = (db.prepare('select * from paired_hosts').all() as unknown as PairedRow[]).map((row) => ({
      host_id: row.host_id, name: row.name, direction: 'outbound', url: row.url, grant_id: grants.get(row.host_id)?.id ?? null,
      show_agents: row.show_agents === 1, created_at: row.created_at, last_connected_at: row.last_connected_at, last_error: row.last_error
    }));
    for (const grant of grants.values()) {
      if (peers.some((peer) => peer.host_id === grant.host_id)) continue;
      peers.push({
        host_id: grant.host_id, name: grant.name, direction: 'inbound', url: null, grant_id: grant.id,
        show_agents: grant.show_agents === 1, created_at: grant.created_at, last_connected_at: grant.last_used_at, last_error: null
      });
    }
    return peers.sort((a, b) => a.name.localeCompare(b.name));
  }

  peer(hostId: string): PeerHost | null {
    return this.peers().find((peer) => peer.host_id === hostId) ?? null;
  }

  // The address and credential for dialling an outbound peer.
  dialTarget(hostId: string): { url: string; credential: string } | null {
    return (this.database.connection.prepare('select url, credential from paired_hosts where host_id = ?').get(hostId) as { url: string; credential: string } | undefined) ?? null;
  }

  private assertName(hostId: string, value: string): string {
    const name = normaliseHostName(value);
    if (name === this.identity().name) throw new Error(`The other host is also called ${name}. Rename one of them, then pair again.`);
    if (this.peers().some((peer) => peer.name === name && peer.host_id !== hostId)) throw new Error(`A paired host is already called ${name}. Rename one of them, then pair again.`);
    return name;
  }

  // Records a host this one now dials. Pairing the same host again replaces
  // its address and credential.
  savePairedHost(remote: { host_id: string; name: string; url: string; credential: string }): PeerHost {
    if (remote.host_id === this.identity().host_id) throw new Error('A host cannot pair with itself.');
    const name = this.assertName(remote.host_id, remote.name);
    const stamp = this.stamp();
    this.database.connection.prepare(`insert into paired_hosts(host_id, name, url, credential, created_at, updated_at)
      values(?, ?, ?, ?, ?, ?)
      on conflict(host_id) do update set name = excluded.name, url = excluded.url, credential = excluded.credential,
        updated_at = excluded.updated_at, last_error = null`)
      .run(remote.host_id, name, remote.url, remote.credential, stamp, stamp);
    return this.peer(remote.host_id)!;
  }

  // A peer renamed itself. Returns false, keeping the old name, when the new
  // one clashes.
  updatePeerName(hostId: string, value: string): boolean {
    let name: string;
    try { name = this.assertName(hostId, value); } catch { return false; }
    const db = this.database.connection;
    db.prepare('update paired_hosts set name = ?, updated_at = ? where host_id = ? and name <> ?').run(name, this.stamp(), hostId, name);
    db.prepare('update peer_grants set name = ? where host_id = ? and revoked_at is null and name <> ?').run(name, hostId, name);
    return true;
  }

  setShowAgents(hostId: string, show: boolean): boolean {
    const db = this.database.connection;
    const value = show ? 1 : 0;
    const changes = Number(db.prepare('update paired_hosts set show_agents = ? where host_id = ?').run(value, hostId).changes)
      + Number(db.prepare('update peer_grants set show_agents = ? where host_id = ? and revoked_at is null').run(value, hostId).changes);
    return changes > 0;
  }

  recordConnection(hostId: string, error: string | null): void {
    const db = this.database.connection;
    if (error === null) {
      const stamp = this.stamp();
      db.prepare('update paired_hosts set last_connected_at = ?, last_error = null where host_id = ?').run(stamp, hostId);
      db.prepare('update peer_grants set last_used_at = ? where host_id = ? and revoked_at is null').run(stamp, hostId);
    } else {
      db.prepare('update paired_hosts set last_error = ? where host_id = ?').run(error.slice(0, 500), hostId);
    }
  }

  // Forgets a peer in both directions: this host stops dialling it, its
  // credential stops working here, and its project links go.
  removePeer(hostId: string): boolean {
    const db = this.database.connection;
    return db.transaction(() => {
      db.prepare('delete from project_links where host_id = ?').run(hostId);
      const dialled = Number(db.prepare('delete from paired_hosts where host_id = ?').run(hostId).changes);
      const granted = Number(db.prepare('update peer_grants set revoked_at = ? where host_id = ? and revoked_at is null').run(this.stamp(), hostId).changes);
      return dialled + granted > 0;
    })();
  }

  // Shows a new one-time code and replaces any earlier one.
  createPairingCode(): PairingCode {
    const raw = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    const expiresAt = this.now() + CODE_LIFETIME_MS;
    this.code = { hash: sha256(raw), expiresAt, attempts: 0 };
    return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expires_at: new Date(expiresAt).toISOString() };
  }

  cancelPairingCode(): void {
    this.code = null;
  }

  // Exchanges the current one-time code for a long-lived credential. A code
  // works once, and a few wrong guesses discard it.
  redeemPairingCode(code: string, remote: { host_id: string; name: string }): { grant_id: string; credential: string } {
    const current = this.code;
    if (!current || current.expiresAt <= this.now()) {
      this.code = null;
      throw new Error('No pairing code is active on this host. Create a new code and try again.');
    }
    if (!timingSafeEqual(current.hash, sha256(normalisePairingCode(code)))) {
      if (++current.attempts >= CODE_ATTEMPTS) this.code = null;
      throw new Error('The pairing code is incorrect.');
    }
    this.code = null;
    if (remote.host_id === this.identity().host_id) throw new Error('A host cannot pair with itself.');
    const name = this.assertName(remote.host_id, remote.name);
    const credential = `ptp_${randomBytes(32).toString('base64url')}`;
    const stamp = this.stamp();
    const grantId = `grant_${randomUUID()}`;
    const db = this.database.connection;
    db.transaction(() => {
      // Pairing again replaces the host's earlier credential.
      db.prepare('update peer_grants set revoked_at = ? where host_id = ? and revoked_at is null').run(stamp, remote.host_id);
      db.prepare('insert into peer_grants(id, host_id, name, token_hash, created_at) values(?, ?, ?, ?, ?)')
        .run(grantId, remote.host_id, name, sha256(credential).toString('hex'), stamp);
    })();
    return { grant_id: grantId, credential };
  }

  // The inbound peer a presented credential belongs to, or null when it is
  // unknown or revoked.
  verifyCredential(credential: string): { grant_id: string; host_id: string; name: string } | null {
    if (!credential.startsWith('ptp_')) return null;
    const grant = this.database.connection.prepare(`select id, host_id, name from peer_grants
      where token_hash = ? and revoked_at is null`).get(sha256(credential).toString('hex')) as { id: string; host_id: string; name: string } | undefined;
    return grant ? { grant_id: grant.id, host_id: grant.host_id, name: grant.name } : null;
  }
}
