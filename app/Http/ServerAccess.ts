import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

// The server's optional password and the key that signs sign-in cookies. They
// live in a file in the data directory, outside the database, so the service
// installer can set them while Patterm is stopped.
export const SERVER_ACCESS_FILE = 'server-access.json';
export const SESSION_COOKIE = 'patterm_session';
const SESSION_DAYS = 365;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 1024;
// About 100 ms per check, so guessing is slow even before the failure limit.
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };
const MAX_FAILURES_PER_MINUTE = 10;

export const REMOTE_ACCESS_MODES = ['local', 'tailscale', 'network'] as const;
export type RemoteAccessMode = typeof REMOTE_ACCESS_MODES[number];

// How browsers reach the server: this machine only, through Tailscale Serve,
// or on a network address. The installer and Settings › Remote access write
// it; the server applies it when it starts.
export const remoteAccessInput = z.object({
  mode: z.enum(REMOTE_ACCESS_MODES),
  // The address to listen on in network mode, besides loopback.
  bind: z.string().trim().max(64).nullable().default(null),
  // In Tailscale mode, refuse requests that Tailscale says come from another login.
  owner_login: z.string().trim().min(1).max(320).nullable().default(null)
}).strict();
export type RemoteAccess = z.infer<typeof remoteAccessInput>;

const stored = z.object({
  version: z.literal(1),
  password: z.string().nullable(),
  secret: z.string().min(32),
  // Absent on servers set up before the setting existed; they keep using
  // PATTERM_PUBLIC_ORIGIN and PATTERM_OWNER_LOGIN.
  remote: remoteAccessInput.optional()
});
type Stored = z.infer<typeof stored>;

export class ServerAccess {
  private state: Stored;
  private failures: number[] = [];
  private checking = 0;

  constructor(private readonly file: string, private readonly now = Date.now) {
    this.state = this.read() ?? { version: 1, password: null, secret: randomBytes(32).toString('base64url') };
  }

  static forDataDirectory(appDataPath: string): ServerAccess {
    return new ServerAccess(path.join(appDataPath, SERVER_ACCESS_FILE));
  }

  passwordSet(): boolean {
    return this.state.password !== null;
  }

  remoteAccess(): RemoteAccess | null {
    return this.state.remote ?? null;
  }

  // Network mode needs a password, because anyone on that network could
  // otherwise use Patterm.
  setRemoteAccess(raw: unknown): RemoteAccess {
    const remote = remoteAccessInput.parse(raw);
    if (remote.mode === 'network' && !remote.bind) throw new Error('Choose an address to listen on');
    if (remote.mode === 'network' && !this.passwordSet()) throw new Error('Set a password before opening Patterm to a network');
    this.state = { ...this.state, remote: { mode: remote.mode, bind: remote.mode === 'network' ? remote.bind : null, owner_login: remote.mode === 'tailscale' ? remote.owner_login : null } };
    this.write();
    return this.state.remote!;
  }

  // Sets, changes, or removes the password. Changing or removing one needs
  // the current password. Every change replaces the signing key, which signs
  // out all browsers; the returned cookie value keeps the caller signed in.
  async setPassword(next: string | null, current: string | null): Promise<string | null> {
    if (next !== null) validatePassword(next);
    const before = this.state;
    if (before.password !== null && !(current !== null && await this.attempt(before, current))) throw new Error('The current password is wrong');
    const password = next === null ? null : await hashPassword(next);
    if (this.state !== before) throw new Error('The password changed meanwhile. Reload and try again.');
    if (password === null && before.remote?.mode === 'network') throw new Error('Patterm is open to a network, which needs a password. Switch Remote access to this machine or Tailscale first.');
    this.state = { ...before, password, secret: randomBytes(32).toString('base64url') };
    this.write();
    return password === null ? null : this.sessionToken(this.state, this.now());
  }

  // A successful sign-in returns a cookie value; a wrong password returns null.
  async signIn(password: string): Promise<string | null> {
    const state = this.state;
    if (state.password === null) return null;
    if (!await this.attempt(state, password)) return null;
    // A password change while this one was checked makes the check stale.
    return this.state === state ? this.sessionToken(state, this.now()) : null;
  }

  // True when no password is set, or the request carries a valid cookie.
  allows(cookieHeader: string | undefined): boolean {
    if (!this.passwordSet()) return true;
    const token = readCookie(cookieHeader, SESSION_COOKIE);
    const [issued, signature] = token?.split('.') ?? [];
    if (!issued || !signature || !/^\d+$/.test(issued)) return false;
    const issuedAt = Number(issued);
    if (issuedAt > this.now() + 60_000 || this.now() - issuedAt > SESSION_DAYS * 86_400_000) return false;
    return safeEqual(signature, this.sign(issued));
  }

  sessionCookie(token: string, secure: boolean): string {
    return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_DAYS * 86_400}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  }

  clearedCookie(secure: boolean): string {
    return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  }

  private sessionToken(state: Stored, issuedAt: number): string {
    return `${issuedAt}.${this.sign(String(issuedAt), state)}`;
  }

  private sign(issued: string, state = this.state): string {
    return createHmac('sha256', state.secret).update(`session.${issued}`).digest('base64url');
  }

  // Checks a password against one generation of the stored state. Checks in
  // progress count towards the limit, so simultaneous guesses cannot exceed it.
  private async attempt(state: Stored, password: string): Promise<boolean> {
    const now = this.now();
    this.failures = this.failures.filter((at) => now - at < 60_000);
    if (this.failures.length + this.checking >= MAX_FAILURES_PER_MINUTE) throw new Error('Too many wrong passwords. Try again in a minute.');
    this.checking++;
    try {
      const ok = state.password !== null && password.length <= MAX_PASSWORD_LENGTH && await verifyPassword(password, state.password);
      if (!ok) this.failures.push(this.now());
      return ok;
    } finally {
      this.checking--;
    }
  }

  private read(): Stored | null {
    let contents: string;
    try {
      contents = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    return stored.parse(JSON.parse(contents));
  }

  private write(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}

export function validatePassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`Use at least ${MIN_PASSWORD_LENGTH} characters`);
  if (password.length > MAX_PASSWORD_LENGTH) throw new Error(`Use at most ${MAX_PASSWORD_LENGTH} characters`);
}

// scrypt$N$r$p$salt$hash, with base64url salt and hash.
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = encoded.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const derived = await derive(password, Buffer.from(salt, 'base64url'), Number(n), Number(r), Number(p));
  const expected = Buffer.from(hash, 'base64url');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

function derive(password: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password.normalize('NFKC'), salt, SCRYPT.keylen, { N, r, p, maxmem: SCRYPT.maxmem }, (error, key) => error ? reject(error) : resolve(key)));
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function readCookie(header: string | undefined, name: string): string | null {
  for (const part of header?.split(';') ?? []) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

export interface ConnectionEnds {
  clientAddress: string;
  clientPort: number;
  serverAddress: string;
  serverPort: number;
}

// Any address on this machine's loopback interface, including other 127/8
// addresses and IPv4-mapped forms, which a local client can choose freely.
export function isLoopback(address: string | undefined): boolean {
  const plain = normalizeAddress(address ?? '');
  return plain === '::1' || /^127\./.test(plain);
}

// The uid that owns the client end of a local TCP connection: the row in
// /proc/net/tcp or tcp6 whose local end is the client's and whose remote end
// is the server's. tcp6 lists IPv6 sockets, including IPv4-mapped clients.
export function loopbackPeerUid(procNetTables: string[], ends: ConnectionEnds): number | null {
  const client = normalizeAddress(ends.clientAddress);
  const server = normalizeAddress(ends.serverAddress);
  for (const table of procNetTables) {
    for (const line of table.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 8) continue;
      const local = procEndpoint(fields[1]!);
      const remote = procEndpoint(fields[2]!);
      if (local && remote && local.port === ends.clientPort && remote.port === ends.serverPort && local.address === client && remote.address === server) {
        return Number(fields[7]);
      }
    }
  }
  return null;
}

// Any address assigned to this machine. A connection from one comes from a
// local process, whichever listener it reaches.
export function isMachineAddress(address: string | undefined): boolean {
  const plain = normalizeAddress(address ?? '');
  return Object.values(os.networkInterfaces()).flat().some((entry) => entry && normalizeAddress(entry.address) === plain);
}

// One spelling per address: IPv4-mapped addresses as IPv4, and IPv6 in full
// lowercase groups without leading zeros, as /proc is parsed.
function normalizeAddress(address: string): string {
  const plain = address.toLowerCase().replace(/%.*$/, '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  if (!plain.includes(':')) return plain;
  const [head, tail = ''] = plain.split('::');
  const left = head ? head.split(':') : [];
  const right = plain.includes('::') && tail ? tail.split(':') : [];
  const groups = plain.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  const full = groups.map((group) => parseInt(group || '0', 16).toString(16)).join(':');
  return full === '0:0:0:0:0:0:0:1' ? '::1' : full;
}

// /proc writes each 32-bit word of an address in host (little-endian) order.
function procEndpoint(value: string): { address: string; port: number } | null {
  const [hex, port] = value.split(':');
  if (!hex || !port) return null;
  const words = hex.match(/.{8}/g) ?? [];
  const bytes = words.flatMap((word) => (word.match(/../g) ?? []).reverse().map((byte) => parseInt(byte, 16)));
  let address: string;
  if (bytes.length === 4) address = bytes.join('.');
  else if (bytes.length === 16) {
    const mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
    if (mapped) address = bytes.slice(12).join('.');
    else {
      const groups = Array.from({ length: 8 }, (_, index) => ((bytes[index * 2]! << 8) | bytes[index * 2 + 1]!).toString(16));
      address = groups.join(':') === '0:0:0:0:0:0:0:1' ? '::1' : groups.join(':');
    }
  } else return null;
  return { address, port: parseInt(port, 16) };
}
