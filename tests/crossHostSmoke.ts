import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createApplication, type PattermApplication } from '../app/App';
import { WebServer } from '../app/Http/WebServer';
import { WebSocket } from 'ws';
import { registerApplicationRoutes } from '../routes/application';
import { readIntegrated, relayingRegistrar, servePeerRoutes } from '../routes/remote';
import { parseDamageFrame } from '../resources/js/terminal/TerminalRenderer';
import type { VersionedWorkbench } from '../app/Services/WorkbenchSyncService';
import { debugSidecarPath } from './fixtures/Sidecar';
import { removeTree } from './fixtures/TempTree';

// Two complete Patterm hosts on loopback: a dev box server and a desktop
// that pairs to it. Agents are raw terminals, so messages appear as typed
// input in their terminal output.

async function until<T>(check: () => T | Promise<T>, label: string, timeoutMs = 20_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface Host {
  app: PattermApplication;
  server: WebServer | null;
  port: number;
  dir: string;
  origin: string;
}

async function main(): Promise<void> {
  // The agents here are raw shells and the test types PowerShell on Windows. A
  // $SHELL inherited from Git Bash would otherwise pick bash for them.
  if (process.platform === 'win32') delete process.env.SHELL;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ptx-'));
  const hosts: Host[] = [];
  const start = async (name: string): Promise<Host> => {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, 'project'), { recursive: true });
    const app = await createApplication({
      appDataPath: path.join(dir, 'data'),
      sidecarPath: debugSidecarPath(),
      mcpShimPath: path.resolve('dist/mcp/patterm-mcp.js'),
      runtime: 'node',
      publicOrigin: origin
    });
    const host: Host = { app, server: null, port, dir, origin };
    hosts.push(host);
    await serve(host);
    await app.mcp.call('hosts_rename', { name });
    await app.mcp.call('harness_discover', {});
    servePeerRoutes(app);
    return host;
  };
  // Stops a host completely and starts it again on the same data and port.
  const restart = async (host: Host) => {
    await host.server?.stop();
    await host.app.dispose();
    host.app = await createApplication({
      appDataPath: path.join(host.dir, 'data'),
      sidecarPath: debugSidecarPath(),
      mcpShimPath: path.resolve('dist/mcp/patterm-mcp.js'),
      runtime: 'node',
      publicOrigin: host.origin
    });
    await host.app.mcp.call('harness_discover', {});
    servePeerRoutes(host.app);
    await serve(host);
  };
  const serve = async (host: Host) => {
    host.server = new WebServer(host.app, { port: host.port, publicOrigin: host.origin, rendererPath: path.join(host.dir, 'renderer'), appDataPath: path.join(host.dir, 'data') });
    await host.server.start();
  };
  // An agent: a raw terminal with its own MCP identity.
  const agent = async (host: Host, projectId: string) => {
    const launched = await host.app.mcp.call('harness_launch', { project_id: projectId, harness: 'rawpty', interface_mode: 'tui' }) as { process_id: string };
    // UI routes announce changes after each call; these direct calls do too.
    host.app.notifyChanged(host.app.mcp.changedTopics('harness_launch'));
    const { mcp_identity } = host.app.database.connection.prepare('select mcp_identity from sessions where process_id = ?').get(launched.process_id) as { mcp_identity: string };
    const call = (tool: string, args: unknown) => host.app.mcp.callPublic(tool, args, { identity: mcp_identity });
    // A long prompt wraps the text typed after it, so rejoin wrapped lines.
    const output = async () => ((await host.app.mcp.call('get_process_output', { process_id: launched.process_id }) as { content?: string }).content ?? '').replace(/\r?\n/g, '');
    return { process_id: launched.process_id, call, output };
  };
  // A browser connected to a host's event socket.
  const browserClient = async (host: Host) => {
    const socket = new WebSocket(`ws://127.0.0.1:${host.port}/api/events`, { origin: host.origin });
    const frames: Array<ReturnType<typeof parseDamageFrame>> = [];
    const pushed: Array<{ event: string; payload: { kind?: string; text?: string; processId?: string; controlling?: boolean } }> = [];
    const replies = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
    socket.on('message', (data, binary) => {
      if (binary) { frames.push(parseDamageFrame(new Uint8Array(data as Buffer))); return; }
      const message = JSON.parse(data.toString()) as { id?: number; result?: unknown; error?: string; event?: string; payload?: never };
      if (message.event) pushed.push({ event: message.event, payload: message.payload ?? {} });
      const reply = message.id === undefined ? undefined : replies.get(message.id);
      if (!reply) return;
      replies.delete(message.id!);
      if (message.error) reply.reject(new Error(message.error)); else reply.resolve(message.result);
    });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    let nextId = 0;
    const call = (channel: string, args: unknown) => new Promise((resolve, reject) => {
      const id = ++nextId;
      replies.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, channel, args }));
    });
    return { frames, pushed, call, close: () => socket.close() };
  };
  const project = async (host: Host, name: string) => {
    const directory = path.join(host.dir, 'project', name);
    fs.mkdirSync(directory, { recursive: true });
    const created = await host.app.mcp.call('project_create', { name, path: directory }) as { project_id: string };
    host.app.notifyChanged(host.app.mcp.changedTopics('project_create'));
    return created.project_id;
  };

  try {
    const workstation = await start('workstation');
    const desktop = await start('desktop');
    const workstationId = (workstation.app.hosts.overview()).self.host_id;
    const desktopId = (desktop.app.hosts.overview()).self.host_id;

    // Pair and link.
    const { code } = await workstation.app.mcp.call('hosts_code_create', {}) as { code: string };
    await desktop.app.mcp.call('hosts_pair', { url: workstation.origin, code });
    await until(() => desktop.app.peers.connected(workstationId) && workstation.app.peers.connected(desktopId), 'the link');
    const devProject = await project(workstation, 'web-app');
    const deskProject = await project(desktop, 'web-app');
    const unlinked = await project(desktop, 'elsewhere');
    await desktop.app.mcp.call('hosts_link', { host_id: workstationId, project_id: deskProject, remote_project_id: devProject });

    const developer = await agent(workstation, devProject);
    let benchmarker = await agent(desktop, deskProject);
    const stranger = await agent(desktop, unlinked);

    // Each host lists the other's agents in the linked project.
    const listed = await benchmarker.call('list_processes', {}) as { processes: Array<{ process_id: string; host?: string }> };
    assert.ok(listed.processes.some((row) => row.process_id === `workstation:${developer.process_id}` && row.host === 'workstation'), JSON.stringify(listed));
    assert.ok(listed.processes.some((row) => row.process_id === benchmarker.process_id && !row.host));
    const reverse = await developer.call('list_processes', {}) as { processes: Array<{ process_id: string }> };
    assert.ok(reverse.processes.some((row) => row.process_id === `desktop:${benchmarker.process_id}`), 'listing works both ways');
    const strangerList = await stranger.call('list_processes', {}) as { processes: Array<{ process_id: string }> };
    assert.ok(!strangerList.processes.some((row) => row.process_id.includes(':')), 'unlinked projects see no other host');
    const status = await benchmarker.call('get_project_status', {}) as { processes: Array<{ process_id: string }> };
    assert.ok(status.processes.some((row) => row.process_id === `workstation:${developer.process_id}`));

    // The UI on each host shows the other host's agents in the linked
    // project, with qualified IDs, and the other host's other projects on
    // their own.
    const snapshot = (host: Host) => host.app.readWorkbench(null) as VersionedWorkbench;
    const deskWorkbench = () => snapshot(desktop).projects.find((entry) => entry.project.id === deskProject);
    const remoteRow = await until(() => deskWorkbench()?.projectSessions.find((session) => session.processId === `workstation:${developer.process_id}`), 'the dev box agent in the desktop workbench');
    assert.equal(remoteRow.host, 'workstation');
    assert.match(remoteRow.id, /^workstation:session_/);
    assert.match(remoteRow.ptyProcessId ?? '', /^workstation:/);
    const devOnly = await project(workstation, 'workstation-only');
    await until(() => snapshot(desktop).projects.some((entry) => entry.project.id === `workstation:${devOnly}` && entry.project.host === 'workstation'), 'an unlinked dev box project');
    await until(() => snapshot(workstation).projects.find((entry) => entry.project.id === devProject)?.projectSessions.some((session) => session.processId === `desktop:${benchmarker.process_id}`), 'the desktop agent in the dev box workbench');

    // UI requests for the other host's records run there.
    const rpc = async (host: Host, channel: string, args: unknown) => {
      const response = await fetch(`${host.origin}/api/rpc`, { method: 'POST', headers: { Origin: host.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 1, channel, args }) });
      const body = await response.json() as { result?: unknown; error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      return body.result;
    };
    await rpc(desktop, 'patterm:mcp:call', { tool: 'rename_process', arguments: { process_id: `workstation:${developer.process_id}`, name: 'Developer' } });
    assert.equal((workstation.app.database.connection.prepare('select name from processes where id = ?').get(developer.process_id) as { name: string }).name, 'Developer');
    await until(() => { const session = deskWorkbench()?.projectSessions.find((row) => row.processId === `workstation:${developer.process_id}`); return session?.displayName === 'Developer' || session?.lastTitle === 'Developer'; }, 'the rename to reach the desktop workbench');
    await assert.rejects(rpc(desktop, 'patterm:mcp:call', { tool: 'hosts_unpair', arguments: { host_id: desktopId, process_id: `workstation:${developer.process_id}` } }), /not available to another host/);
    // Transcript snapshots name a tool that exists here and passes the peer gate.
    const integratedRead = (read: Promise<unknown>) => read.then(() => 'read', (error: unknown) => String(error));
    assert.doesNotMatch(await integratedRead(readIntegrated(workstation.app, developer.process_id)), /unknown MCP tool/, 'local transcript reads reach integrated_get');
    assert.doesNotMatch(await integratedRead(readIntegrated(desktop.app, `workstation:${developer.process_id}`)), /unknown MCP tool|not available to another host/, 'remote transcript reads reach integrated_get');

    // A browser on the desktop streams and types into the dev box terminal.
    const browser = await browserClient(desktop);
    const { frames, pushed } = browser;
    const socketCall = browser.call;
    const remotePty = remoteRow.ptyProcessId!;
    await socketCall('patterm:terminal:subscribe', { process_id: remotePty, subscribed: true, cols: 90, rows: 20 });
    await until(() => frames.some((frame) => frame?.processId === remotePty), 'a relayed terminal frame');
    await socketCall('patterm:terminal:input', { process_id: remotePty, kind: 'text', text: 'echo FROM-DESKTOP-UI', submit: true });
    await until(async () => (await developer.output()).includes('FROM-DESKTOP-UI'), 'input typed on the desktop to reach the dev box');
    await until(() => frames.some((frame) => frame?.processId === remotePty && frame.frameKind === 'damage'), 'damage frames from the dev box');
    // A copy made by the dev box program reaches the browser controlling it.
    const copyCommand = process.platform === 'win32'
      ? '[Console]::Out.Write("$([char]27)]52;c;SGVsbG8=$([char]7)")'
      : "printf '\\033]52;c;SGVsbG8=\\a'";
    await socketCall('patterm:terminal:input', { process_id: remotePty, kind: 'text', text: copyCommand, submit: true });
    await until(() => pushed.some((item) => item.event === 'terminal-client-request' && item.payload.kind === 'clipboard' && item.payload.text === 'Hello' && item.payload.processId === remotePty), 'a relayed clipboard copy');

    // Control of a terminal is decided by the host that runs it: one of its
    // own browsers, or a paired host on behalf of its browsers.
    const owner = await browserClient(workstation);
    const localPty = remotePty.slice('workstation:'.length);
    const owning = await owner.call('patterm:terminal:subscribe', { process_id: localPty, subscribed: true }) as { controlling: boolean };
    assert.equal(owning.controlling, false, 'the desktop already controls it');
    await assert.rejects(owner.call('patterm:terminal:input', { process_id: localPty, kind: 'text', text: 'x' }), /Take control/);
    await owner.call('patterm:terminal:take-control', { process_id: localPty });
    await until(() => pushed.some((item) => item.event === 'terminal-control' && item.payload.processId === remotePty && item.payload.controlling === false), 'the desktop to lose control');
    await assert.rejects(socketCall('patterm:terminal:input', { process_id: remotePty, kind: 'text', text: 'x' }), /Take control/);
    await owner.call('patterm:terminal:input', { process_id: localPty, kind: 'text', text: 'echo FROM-WORKSTATION-UI', submit: true });
    await socketCall('patterm:terminal:take-control', { process_id: remotePty });
    await until(() => owner.pushed.some((item) => item.event === 'terminal-control' && item.payload.processId === localPty && item.payload.controlling === false), 'the dev box browser to lose control');
    await assert.rejects(owner.call('patterm:terminal:input', { process_id: localPty, kind: 'text', text: 'x' }), /Take control/);
    await socketCall('patterm:terminal:input', { process_id: remotePty, kind: 'text', text: 'echo DESKTOP-AGAIN', submit: true });
    await until(async () => (await developer.output()).includes('DESKTOP-AGAIN'), 'the desktop typing again');
    owner.close();
    await socketCall('patterm:terminal:subscribe', { process_id: remotePty, subscribed: false });

    // A desktop window has no Take control action: it holds the terminals
    // it shows, and typing in one takes control back, on whichever host
    // runs it.
    const desktopWindow = (host: Host) => {
      const routes = new Map<string, (event: unknown, raw?: unknown) => unknown>();
      const register = (channel: string, handler: (event: unknown, raw?: unknown) => unknown) => { routes.set(channel, handler); };
      registerApplicationRoutes(relayingRegistrar({ handle: register, on: register }, host.app, { takesControl: true }), host.app);
      return async (channel: string, args: unknown) => routes.get(channel)!(undefined, args);
    };
    const devWindow = desktopWindow(workstation);
    await devWindow('patterm:terminal:subscribe', { process_id: localPty, subscribed: true });
    const watching = await socketCall('patterm:terminal:subscribe', { process_id: remotePty, subscribed: true }) as { controlling: boolean };
    assert.equal(watching.controlling, false, 'the dev box window holds the terminal it shows');
    await assert.rejects(socketCall('patterm:terminal:input', { process_id: remotePty, kind: 'text', text: 'x' }), /Take control/);
    await socketCall('patterm:terminal:take-control', { process_id: remotePty });
    const lostBefore = pushed.length;
    await devWindow('patterm:terminal:input', { process_id: localPty, kind: 'text', text: 'echo FROM-WORKSTATION-WINDOW', submit: true });
    await until(() => pushed.slice(lostBefore).some((item) => item.event === 'terminal-control' && item.payload.processId === remotePty && item.payload.controlling === false), 'typing in the dev box window to take control back');
    await assert.rejects(socketCall('patterm:terminal:input', { process_id: remotePty, kind: 'text', text: 'x' }), /Take control/);
    await devWindow('patterm:terminal:subscribe', { process_id: localPty, subscribed: false });
    await socketCall('patterm:terminal:subscribe', { process_id: remotePty, subscribed: false });

    // A desktop window that closes a terminal, which a browser on the dev box
    // then takes, gets control again when it reopens it.
    const deskWindow = desktopWindow(desktop);
    await deskWindow('patterm:terminal:subscribe', { process_id: remotePty, subscribed: true });
    await deskWindow('patterm:terminal:subscribe', { process_id: remotePty, subscribed: false });
    const devViewer = await browserClient(workstation);
    const viewerOwns = await devViewer.call('patterm:terminal:subscribe', { process_id: localPty, subscribed: true }) as { controlling: boolean };
    assert.equal(viewerOwns.controlling, true);
    const reopened = await deskWindow('patterm:terminal:subscribe', { process_id: remotePty, subscribed: true }) as { controlling: boolean };
    assert.equal(reopened.controlling, true, 'reopening takes control again');
    await deskWindow('patterm:terminal:input', { process_id: remotePty, kind: 'text', text: 'echo FROM-DESKTOP-WINDOW', submit: true });
    await until(async () => (await developer.output()).includes('FROM-DESKTOP-WINDOW'), 'the reopened desktop window typing');
    await deskWindow('patterm:terminal:subscribe', { process_id: remotePty, subscribed: false });
    devViewer.close();

    // Files attached for a dev box agent are stored on the dev box.
    const upload = await fetch(`${desktop.origin}/api/upload?name=notes.txt&process_id=${encodeURIComponent(`workstation:${developer.process_id}`)}`, { method: 'POST', headers: { Origin: desktop.origin }, body: 'benchmark notes' });
    const uploaded = await upload.json() as { path: string };
    assert.equal(upload.status, 200, JSON.stringify(uploaded));
    assert.ok(uploaded.path.startsWith(path.join(workstation.dir, 'data', 'uploads')), uploaded.path);
    assert.equal(fs.readFileSync(uploaded.path, 'utf8'), 'benchmark notes');
    browser.close();

    // A linked project can launch on the other host.
    assert.deepEqual(deskWorkbench()!.project.remotes, [{ host: 'workstation', projectId: `workstation:${devProject}`, contextRevision: 0, sharesHistory: true }], 'a linked project carries the paired host\'s context revision, and that it announces history');
    const launchedRemote = await rpc(desktop, 'patterm:mcp:call', { tool: 'harness_launch', arguments: { project_id: `workstation:${devProject}`, harness: 'rawpty', interface_mode: 'tui' } }) as { session_id: string; process_id: string };
    assert.match(launchedRemote.session_id, /^workstation:session_/);
    assert.ok(workstation.app.database.connection.prepare('select 1 from sessions where id = ? and project_id = ?').get(launchedRemote.session_id.slice('workstation:'.length), devProject));
    await until(() => deskWorkbench()?.projectSessions.some((session) => session.id === launchedRemote.session_id), 'the launched agent in the desktop workbench');
    await rpc(desktop, 'patterm:mcp:call', { tool: 'close_process', arguments: { process_id: launchedRemote.process_id } });
    await until(() => !deskWorkbench()?.projectSessions.some((session) => session.id === launchedRemote.session_id && !session.exitedAt), 'the remote agent to close');

    // An agent saves a routine on the other host, which owns and runs it.
    const scheduled = await benchmarker.call('routine_schedule_once', { host: 'workstation', name: 'Recheck the allocator', prompt: 'Rerun the allocator benchmarks.', harness: 'claude', in_minutes: 60 }) as { routine_id: string; project_id: string; created_by: { type: string; name: string } };
    assert.equal(scheduled.project_id, devProject, 'the routine lands in the linked project there');
    assert.match(scheduled.created_by.name, / on desktop$/);
    const stored = workstation.app.database.connection.prepare('select project_id, created_by_type, created_by_remote_process_id from routines where id = ?').get(scheduled.routine_id) as { project_id: string; created_by_type: string; created_by_remote_process_id: string } | undefined;
    assert.deepEqual(stored, { project_id: devProject, created_by_type: 'agent', created_by_remote_process_id: `desktop:${benchmarker.process_id}` });
    assert.ok(!desktop.app.database.connection.prepare('select 1 from routines where id = ?').get(scheduled.routine_id), 'the routine is not stored here');
    const remoteRoutines = await benchmarker.call('routine_list', { host: 'workstation' }) as { routines: Array<{ routine_id: string }> };
    assert.deepEqual(remoteRoutines.routines.map((routine) => routine.routine_id), [scheduled.routine_id]);
    assert.deepEqual((await benchmarker.call('routine_list', {}) as { routines: unknown[] }).routines, [], 'this host has no routines');
    await benchmarker.call('routine_update', { host: 'workstation', routine_id: scheduled.routine_id, name: 'Recheck allocator benchmarks' });
    await assert.rejects(() => benchmarker.call('routine_run_now', { host: 'workstation', routine_id: scheduled.routine_id }), /cannot start a run on another host/);
    await benchmarker.call('routine_delete', { host: 'workstation', routine_id: scheduled.routine_id });
    assert.ok(!workstation.app.database.connection.prepare('select 1 from routines where id = ?').get(scheduled.routine_id));

    // Changes to the other host's todos refresh views here.
    const topicsSeen: string[] = [];
    const stopTopics = desktop.app.onDataChanged((topics) => topicsSeen.push(...topics));
    await rpc(workstation, 'patterm:mcp:call', { tool: 'todo_create', arguments: { project_id: devProject, title: 'Profile the hot path' } });
    await until(() => topicsSeen.includes('context'), 'a forwarded context change');
    // So do changes to its conversation history, which this host's clients
    // may then cache.
    workstation.app.notifyChanged(['history']);
    await until(() => topicsSeen.includes('history'), 'a forwarded history change');
    stopTopics();
    await until(() => (deskWorkbench()?.project.remotes?.[0]?.contextRevision ?? 0) > 0, 'the other host\'s context revision to reach this workbench');

    // Hiding a host's agents takes them out of this host's workbench only,
    // and the change is published without anyone asking for a snapshot.
    const patches: unknown[] = [];
    const stopPatches = desktop.app.onWorkbenchPatch((patch) => patches.push(patch));
    await rpc(desktop, 'patterm:mcp:call', { tool: 'hosts_show_agents', arguments: { host_id: workstationId, show_agents: false } });
    await until(() => patches.some((patch) => JSON.stringify(patch).includes('workstation:session_')), 'a published patch removing the hidden agents');
    stopPatches();
    assert.ok(!deskWorkbench()?.projectSessions.some((row) => row.host === 'workstation'));
    await rpc(desktop, 'patterm:mcp:call', { tool: 'hosts_show_agents', arguments: { host_id: workstationId, show_agents: true } });
    await until(() => deskWorkbench()?.projectSessions.some((row) => row.host === 'workstation'), 'shown agents to return');

    // Reads work; control does not.
    const remoteStatus = await benchmarker.call('get_process_status', { process_id: `workstation:${developer.process_id}` }) as { status: string; kind: string };
    assert.deepEqual([remoteStatus.kind, remoteStatus.status], ['agent', 'running']);
    await assert.rejects(benchmarker.call('send_input', { process_id: `workstation:${developer.process_id}`, kind: 'text', text: 'rm -rf /' }), /cannot act on workstation:process_\d+.*send_message/);
    await assert.rejects(benchmarker.call('stop_process', { process_id: `workstation:${developer.process_id}` }), /cannot act on/);
    await assert.rejects(stranger.call('get_process_status', { process_id: `workstation:${developer.process_id}` }), /not linked with workstation/);
    await assert.rejects(benchmarker.call('get_process_status', { process_id: 'nowhere:process_1' }), /No paired host is called nowhere/);
    await assert.rejects(benchmarker.call('get_process_status', { process_id: 'workstation:process_999' }), /outside the current caller scope|unknown process/);

    // Context on the other host is readable through host_read.
    await workstation.app.mcp.call('todo_create', { project_id: devProject, title: 'Benchmark the branch' });
    const todos = await benchmarker.call('host_read', { host: 'workstation', tool: 'todo_list', arguments: {} }) as { items: Array<{ title: string }> };
    assert.deepEqual(todos.items.map((todo) => todo.title).sort(), ['Benchmark the branch', 'Profile the hot path']);
    await assert.rejects(benchmarker.call('host_read', { host: 'workstation', tool: 'todo_create', arguments: { title: 'x' } }), /cannot run on another host/);

    // The other host's records keep their host in every reply, so follow-up
    // requests reach it: session context, todo updates, references, timers.
    const developerSession = (workstation.app.database.connection.prepare('select id from sessions where process_id = ?').get(developer.process_id) as { id: string }).id;
    const assigned = await rpc(workstation, 'patterm:mcp:call', { tool: 'todo_create', arguments: { project_id: devProject, title: 'Assigned remotely', assignee_id: developerSession } }) as { id: string };
    const context = await rpc(desktop, 'patterm:mcp:call', { tool: 'session_context', arguments: { project_id: deskProject, session_id: `workstation:${developerSession}` } }) as { todos: { items: Array<{ id: string; revision: number }> } };
    const remoteTodo = context.todos.items.find((todo) => todo.id === `workstation:${assigned.id}`);
    assert.ok(remoteTodo, JSON.stringify(context.todos));
    await rpc(desktop, 'patterm:mcp:call', { tool: 'todo_update', arguments: { project_id: deskProject, todo_id: remoteTodo.id, revision: remoteTodo.revision, status: 'in_progress' } });
    assert.equal((workstation.app.database.connection.prepare('select status from todos where id = ?').get(assigned.id) as { status: string }).status, 'in_progress');
    await rpc(desktop, 'patterm:mcp:call', { tool: 'reference_attach', arguments: { project_id: deskProject, target_type: 'session', target_id: `workstation:${developerSession}`, url: 'https://example.com/pulls/34' } });
    assert.ok(workstation.app.database.connection.prepare('select 1 from external_references where url = ?').get('https://example.com/pulls/34'));
    assert.equal(desktop.app.database.connection.prepare('select 1 from external_references where url = ?').get('https://example.com/pulls/34'), undefined);
    const devTimer = await developer.call('timer_set', { seconds: 3600, body: 'never' }) as { timer_id: string };
    await desktop.app.remote.relay(desktop.app.remote.target({ process_id: 'workstation:x' })!, 'patterm:mcp:call', { tool: 'timer_cancel', arguments: { timer_id: `workstation:${devTimer.timer_id}` } });
    assert.ok(!(JSON.stringify(await developer.call('timer_list', {}))).includes(`"${devTimer.timer_id}","status":"pending"`));
    const archived = await rpc(desktop, 'patterm:workbench:record', { project_id: deskProject, session_id: `workstation:${developerSession}` }) as { session?: { id: string } } | null;
    if (archived?.session) assert.equal(archived.session.id, `workstation:${developerSession}`);

    // Messages reach agents only: typed into a shell they would run.
    await rpc(workstation, 'patterm:mcp:call', { tool: 'process_create', arguments: { project_id: devProject } });
    const shell = (workstation.app.database.connection.prepare(`select id from processes where project_id = ? and kind <> 'agent' order by created_at desc limit 1`).get(devProject) as { id: string }).id;
    const toShell = await benchmarker.call('send_message', { target_process_id: `workstation:${shell}`, message: 'echo SHOULD-NOT-RUN' }) as { status: string; detail: string };
    assert.equal(toShell.status, 'bounced');
    assert.match(toShell.detail, /is not an agent/);
    assert.ok(!((await workstation.app.mcp.call('get_process_output', { process_id: shell }) as { content?: string }).content ?? '').includes('SHOULD-NOT-RUN'));

    // A message retried while its first delivery is still running is typed
    // once.
    const twice = { peer_message_id: 'pmsg_retry', project_id: devProject, from_process_id: benchmarker.process_id, to_process_id: developer.process_id, body: 'echo ONCE' };
    const [first, second] = await Promise.all([desktop.app.peers.request(workstationId, 'agents.message', twice), desktop.app.peers.request(workstationId, 'agents.message', twice)]) as Array<{ status: string }>;
    assert.deepEqual([first!.status, second!.status], ['delivered', 'delivered']);
    assert.equal((workstation.app.database.connection.prepare(`select count(*) as n from timeline_events where event_type = 'message.received' and json_extract(metadata, '$.peer_message_id') = 'pmsg_retry'`).get() as { n: number }).n, 1);

    // The developer asks the benchmarker for results and waits for a reply.
    // A timer counts messages from the millisecond it starts, so let the clock
    // pass the message above, or it would count as the reply.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const timer = await developer.call('timer_fire_when_reported_any', { watched: [`desktop:${benchmarker.process_id}`], body: 'BENCHMARK-REPLY-ARRIVED' }) as { status: string };
    assert.equal(timer.status, 'pending');
    await assert.rejects(developer.call('timer_fire_when_idle_any', { watched: [`desktop:${benchmarker.process_id}`], body: 'x' }), /Idle timers cannot watch/);
    // Renaming the watched host does not fire the timer.
    await rpc(desktop, 'patterm:mcp:call', { tool: 'hosts_rename', arguments: { name: 'desktop-two' } });
    await until(() => workstation.app.hosts.overview().peers[0]?.name === 'desktop-two', 'the rename to reach the dev box');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.ok(!(await developer.output()).includes('BENCHMARK-REPLY-ARRIVED'), 'a rename is not a reply');
    await rpc(desktop, 'patterm:mcp:call', { tool: 'hosts_rename', arguments: { name: 'desktop' } });
    await until(() => workstation.app.hosts.overview().peers[0]?.name === 'desktop', 'the name to return');
    const sent = await developer.call('send_message', { target_process_id: `desktop:${benchmarker.process_id}`, message: 'echo RUN-BENCHMARKS' }) as { status: string; ok: boolean };
    assert.deepEqual([sent.ok, sent.status], [true, 'delivered']);
    await until(async () => (await benchmarker.output()).includes(`[message from workstation:${developer.process_id}]`), 'the message in the benchmarker terminal');
    const reply = await benchmarker.call('send_message', { target_process_id: `workstation:${developer.process_id}`, message: 'echo RESULTS-READY' }) as { status: string };
    assert.equal(reply.status, 'delivered');
    await until(async () => (await developer.output()).includes('BENCHMARK-REPLY-ARRIVED'), 'the report timer to fire on the dev box');
    const events = (app: PattermApplication, type: string) => app.database.connection.prepare('select metadata from timeline_events where event_type = ?').all(type).map((row) => JSON.parse((row as { metadata: string }).metadata));
    assert.equal(events(workstation.app, 'message.sent').length, 1);
    assert.equal(events(desktop.app, 'message.received').length, 1);
    assert.equal(events(desktop.app, 'message.received')[0].from_host_id, workstationId);

    // A message to an agent that is gone bounces back, and the user hears.
    const bounced = await benchmarker.call('send_message', { target_process_id: 'workstation:process_999', message: 'hello?' }) as { status: string; detail: string };
    assert.equal(bounced.status, 'bounced');
    assert.match(bounced.detail, /no process process_999/);
    await until(async () => (await benchmarker.output()).includes('[delivery failed'), 'the bounce in the sender terminal');
    const notices = await desktop.app.mcp.call('notification_list', {}) as { items: Array<{ title: string }> };
    assert.ok(notices.items.some((item) => /bounced/.test(item.title)), JSON.stringify(notices));

    // While the dev box is down, messages wait and are delivered once.
    await workstation.server!.stop();
    await until(() => !desktop.app.peers.connected(workstationId), 'the link to drop');
    const queued = await benchmarker.call('send_message', { target_process_id: `workstation:${developer.process_id}`, message: 'echo WHILE-AWAY' }) as { status: string; detail: string };
    assert.equal(queued.status, 'queued');
    assert.match(queued.detail, /not connected/);
    await serve(workstation);
    await until(() => (desktop.app.database.connection.prepare(`select status from peer_messages where direction = 'out' and body = 'echo WHILE-AWAY'`).get() as { status: string }).status === 'delivered', 'the queued message', 30_000);
    await until(async () => (await developer.output()).includes('WHILE-AWAY'), 'the queued message in the developer terminal');
    assert.equal((workstation.app.database.connection.prepare(`select count(*) as n from peer_messages where direction = 'in' and body = 'echo WHILE-AWAY'`).get() as { n: number }).n, 1);

    // A queued message whose project is unlinked bounces instead of holding
    // up later messages for other projects.
    const devSide = await project(workstation, 'side-project');
    const deskSide = await project(desktop, 'side-project');
    await desktop.app.mcp.call('hosts_link', { host_id: workstationId, project_id: deskSide, remote_project_id: devSide });
    const sideAgent = await agent(desktop, deskSide);
    await workstation.server!.stop();
    await until(() => !desktop.app.peers.connected(workstationId), 'the link to drop before unlinking');
    await sideAgent.call('send_message', { target_process_id: `workstation:${developer.process_id}`, message: 'echo UNLINKED' });
    await benchmarker.call('send_message', { target_process_id: `workstation:${developer.process_id}`, message: 'echo BEHIND-IT' });
    await desktop.app.mcp.call('hosts_unlink', { host_id: workstationId, project_id: deskSide });
    await serve(workstation);
    const outStatus = (body: string) => (desktop.app.database.connection.prepare(`select status from peer_messages where direction = 'out' and body = ?`).get(body) as { status: string }).status;
    await until(() => outStatus('echo UNLINKED') === 'bounced' && outStatus('echo BEHIND-IT') === 'delivered', 'the unlinked message to bounce and the next to arrive', 30_000);

    // Restarting keeps pairing, links, and queued messages: a message queued
    // before the sender restarts is delivered when the other host returns.
    await workstation.server!.stop();
    await until(() => !desktop.app.peers.connected(workstationId), 'the link to drop before restarting');
    const survivor = await benchmarker.call('send_message', { target_process_id: `workstation:${developer.process_id}`, message: 'echo AFTER-RESTART' }) as { status: string };
    assert.equal(survivor.status, 'queued');
    await restart(desktop);
    const restored = desktop.app.hosts.overview().peers;
    assert.deepEqual(restored.map((peer) => [peer.name, peer.projects.map((link) => link.project_id)]), [['workstation', [deskProject]]]);
    await serve(workstation);
    await until(() => (desktop.app.database.connection.prepare(`select status from peer_messages where direction = 'out' and body = 'echo AFTER-RESTART'`).get() as { status: string }).status === 'delivered', 'the queued message after restarting', 30_000);
    await until(async () => (await developer.output()).includes('AFTER-RESTART'), 'the restarted host\'s message in the developer terminal');
    benchmarker = await agent(desktop, deskProject);

    // A host unpaired while the other was away refuses it, and the user
    // hears. Unpairing then bounces whatever is still queued.
    await workstation.server!.stop();
    await until(() => !desktop.app.peers.connected(workstationId), 'the link to drop again');
    await benchmarker.call('send_message', { target_process_id: `workstation:${developer.process_id}`, message: 'echo NEVER' });
    await workstation.app.mcp.call('hosts_unpair', { host_id: desktopId });
    await serve(workstation);
    // The UI's list, which includes notices about hosts rather than agents.
    await until(() => desktop.app.notifications.list({}).items.some((item) => item.title === 'Cannot connect to workstation'), 'the refusal notice', 30_000);
    await desktop.app.mcp.call('hosts_unpair', { host_id: workstationId });
    await until(() => (desktop.app.database.connection.prepare(`select status from peer_messages where direction = 'out' and body = 'echo NEVER'`).get() as { status: string }).status === 'bounced', 'the unpair bounce');
    console.log('cross-host smoke passed');
  } finally {
    for (const host of hosts) {
      await host.server?.stop().catch(() => undefined);
      await host.app.dispose();
    }
    removeTree(root);
  }
}

const deadline = setTimeout(() => { console.error('cross-host smoke timed out'); process.exit(1); }, 120_000);
void main().then(() => clearTimeout(deadline)).catch((error) => { console.error(error); process.exit(1); });
