import { execFile } from 'node:child_process';

// Runs the tailscale CLI. Tests pass a fake, so they never change real routes.
export type TailscaleRunner = (args: string[]) => Promise<string>;

export interface TailscaleState {
  hostname: string;
  // The login of the user this machine belongs to; null on tagged machines.
  ownerLogin: string | null;
}

const defaultRunner: TailscaleRunner = (args) => new Promise((resolve, reject) => {
  execFile('tailscale', args, { timeout: 15_000, encoding: 'utf8' }, (error, stdout, stderr) => {
    if (error) reject(new Error(`tailscale ${args.join(' ')} failed: ${(stderr || error.message).trim()}`));
    else resolve(stdout);
  });
});

// Patterm's own route in Tailscale Serve: HTTPS port 443, path /, proxied to
// the loopback listener. Other paths and ports, which other apps may use, are
// left alone.
export class TailscaleService {
  constructor(private readonly run: TailscaleRunner = defaultRunner) {}

  async state(): Promise<TailscaleState> {
    const status = JSON.parse(await this.run(['status', '--json'])) as {
      BackendState?: string;
      Self?: { DNSName?: string; UserID?: number };
      User?: Record<string, { LoginName?: string }>;
    };
    if (status.BackendState !== 'Running' || !status.Self?.DNSName) throw new Error('Tailscale is not connected. Run tailscale up first.');
    const hostname = status.Self.DNSName.replace(/\.$/, '');
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net$/.test(hostname)) throw new Error('Tailscale did not return a ts.net hostname.');
    const login = status.User?.[String(status.Self.UserID)]?.LoginName;
    return { hostname, ownerLogin: typeof login === 'string' && login && !login.startsWith('tagged-devices') ? login : null };
  }

  // Adds Patterm's route, or does nothing if it is already there. Refuses if
  // Funnel is on for the hostname or another app already serves its root.
  async ensureRoute(hostname: string, port: number): Promise<'added' | 'present'> {
    const route = this.route(await this.config(), hostname);
    if (route.funnel) throw new Error('Tailscale Funnel is on for this machine. Turn it off before serving Patterm.');
    const target = `http://127.0.0.1:${port}`;
    if (route.proxy === target) return 'present';
    if (route.proxy !== null || route.otherHandler) throw new Error(`Tailscale already serves something else at https://${hostname}/. Patterm will not replace it; check tailscale serve status.`);
    await this.run(['serve', '--bg', '--https=443', '--set-path=/', target]);
    return 'added';
  }

  // Removes Patterm's route if it is there and points at this server.
  async removeRoute(hostname: string, port: number): Promise<boolean> {
    if (this.route(await this.config(), hostname).proxy !== `http://127.0.0.1:${port}`) return false;
    await this.run(['serve', '--https=443', '--set-path=/', 'off']);
    return true;
  }

  private async config(): Promise<ServeConfig> {
    const output = (await this.run(['serve', 'status', '--json'])).trim();
    return output ? JSON.parse(output) as ServeConfig : {};
  }

  private route(config: ServeConfig, hostname: string): { proxy: string | null; otherHandler: boolean; funnel: boolean } {
    const endpoint = `${hostname}:443`;
    const handler = config.Web?.[endpoint]?.Handlers?.['/'];
    const proxy = typeof handler?.Proxy === 'string' ? handler.Proxy : null;
    const listener = config.TCP?.['443'];
    return {
      proxy,
      // A static path or text handler at the root, or a plain TCP forward on
      // port 443, belongs to someone else.
      otherHandler: (Boolean(handler) && proxy === null) || Boolean(listener && listener.HTTPS !== true),
      funnel: Boolean(config.AllowFunnel?.[endpoint])
    };
  }
}

interface ServeConfig {
  TCP?: Record<string, { HTTPS?: boolean }>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }>;
  AllowFunnel?: Record<string, boolean>;
}
