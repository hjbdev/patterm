import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { ipcPath } from '../Platform/Ipc';
import type { IntegratedConversationEvent, IntegratedConversationListener } from '../Services/IntegratedConversation';
import {
  callIntegratedHost,
  hostConnectionError,
  integratedHostReady,
  stopHostProcess,
  stopRecordedHostProcess,
  type IntegratedHostLauncher
} from '../Services/IntegratedHostLauncher';

export const HOST_RECONNECT_BASE_MS = 250;
export const HOST_RECONNECT_MAX_MS = 5_000;
export const HOST_RECONNECT_ATTEMPTS = 8;
export const MAX_HOST_STREAM_BUFFER_BYTES = 32 * 1024 * 1024;

export interface WaitForHostSocketOptions {
  timeoutMs?: number;
  intervalMs?: number;
  exitedMessage?: string;
  timeoutMessage?: string;
}

// Polls until a newly spawned supervised host opens its control socket, failing
// early if the host process exits before becoming ready.
export async function waitForHostSocket(
  socketPath: string,
  pid: number | null,
  options: WaitForHostSocketOptions = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await integratedHostReady(socketPath)) return;
    if (pid) {
      try {
        process.kill(pid, 0);
      } catch {
        throw new Error(options.exitedMessage ?? 'Integrated host exited before starting');
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(options.timeoutMessage ?? 'Integrated host did not become ready');
}

export interface HostSubscribeOptions {
  processId: string;
  socketPath: string;
  label: string;
  reconnectErrorMessage: string;
  listener: IntegratedConversationListener;
  transformEvent?: (event: IntegratedConversationEvent) => IntegratedConversationEvent;
}

// Shared transport client for supervised NDJSON hosts (Claude, ACP) so socket
// RPC, streaming subscriptions with bounded exponential reconnect, and graceful
// teardown live in one place.
export class SupervisedHostClient {
  call<T = unknown>(socketPath: string, method: string, params: unknown): Promise<T> {
    return callIntegratedHost(socketPath, method, params) as Promise<T>;
  }

  async subscribe(options: HostSubscribeOptions): Promise<() => void> {
    const { processId, socketPath, label, reconnectErrorMessage, listener, transformEvent } = options;
    let socket: net.Socket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let attempts = 0;

    const scheduleReconnect = () => {
      if (stopped || retryTimer) return;
      attempts += 1;
      if (attempts > HOST_RECONNECT_ATTEMPTS) {
        listener({ processId, revision: 0, kind: 'error', id: 'connection_error', delta: reconnectErrorMessage });
        return;
      }
      listener({ processId, revision: 0, kind: 'reconnecting' });
      const delay = Math.min(HOST_RECONNECT_BASE_MS * 2 ** (attempts - 1), HOST_RECONNECT_MAX_MS);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (stopped) return;
        void connect(false).catch(() => scheduleReconnect());
      }, delay);
      retryTimer.unref?.();
    };

    const connect = (initial: boolean) => new Promise<void>((resolve, reject) => {
      const next = net.createConnection(ipcPath(socketPath));
      next.setEncoding('utf8');
      socket = next;
      const id = randomUUID();
      let buffer = '';
      let acknowledged = false;
      let rejected = false;
      const fail = (error: Error) => {
        if (rejected || acknowledged) return;
        rejected = true;
        reject(error);
      };

      next.on('connect', () => {
        next.write(`${JSON.stringify({ id, method: 'subscribe', params: {} })}\n`);
      });

      next.on('data', (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer, 'utf8') > MAX_HOST_STREAM_BUFFER_BYTES) {
          buffer = '';
          fail(new Error(`${label} event stream exceeded buffer limit`));
          next.destroy();
          return;
        }
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          if (!line) continue;
          let frame: { id?: string; error?: unknown; event?: Record<string, unknown> };
          try {
            frame = JSON.parse(line) as { id?: string; error?: unknown; event?: Record<string, unknown> };
          } catch {
            continue;
          }
          if (!acknowledged && frame.id === id) {
            if (frame.error !== undefined && frame.error !== null) {
              fail(new Error(String(frame.error)));
              next.destroy();
              return;
            }
            acknowledged = true;
            attempts = 0;
            resolve();
            continue;
          }
          if (stopped || !frame.event || typeof frame.event.kind !== 'string') continue;
          const revision = typeof frame.event.revision === 'number' && Number.isFinite(frame.event.revision)
            ? frame.event.revision
            : 0;
          const event: IntegratedConversationEvent = {
            ...(frame.event as unknown as IntegratedConversationEvent),
            processId,
            revision
          };
          listener(transformEvent ? transformEvent(event) : event);
        }
      });

      next.on('error', (error) => {
        fail(hostConnectionError(error, label));
      });

      next.once('close', () => {
        if (socket === next) socket = null;
        if (!acknowledged) {
          fail(new Error(`${label} closed the event stream`));
          // Initial connect failure propagates to the caller; a failed retry
          // keeps the bounded reconnect loop running until HOST_RECONNECT_ATTEMPTS.
          if (!initial) scheduleReconnect();
          return;
        }
        scheduleReconnect();
      });
    });

    const destroySocket = () => {
      if (socket) {
        socket.destroy();
        socket = null;
      }
    };

    try {
      await connect(true);
    } catch (error) {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      destroySocket();
      throw error;
    }

    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      destroySocket();
    };
  }

  async stop(
    socketPath: string,
    pid: number | null,
    launcher: IntegratedHostLauncher,
    options: { interruptFirst?: boolean } = {}
  ): Promise<void> {
    if (options.interruptFirst) {
      try {
        await callIntegratedHost(socketPath, 'interrupt', {});
      } catch {
        // Stopping still proceeds if the host is already idle or gone.
      }
    }
    try {
      await callIntegratedHost(socketPath, 'stop', {});
    } catch {
      if (launcher.stop) await launcher.stop(socketPath, pid);
      else await stopRecordedHostProcess(pid, socketPath);
    }
  }

  async cleanupLaunch(
    socketPath: string | undefined,
    pid: number | null,
    launcher: IntegratedHostLauncher
  ): Promise<void> {
    if (launcher.stop && socketPath) await launcher.stop(socketPath, pid);
    else await stopHostProcess(pid);
  }

  async stopAll(
    harness: string,
    processIds: readonly string[],
    stopOne: (processId: string) => Promise<void>,
    launcher: IntegratedHostLauncher,
    errorMessage: string
  ): Promise<void> {
    const errors: unknown[] = [];
    const results = await Promise.allSettled(processIds.map((processId) => stopOne(processId)));
    for (const result of results) {
      if (result.status === 'rejected') errors.push(result.reason);
    }
    try {
      await launcher.stopAll(harness);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, errorMessage);
  }
}
