import WebSocket from 'ws';

export interface CdpEvent { method: string; params: Record<string, unknown>; sessionId?: string }

// A minimal Chrome DevTools Protocol client for Patterm's own use of a
// managed browser: the screencast and the user's input. It never enables the
// Runtime domain, whose events pages can detect.
export class CdpConnection {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Set<(event: CdpEvent) => void>();
  private closed = false;

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => {
      let message: { id?: number; result?: Record<string, unknown>; error?: { message?: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
      try { message = JSON.parse(data.toString()) as typeof message; } catch { return; }
      if (typeof message.id === 'number') {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(message.error.message ?? 'CDP request failed'));
        else waiter?.resolve(message.result ?? {});
      } else if (message.method) {
        const event: CdpEvent = { method: message.method, params: message.params ?? {}, ...(message.sessionId ? { sessionId: message.sessionId } : {}) };
        for (const listener of this.listeners) listener(event);
      }
    });
    socket.on('close', () => this.fail(new Error('The browser connection closed')));
    socket.on('error', () => socket.terminate());
  }

  static connect(url: string, timeoutMs = 10_000): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      // Screencast frames can exceed ws's default limit on large viewports.
      const socket = new WebSocket(url, { maxPayload: 64 * 1024 * 1024, perMessageDeflate: false });
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('Timed out connecting to the browser')); }, timeoutMs);
      socket.once('open', () => { clearTimeout(timer); resolve(new CdpConnection(socket)); });
      socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  // A browser busy with a hung page may never answer, and the user's input
  // waits on these calls, so each gives up after `timeoutMs`.
  send<T extends Record<string, unknown> = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 10_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The browser connection closed'));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The browser did not answer ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value as T); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.socket.close();
    this.fail(new Error('The browser connection closed'));
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}
