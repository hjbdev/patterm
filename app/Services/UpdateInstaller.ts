import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ReleaseInstall, UpdateApplier } from './UpdateService';

export interface UpdatePlanInput {
  install: ReleaseInstall;
  mode: 'desktop' | 'server';
  version: string;
  sha256: string;
  pid: number;
  logPath: string;
  env: NodeJS.ProcessEnv;
  unit: string;
}

export interface UpdatePlan {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  // Detached helpers outlive this process and run once it quits; the server's
  // installer runs in its own systemd unit and stops the service itself.
  detached: boolean;
  log: string;
  // Files the plan runs, which a release package must contain.
  scripts: string[];
  // The transient systemd unit a server's installer runs in.
  unit?: string;
}

// Server variables the Linux installer reads, passed to its transient unit.
const SERVER_INSTALLER_ENV = ['PATTERM_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'PATTERM_PORT', 'PATTERM_RELEASE_URL'];

// How each release install runs its own installer for a verified version.
// The desktop installers refuse to replace a running app, so a helper waits
// for Patterm to quit, installs, and opens Patterm again.
export function updatePlan(input: UpdatePlanInput): UpdatePlan | { unavailable: string } {
  const { install, version, sha256 } = input;
  const root = install.root;
  const scripts = path.join(root, 'scripts');
  if (input.mode === 'server') {
    if (install.platform !== 'linux') return { unavailable: 'Update this server with its installer.' };
    // systemd sets INVOCATION_ID for its units; the installer restarts patterm.service.
    if (!input.env.INVOCATION_ID) return { unavailable: 'This server is not running as the patterm service. Update it with install.sh --update.' };
    const home = versionsHome(root);
    if (!home) return { unavailable: 'This server was not installed by the release installer.' };
    const installer = path.join(scripts, 'install-release.sh');
    const env = { ...Object.fromEntries(SERVER_INSTALLER_ENV.flatMap((name) => input.env[name] ? [[name, input.env[name]]] : [])), PATTERM_HOME: home };
    return {
      // Outside the service's control group, which the installer stops. The
      // unit outlives a failure, so its result can be read, and is unloaded
      // once it succeeds.
      command: 'systemd-run',
      args: ['--user', '--quiet', `--unit=${input.unit}`, ...Object.entries(env).map(([name, value]) => `--setenv=${name}=${value}`), installer, '--version', version, '--update'],
      env: input.env,
      detached: false,
      log: `journalctl --user -u ${input.unit}`,
      scripts: [installer],
      unit: input.unit
    };
  }
  const pid = String(input.pid);
  if (install.platform === 'linux') {
    const home = versionsHome(root);
    if (!home) return { unavailable: 'This copy of Patterm was not installed by the release installer.' };
    const helper = path.join(scripts, 'apply-update.sh');
    const installer = path.join(scripts, 'install-release.sh');
    return {
      command: helper,
      // install.sh checks the release against the signed manifest itself.
      args: [pid, input.logPath, path.join(home, 'current', 'scripts', 'patterm.sh'), '--', installer, '--version', version],
      env: { ...input.env, PATTERM_HOME: home },
      detached: true,
      log: input.logPath,
      scripts: [helper, installer]
    };
  }
  if (install.platform === 'macos') {
    const bundle = path.resolve(root, '../../..');
    if (!bundle.endsWith('.app') || path.relative(bundle, root) !== path.join('Contents', 'Resources', 'app')) return { unavailable: 'This copy of Patterm is not an app bundle.' };
    const applications = path.dirname(bundle);
    const helper = path.join(scripts, 'apply-update.sh');
    const installer = path.join(scripts, 'install-macos.sh');
    return {
      command: '/bin/bash',
      args: [helper, pid, input.logPath, path.join(applications, 'Patterm.app'), '--', '/bin/bash', installer, '--version', version, '--sha256', sha256],
      // Install where this copy is, rather than the installer's default.
      env: { ...input.env, PATTERM_MAC_APPLICATIONS_DIR: applications },
      detached: true,
      log: input.logPath,
      scripts: [helper, installer]
    };
  }
  const installRoot = versionsHome(root);
  if (!installRoot) return { unavailable: 'This copy of Patterm was not installed by install.ps1.' };
  const helper = path.join(scripts, 'apply-update.ps1');
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', helper,
      '-WaitPid', pid, '-Log', input.logPath, '-InstallRoot', installRoot, '-Version', version, '-Sha256', sha256],
    env: input.env,
    detached: true,
    log: input.logPath,
    scripts: [helper, path.join(scripts, 'install.ps1')]
  };
}

// Release installers keep each version in <home>/versions/<version>.
function versionsHome(root: string): string | null {
  const parent = path.dirname(root);
  return path.basename(parent) === 'versions' ? path.dirname(parent) : null;
}

export interface UpdateInstallerOptions {
  install: ReleaseInstall;
  mode: 'desktop' | 'server';
  logPath: string;
  env?: NodeJS.ProcessEnv;
  pid?: number;
  spawn?: typeof nodeSpawn;
  now?: () => number;
  pollMs?: number;
}

interface CommandResult { code: number | null; stdout: string }

export class UpdateInstaller implements UpdateApplier {
  private readonly spawn: typeof nodeSpawn;

  constructor(private readonly options: UpdateInstallerOptions) {
    this.spawn = options.spawn ?? nodeSpawn;
  }

  unavailable(): string | null {
    const plan = this.plan({ version: '0.0.0', sha256: '' });
    if ('unavailable' in plan) return plan.unavailable;
    const missing = plan.scripts.find((file) => !fs.existsSync(file));
    return missing ? `This release package has no ${path.basename(missing)}; update it with its installer.` : null;
  }

  async apply(release: { version: string; sha256: string }): Promise<{ quit: boolean; log: string; done?: Promise<'finished' | 'lost'> }> {
    const plan = this.plan(release);
    if ('unavailable' in plan) throw new Error(plan.unavailable);
    if (plan.detached) {
      fs.mkdirSync(path.dirname(plan.log), { recursive: true });
      const child = this.spawn(plan.command, plan.args, { env: plan.env, detached: true, stdio: 'ignore', windowsHide: true });
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();
      return { quit: true, log: plan.log };
    }
    const started = await this.run(plan.command, plan.args, plan.env);
    if (started.code !== 0) throw new Error(`systemd-run exited with ${started.code ?? 'a signal'}`);
    return { quit: false, log: plan.log, done: this.watch(plan.unit!, plan.log) };
  }

  // Follows the installer's unit until it ends. The installer stops this
  // service when it succeeds, which also ends the watch: a check that
  // cannot run reports the installer as lost, never as failed.
  private async watch(unit: string, log: string): Promise<'finished' | 'lost'> {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? 2000));
      let result: CommandResult;
      try { result = await this.run('systemctl', ['--user', 'show', '--property=LoadState,ActiveState,Result', unit], this.options.env ?? process.env); }
      catch { return 'lost'; }
      if (result.code !== 0) return 'lost';
      const property = (name: string) => new RegExp(`^${name}=(.*)$`, 'm').exec(result.stdout)?.[1] ?? '';
      if (property('LoadState') === 'not-found') return 'finished';
      if (['active', 'activating', 'deactivating', 'reloading'].includes(property('ActiveState'))) continue;
      if (property('Result') === 'success') return 'finished';
      throw new Error(`the installer ended with ${property('Result') || property('ActiveState')}; see ${log}`);
    }
  }

  private run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = this.spawn(command, args, { env, stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '';
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stdout }));
    });
  }

  private plan(release: { version: string; sha256: string }): UpdatePlan | { unavailable: string } {
    return updatePlan({
      install: this.options.install,
      mode: this.options.mode,
      version: release.version,
      sha256: release.sha256,
      pid: this.options.pid ?? process.pid,
      logPath: this.options.logPath,
      env: this.options.env ?? process.env,
      unit: `patterm-update-${(this.options.now ?? Date.now)()}`
    });
  }
}
