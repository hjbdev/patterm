// A remote machine an agent's tools run on while the agent itself runs here.
// Backends provide only lifecycle, command execution and a TCP tunnel; Patterm
// keeps the harness, its login and its records on this machine.

export interface SandboxExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  // Written to the command's stdin, which is then closed.
  stdin?: string | Buffer;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SandboxExecResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

export interface SandboxServiceSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  dir?: string;
}

export interface SandboxTunnel {
  // A loopback port on this machine that reaches the sandbox's port.
  readonly port: number;
  close(): Promise<void>;
}

export interface SandboxBackend {
  readonly id: string;
  // Confirms the credentials work, without creating anything.
  verify(): Promise<void>;
  create(name: string): Promise<void>;
  destroy(name: string): Promise<void>;
  // Null when the backend no longer has the sandbox.
  status(name: string): Promise<string | null>;
  exec(name: string, argv: string[], options?: SandboxExecOptions): Promise<SandboxExecResult>;
  // A long-running process the backend restarts after crashes and wakes.
  ensureService(name: string, service: string, spec: SandboxServiceSpec): Promise<void>;
  // Keeps the sandbox from pausing until the hold expires or is released.
  hold(name: string, key: string, seconds: number): Promise<void>;
  release(name: string, key: string): Promise<void>;
  tunnel(name: string, remotePort: number, localPort?: number): Promise<SandboxTunnel>;
}

export class SandboxExecTimeout extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Sandbox command timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'SandboxExecTimeout';
  }
}
