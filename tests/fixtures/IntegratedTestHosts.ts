import { spawn, type ChildProcess } from 'node:child_process';
import { withEnv } from '../../app/Platform/Environment';
import { stopHostProcess, type IntegratedHostLauncher } from '../../app/Services/IntegratedHostLauncher';

// Own real host processes through their exit events, rather than treating a
// stop reply or a closed pipe as proof that Windows has released their cwd.
export class IntegratedTestHosts implements IntegratedHostLauncher {
  private readonly hosts = new Map<ChildProcess, Promise<void>>();

  async launch(input: Parameters<IntegratedHostLauncher['launch']>[0]): Promise<number | null> {
    const child = spawn(input.nodePath, [input.script, input.configPath], {
      cwd: input.cwd,
      env: withEnv(input.env, { ELECTRON_RUN_AS_NODE: '1' }),
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    this.hosts.set(child, new Promise<void>((resolve) => child.once('close', resolve)));
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    return child.pid ?? null;
  }

  async waitForExit(pid: number): Promise<void> {
    const host = [...this.hosts].find(([child]) => child.pid === pid);
    if (!host) throw new Error(`Unknown test host: ${pid}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        host[1],
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Test host ${pid} did not exit`)), 5_000);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.hosts].map(async ([child, closed]) => {
      if (child.exitCode === null && child.signalCode === null) {
        await stopHostProcess(child.pid ?? null);
      }
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      try { await closed; } finally { clearTimeout(timer); }
    }));
    this.hosts.clear();
  }
}
