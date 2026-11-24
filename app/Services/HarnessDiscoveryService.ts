import { execFile } from 'node:child_process';
import type { HarnessId, HarnessProvider, HarnessStatus } from '../Harness/HarnessProvider';
import { findExecutable, resolveCommand } from '../Platform/Executable';

export interface DiscoveredHarness {
  harness: HarnessId;
  executablePath: string | null;
  version: string | null;
  status: HarnessStatus;
}

export interface HarnessDiscoveryOptions {
  // Defaults to process.env. Injected in tests to point PATH at a fixture dir.
  env?: NodeJS.ProcessEnv;
  // Milliseconds to wait for a `--version` probe before treating it as broken.
  versionTimeoutMs?: number;
}

// Discovers which harness CLIs are installed by scanning PATH and probing each
// binary's version. Pure read; persistence is the caller's job.
export class HarnessDiscoveryService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly versionTimeoutMs: number;

  constructor(
    private readonly providers: HarnessProvider[],
    options: HarnessDiscoveryOptions = {}
  ) {
    this.env = options.env ?? process.env;
    this.versionTimeoutMs = options.versionTimeoutMs ?? 4000;
  }

  async discover(): Promise<DiscoveredHarness[]> {
    return Promise.all(this.providers.map((provider) => this.discoverOne(provider)));
  }

  private async discoverOne(provider: HarnessProvider): Promise<DiscoveredHarness> {
    const executablePath = this.resolveOnPath(provider.executableCandidates);
    if (!executablePath) {
      return { harness: provider.id, executablePath: null, version: null, status: 'missing' };
    }

    if (!provider.versionArgs) {
      return { harness: provider.id, executablePath, version: null, status: 'available' };
    }

    const probe = await this.probeVersion(executablePath, provider.versionArgs);
    if (!probe.ok) {
      // Found on PATH but it would not run/respond — record it as broken.
      return { harness: provider.id, executablePath, version: null, status: 'broken' };
    }

    return {
      harness: provider.id,
      executablePath,
      version: provider.parseVersion(probe.output),
      status: 'available'
    };
  }

  private resolveOnPath(candidates: string[]): string | null {
    for (const candidate of candidates) {
      const found = findExecutable(candidate, this.env);
      if (found) return found;
    }
    return null;
  }

  private probeVersion(executablePath: string, args: string[]): Promise<{ ok: boolean; output: string }> {
    const command = resolveCommand(executablePath, args, this.env);
    return new Promise((resolve) => {
      execFile(
        command.command,
        command.args,
        { timeout: this.versionTimeoutMs, env: this.env, windowsHide: true, windowsVerbatimArguments: command.verbatim },
        (error, stdout, stderr) => {
          const output = `${stdout ?? ''}${stderr ?? ''}`;
          // Some CLIs exit non-zero yet still print a usable version banner, so
          // accept any run that produced output.
          resolve({ ok: !error || output.trim().length > 0, output });
        }
      );
    });
  }
}
