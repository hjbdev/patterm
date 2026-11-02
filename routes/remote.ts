import type { PattermApplication } from '../app/App';
import { controlledProcess, RELAY_CHANNELS, type RouteHandler } from '../app/Services/RemoteClientService';
import { observedRoutes, registerApplicationRoutes, type RouteRegistrar } from './application';

// Wraps a registrar so that a request naming a paired host's record, such
// as `workstation:process_7`, runs on that host instead of here.
//
// The host that runs a process decides who controls it. The desktop window
// is its machine's only viewer, so with `takesControl` it takes control of a
// process before acting on it, as typing in it would, whichever host runs it.
export function relayingRegistrar(inner: RouteRegistrar, application: PattermApplication, options: { takesControl?: boolean } = {}): RouteRegistrar {
  // Paired hosts' processes this window controls, so typing asks for control
  // only once.
  const held = new Set<string>();
  if (options.takesControl) {
    application.remote.onControlLost((processId) => held.delete(processId));
    // The other host forgets this host's control when their link closes.
    application.peers.onDisconnected(() => held.clear());
  }
  const relay = async (channel: string, raw: unknown) => {
    const host = application.remote.target(raw)!;
    if (!options.takesControl) return application.remote.relay(host, channel, raw);
    const controlled = controlledProcess(channel, raw);
    if (controlled && !held.has(controlled)) {
      await application.remote.relay(host, 'patterm:terminal:take-control', { process_id: controlled });
      held.add(controlled);
    }
    const result = await application.remote.relay(host, channel, raw);
    // Closing a terminal gives up control of it there, and opening one that
    // another viewer took meanwhile does not get it back.
    if (channel === 'patterm:terminal:subscribe') {
      const args = (raw ?? {}) as { process_id?: unknown; subscribed?: unknown };
      const controlling = (result as { controlling?: unknown } | null)?.controlling;
      if (typeof args.process_id === 'string' && (args.subscribed === false || controlling === false)) held.delete(args.process_id);
    }
    return result;
  };
  const local = (channel: string, handler: (event: unknown, raw?: unknown) => unknown) => options.takesControl
    ? (event: unknown, raw?: unknown) => {
      application.remote.desktopRequest(channel, raw);
      return handler(event, raw);
    }
    : handler;
  const wrap = (channel: string, handler: (event: unknown, raw?: unknown) => unknown) => {
    if (!RELAY_CHANNELS.has(channel)) return handler;
    const here = local(channel, handler);
    return (event: unknown, raw?: unknown) => application.remote.target(raw) ? relay(channel, raw) : here(event, raw);
  };
  return {
    handle: (channel, handler) => inner.handle(channel, wrap(channel, handler)),
    on: (channel, handler) => inner.on(channel, wrap(channel, handler))
  };
}

// Lets paired hosts' UIs run this host's routes for this host's records.
export function servePeerRoutes(application: PattermApplication): void {
  const routes = new Map<string, RouteHandler>();
  const register = (channel: string, handler: (event: unknown, raw?: unknown) => unknown) => {
    routes.set(channel, (raw) => handler(undefined, raw));
  };
  registerApplicationRoutes(observedRoutes<RouteRegistrar>({ handle: register, on: register }, application.telemetry), application);
  application.remote.serve(routes);
}

// An Integrated agent's transcript, read from whichever host runs it.
export function readIntegrated(application: PattermApplication, processId: string): Promise<unknown> {
  const host = application.remote.target({ process_id: processId });
  const args = { tool: 'integrated_get', arguments: { process_id: processId } };
  return host ? application.remote.relay(host, 'patterm:mcp:call', args) : application.mcp.call(args.tool, args.arguments);
}

// An Integrated control call, run on whichever host runs the agent.
export function callIntegrated(application: PattermApplication, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const host = application.remote.target(args);
  return host ? application.remote.relay(host, 'patterm:mcp:call', { tool, arguments: args }) : application.mcp.call(tool, args);
}
