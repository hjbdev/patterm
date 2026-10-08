import os from 'node:os';
import type { RemoteAccess, RemoteAccessMode } from './ServerAccess';
import type { TailscaleService } from '../Services/TailscaleService';

// What the server does at startup for its Remote access setting.
export interface RemoteAccessPlan {
  mode: RemoteAccessMode;
  // The browser origin the server answers as, besides its loopback addresses.
  origin: string;
  // Addresses to listen on besides 127.0.0.1.
  listen: string[];
  ownerLogin: string | null;
  // Patterm's Tailscale Serve route to add or remove once the server holds
  // its runtime lock.
  route: { action: 'ensure' | 'remove'; hostname: string } | null;
  // Problems that made the server fall back to this machine only, or that
  // left its Tailscale route unchanged.
  warnings: string[];
}

interface PlanInput {
  access: RemoteAccess | null;
  passwordSet: boolean;
  port: number;
  // PATTERM_PUBLIC_ORIGIN and PATTERM_OWNER_LOGIN, which servers set up before
  // the setting existed still use.
  envOrigin?: string | undefined;
  envOwnerLogin?: string | undefined;
  tailscale: Pick<TailscaleService, 'state'>;
  addresses?: () => string[];
}

// Works out what the setting needs without changing anything. Anything that
// cannot be applied falls back to this machine only, with a warning, so the
// server still starts.
export async function planRemoteAccess(input: PlanInput): Promise<RemoteAccessPlan> {
  const local = localOrigin(input);
  const legacyTailnet = input.envOrigin && new URL(input.envOrigin).hostname.endsWith('.ts.net') ? input.envOrigin : null;
  const mode: RemoteAccessMode = input.access?.mode ?? (legacyTailnet ? 'tailscale' : 'local');
  const hostname = await input.tailscale.state().then((state) => state.hostname, (error: unknown) => error instanceof Error ? error : new Error(String(error)));
  const fallback = (warning: string): RemoteAccessPlan => ({ mode: 'local', origin: local, listen: [], ownerLogin: null, route: removal(), warnings: [warning] });
  // Only a server whose setting was chosen here manages its route. One set up
  // before the setting keeps its own Serve configuration.
  const removal = () => input.access && typeof hostname === 'string' ? { action: 'remove' as const, hostname } : null;

  // A server set up before the setting keeps its origin exactly, port and all.
  if (mode === 'tailscale' && !input.access) {
    return { mode, origin: legacyTailnet!, listen: [], ownerLogin: input.envOwnerLogin?.trim() || null, route: null, warnings: [] };
  }
  if (mode === 'tailscale') {
    const name = typeof hostname === 'string' ? hostname : null;
    if (!name) return fallback(`Tailscale access is off: ${(hostname as Error).message}`);
    return { mode, origin: `https://${name}`, listen: [], ownerLogin: input.access!.owner_login, route: { action: 'ensure', hostname: name }, warnings: [] };
  }

  if (mode === 'network') {
    const bind = input.access?.bind ?? '';
    if (!input.passwordSet) return fallback('Network access is off because no password is set.');
    if (!(input.addresses ?? machineAddresses)().includes(bind)) return fallback(`Network access is off because this machine no longer has the address ${bind}.`);
    return { mode, origin: `http://${bind.includes(':') ? `[${bind}]` : bind}:${input.port}`, listen: [bind], ownerLogin: null, route: removal(), warnings: [] };
  }

  return { mode, origin: local, listen: [], ownerLogin: null, route: removal(), warnings: [] };
}

// Adds or removes Patterm's Serve route. A failure becomes a warning; the
// server keeps running and Settings › Remote access shows it.
export async function applyTailscaleRoute(plan: RemoteAccessPlan, port: number, tailscale: Pick<TailscaleService, 'ensureRoute' | 'removeRoute'>): Promise<void> {
  if (!plan.route) return;
  try {
    if (plan.route.action === 'ensure') await tailscale.ensureRoute(plan.route.hostname, port);
    else await tailscale.removeRoute(plan.route.hostname, port);
  } catch (error) {
    plan.warnings.push(`Tailscale Serve was not changed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// A loopback origin set in PATTERM_PUBLIC_ORIGIN, such as http://127.0.0.1:8787,
// is kept; otherwise localhost.
function localOrigin(input: PlanInput): string {
  if (input.envOrigin && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(input.envOrigin).hostname)) return input.envOrigin;
  return `http://localhost:${input.port}`;
}

// Addresses another machine could reach this one on, for network mode.
export function machineAddresses(): string[] {
  return Object.values(os.networkInterfaces()).flat()
    .filter((entry): entry is os.NetworkInterfaceInfo => Boolean(entry) && !entry!.internal && !(entry!.family === 'IPv6' && entry!.address.startsWith('fe80')))
    .map((entry) => entry.address);
}
