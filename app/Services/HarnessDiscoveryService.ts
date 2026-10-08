import { execFile } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import type { HarnessId, HarnessProvider, HarnessStatus } from '../Harness/HarnessProvider';

export interface DiscoveredHarness {
  harness: HarnessId;
  executablePath: string | null;
  version: string | null;
  status: HarnessStatus;
}

export interface HarnessDiscoveryOptions {
  // Defaults to process.env. Injected in tests to point PATH at a fixture dir.
  env?: NodeJS.ProcessEnv;
  // Shell the RawPty provider reports as available. Defaults to $SHELL or /bin/sh.
  shell?: string;
  // Milliseconds to wait for a `--version` probe before treating it as broken.
  versionTimeoutMs?: number;
}

// Discovers which harness CLIs are installed by scanning PATH and probing each
// binary's version. Pure read; persistence is the caller's job.
export class HarnessDiscoveryService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly shell: string;
  private readonly versionTimeoutMs: number;

  constructor(
    private readonly providers: HarnessProvider[],
    options: HarnessDiscoveryOptions = {}
  ) {
    this.env = options.env ?? process.env;
    this.shell = options.shell ?? this.env.SHELL ?? '/bin/sh';
    this.versionTimeoutMs = options.versionTimeoutMs ?? 4000;
  }

  async discover(): Promise<DiscoveredHarness[]> {
    return Promise.all(this.providers.map((provider) => this.discoverOne(provider)));
  }

  private async discoverOne(provider: HarnessProvider): Promise<DiscoveredHarness> {
    // No binary to find: the raw terminal rides the user's shell, always present.
    if (provider.executableCandidates.length === 0) {
      return { harness: provider.id, executablePath: this.shell, version: null, status: 'available' };
    }

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
    const rawPath = this.env.PATH ?? this.env.Path ?? '';
    const dirs = rawPath.split(path.delimiter).filter(Boolean);
    const extensions = process.platform === 'win32' ? this.windowsExtensions() : [''];

    for (const candidate of candidates) {
      for (const dir of dirs) {
        for (const ext of extensions) {
          const full = path.join(dir, candidate + ext);
          if (isExecutableFile(full)) {
            return full;
          }
        }
      }
    }
    return null;
  }

  private windowsExtensions(): string[] {
    const pathext = this.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
    return ['', ...pathext.split(';').filter(Boolean).map((ext) => ext.toLowerCase())];
  }

  private probeVersion(executablePath: string, args: string[]): Promise<{ ok: boolean; output: string }> {
    return new Promise((resolve) => {
      execFile(
        executablePath,
        args,
        { timeout: this.versionTimeoutMs, env: this.env, windowsHide: true },
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

function isExecutableFile(candidate: string): boolean {
  try {
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
