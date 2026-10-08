import { EventEmitter } from 'node:events';

// Requests a terminal program makes of the person viewing it: OSC 52 copies and
// URLs passed to the xdg-open shim. They go to the client controlling the PTY,
// never to every connected client.
export type TerminalClientRequest =
  | { kind: 'clipboard'; processId: string; text: string }
  | { kind: 'open-url'; processId: string; url: string };

export class TerminalClientRequestService {
  private readonly events = new EventEmitter();

  emit(request: TerminalClientRequest): void {
    this.events.emit('request', request);
  }

  on(listener: (request: TerminalClientRequest) => void): () => void {
    this.events.on('request', listener);
    return () => this.events.off('request', listener);
  }
}
