import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { CloseProcessAction } from '../app/Actions/CloseProcessAction';
import { ipcPath } from '../app/Platform/Ipc';
import { DatabaseService } from '../app/Services/DatabaseService';
import { IntegratedAgentService, type IntegratedProviderService } from '../app/Services/IntegratedAgentService';
import { supervisedHostLauncher, supervisorGeneration, systemdHostLauncher, type IntegratedHostLauncher } from '../app/Services/IntegratedHostLauncher';
import type { TerminalService } from '../app/Services/TerminalService';

import { removeTree } from './fixtures/TempTree';
async function main(): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-retired-hosts-'));
  const database = new DatabaseService(directory);
  const servers: net.Server[] = [];
  const connections = new Set<net.Socket>();
  const requests: string[] = [];
  const supervised: string[] = [];
  let refuse = false;
  let forceSupervisedStop: (() => void) | null = null;
  let stopSupported = 0;
  let quitSupported = 0;
  const launcher: IntegratedHostLauncher = {
    launch: async () => { throw new Error('No retired harness can launch'); },
    stopAll: async (harness) => { supervised.push(harness); forceSupervisedStop?.(); }
  };
  const provider: IntegratedProviderService = {
    prepare: async () => ({ resumeId: 'test', argv: [] }),
    conversation: async () => ({ status: 'idle' }),
    prompt: async () => ({}),
    interrupt: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    stop: async () => { stopSupported++; },
    stopAll: async () => { quitSupported++; }
  };
  const service = new IntegratedAgentService(database, { claude: provider }, undefined, undefined, launcher);
  const now = new Date().toISOString();
  const add = (id: string, harness = 'amp', parent: string | null = null) => {
    database.connection.prepare(`insert into processes
      (id,project_id,parent_process_id,kind,name,status,activity,argv,created_at,updated_at)
      values (?, 'project', ?, 'agent', ?, 'running', 'idle', ?, ?, ?)`)
      .run(id, parent, id, JSON.stringify(['native-cli', `${harness}-host`, path.join(directory, `${id}.sock`)]), now, now);
    database.connection.prepare(`insert into sessions
      (id,project_id,process_id,harness,interface_mode,started_at,session_role,resume_status)
      values (?, 'project', ?, ?, 'integrated', ?, 'orchestrator', 'found')`).run(`session_${id}`, id, harness, now);
  };
  const host = async (id: string) => {
    const server = net.createServer((socket) => {
      connections.add(socket);
      socket.once('close', () => connections.delete(socket));
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        if (!buffer.includes('\n')) return;
        const request = JSON.parse(buffer.split('\n')[0]!) as { id: string; method: string };
        requests.push(`${id}:${request.method}`);
        assert.equal(request.method, 'stop', 'retired hosts only receive lifecycle cleanup');
        socket.end(`${JSON.stringify({ id: request.id, ...(refuse ? { error: 'refused' } : { result: {} }) })}\n`);
        if (!refuse) server.close();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(ipcPath(path.join(directory, `${id}.sock`)), resolve);
    });
    return server;
  };
  const state = (id: string) => database.connection.prepare('select status, exited_at from processes where id = ?').get(id) as { status: string; exited_at: string | null };
  try {
    database.initialize();
    database.connection.prepare('insert into projects (id,name,path,created_at,updated_at) values (?,?,?,?,?)').run('project', 'Test', directory, now, now);
    add('upgrade');
    await host('upgrade');
    assert.deepEqual(await service.reconcile(), { checked: 1, failed: 1, unreachable: 0 });
    assert.equal(state('upgrade').status, 'failed');
    assert.ok(state('upgrade').exited_at);
    assert.deepEqual(requests, ['upgrade:stop']);
    assert.deepEqual(supervised, ['amp'], 'retirement also stops every supervised generation');

    add('parent', 'claude');
    add('child', 'amp', 'parent');
    await host('child');
    const terminal = { request: async () => { throw new Error('Integrated hosts never use PTY stop'); } } as unknown as TerminalService;
    await new CloseProcessAction(database, terminal, service).execute('parent');
    assert.equal(state('child').status, 'closed');
    assert.equal(state('parent').status, 'closed');
    assert.equal(stopSupported, 1, 'a retired child no longer blocks closing its supported parent');

    add('quit');
    await host('quit');
    // Quit must also clean a host whose record was already marked failed.
    database.connection.prepare("update processes set status = 'failed' where id = 'quit'").run();
    database.connection.prepare("update sessions set exited_at = ? where process_id = 'quit'").run(now);
    supervised.length = 0;
    await service.stopAll();
    assert.ok(requests.includes('quit:stop'));
    assert.deepEqual(supervised, ['amp'], 'Quit groups supervised cleanup by retired harness');
    assert.equal(quitSupported, 1);

    add('supervised');
    const managedHost = await host('supervised');
    refuse = true;
    forceSupervisedStop = () => { if (managedHost.listening) managedHost.close(); };
    await service.stop('session_supervised');
    assert.equal(managedHost.listening, false, 'supervised cleanup stops a host even if its socket refuses');
    forceSupervisedStop = null;
    database.connection.prepare("update sessions set exited_at = ? where process_id = 'supervised'").run(now);

    add('refusing');
    await host('refusing');
    refuse = true;
    assert.deepEqual(await service.reconcile(), { checked: 1, failed: 0, unreachable: 1 });
    assert.equal(state('refusing').status, 'running', 'a host that refused cleanup is not marked stopped');
    await assert.rejects(service.stop('refusing'), /Could not stop unsupported Integrated hosts/);
    await assert.rejects(service.stopAll(), /Could not stop every Integrated agent/);
    refuse = false;
    await service.stopIfLive('session_refusing');
  } finally {
    service.dispose();
    for (const socket of connections) socket.destroy();
    for (const server of servers) if (server.listening) server.close();
    database.dispose();
    removeTree(directory);
  }
  await versionedSupervisorSmoke();
  if (process.platform === 'linux') await systemdLauncherSmoke();
  console.log('retired Integrated hosts smoke ok');
}

async function waitForPidExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function removeTempDir(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function versionedSupervisorSmoke(): Promise<void> {
  // Keep POSIX socket paths well under macOS's 103-byte sun_path limit.
  const tempRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  const directory = fs.mkdtempSync(path.join(tempRoot, 'p-sup-'));
  const runtimeDir = path.join(directory, 'runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  const depPath = path.join(directory, 'dep.js');
  const scriptPath = path.join(directory, 'sup.js');
  fs.writeFileSync(depPath, 'module.exports = { version: 1 };\n');
  const ipcModule = path.resolve(__dirname, '../app/Platform/Ipc');
  fs.writeFileSync(scriptPath, [
    "const fs = require('node:fs');",
    "const net = require('node:net');",
    `const { ipcPath } = require(${JSON.stringify(ipcModule)});`,
    "const dep = require('./dep');",
    "const sock = process.argv[2];",
    "const pidMarker = process.platform === 'win32' ? sock + '.pid' : null;",
    "const sessions = new Map();",
    "let draining = false;",
    "const closeAll = () => { server.close(() => { if (process.platform !== 'win32') { try { fs.rmSync(sock, { force: true }); } catch {} } if (pidMarker) { try { fs.rmSync(pidMarker, { force: true }); } catch {} } process.exit(0); }); };",
    "const server = net.createServer((socket) => {",
    "  let buf = ''; socket.setEncoding('utf8');",
    "  socket.on('data', (chunk) => {",
    "    buf += chunk;",
    "    for (;;) {",
    "      const nl = buf.indexOf('\\n'); if (nl < 0) return;",
    "      const req = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);",
    "      if (req.op === 'start') { draining = false; sessions.set(req.key, { harness: req.harness, socketPath: req.configPath }); socket.write(JSON.stringify({ id: req.id, result: { pid: process.pid, socketPath: req.configPath, version: dep.version } }) + '\\n'); }",
    "      else if (req.op === 'stop') { let stopped = false; for (const [k, v] of sessions) { if (v.socketPath === req.socketPath) { sessions.delete(k); stopped = true; break; } } socket.write(JSON.stringify({ id: req.id, result: { pid: process.pid, stopped } }) + '\\n'); if (draining && sessions.size === 0) setImmediate(closeAll); }",
    "      else if (req.op === 'drain') { draining = true; socket.write(JSON.stringify({ id: req.id, result: { pid: process.pid, draining: true, sessions: sessions.size } }) + '\\n'); if (sessions.size === 0) setImmediate(closeAll); }",
    "      else if (req.op === 'stopHarness') { for (const [k, v] of [...sessions]) { if (v.harness === req.harness) sessions.delete(k); } socket.write(JSON.stringify({ id: req.id, result: { stopped: 1, remaining: sessions.size } }) + '\\n'); if ((req.exitIfEmpty || draining) && sessions.size === 0) setImmediate(closeAll); }",
    "      else if (req.op === 'ping') { socket.write(JSON.stringify({ id: req.id, result: { pid: process.pid, sessions: sessions.size } }) + '\\n'); }",
    "      else if (req.op === 'shutdown') { socket.write(JSON.stringify({ id: req.id, result: { ok: true } }) + '\\n'); setImmediate(closeAll); }",
    "    }",
    "  });",
    "});",
    "server.listen(ipcPath(sock), () => { if (pidMarker) { try { fs.writeFileSync(pidMarker, String(process.pid)); } catch {} } const boot = process.env.PATTERM_SUPERVISOR_BOOT_FILE; if (boot) { try { const b = JSON.parse(fs.readFileSync(boot, 'utf8')); fs.rmSync(boot, { force: true }); sessions.set(b.key, { harness: b.harness, socketPath: b.configPath }); } catch {} } });",
    "setTimeout(() => process.exit(0), 15000).unref();"
  ].join('\n'));

  const servers: net.Server[] = [];
  const pidsToKill: number[] = [];
  const previousPoll = process.env.PATTERM_LEGACY_SUPERVISOR_POLL_MS;
  process.env.PATTERM_LEGACY_SUPERVISOR_POLL_MS = '50';
  try {
    const gen1 = supervisorGeneration(scriptPath);
    fs.writeFileSync(depPath, 'module.exports = { version: 2 };\n');
    const gen2 = supervisorGeneration(scriptPath);
    assert.notEqual(gen1, gen2, 'changing a transitive runtime module must change the supervisor generation');

    // Simulate a running pre-versioning (legacy) supervisor with one active session
    // and no `drain` op, plus an older versioned supervisor with one active session.
    const legacyOps: string[] = [];
    const legacySessions = new Set(['legacy-session.sock']);
    const legacySocket = path.join(runtimeDir, 'integrated-supervisor.sock');
    const legacyServer = net.createServer((socket) => {
      let buf = ''; socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buf += chunk;
        for (;;) {
          const nl = buf.indexOf('\n'); if (nl < 0) return;
          const req = JSON.parse(buf.slice(0, nl)) as { id: string; op: string; socketPath?: string };
          buf = buf.slice(nl + 1);
          legacyOps.push(req.op);
          if (req.op === 'drain') socket.write(`${JSON.stringify({ id: req.id, error: 'Unknown supervisor op: drain' })}\n`);
          else if (req.op === 'ping') socket.write(`${JSON.stringify({ id: req.id, result: { pid: 999991, sessions: legacySessions.size } })}\n`);
          else if (req.op === 'stop') {
            const stopped = Boolean(req.socketPath && legacySessions.delete(req.socketPath));
            socket.write(`${JSON.stringify({ id: req.id, result: { pid: 999991, stopped } })}\n`);
          } else if (req.op === 'shutdown') {
            socket.write(`${JSON.stringify({ id: req.id, result: { ok: true } })}\n`);
            legacyServer.close();
          } else if (req.op === 'stopHarness') {
            legacySessions.clear();
            socket.write(`${JSON.stringify({ id: req.id, result: { stopped: 1, remaining: 0 } })}\n`);
            legacyServer.close();
          }
        }
      });
    });
    servers.push(legacyServer);
    await new Promise<void>((resolve, reject) => { legacyServer.once('error', reject); legacyServer.listen(ipcPath(legacySocket), resolve); });

    const oldOps: string[] = [];
    const oldSocket = path.join(runtimeDir, `integrated-supervisor-${gen1}.sock`);
    if (process.platform === 'win32') fs.writeFileSync(`${oldSocket}.pid`, '999992');
    const oldServer = net.createServer((socket) => {
      let buf = ''; socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buf += chunk;
        for (;;) {
          const nl = buf.indexOf('\n'); if (nl < 0) return;
          const req = JSON.parse(buf.slice(0, nl)) as { id: string; op: string };
          buf = buf.slice(nl + 1);
          oldOps.push(req.op);
          if (req.op === 'drain') { socket.write(`${JSON.stringify({ id: req.id, result: { pid: 999992, draining: true, sessions: 0 } })}\n`); oldServer.close(); }
          else if (req.op === 'ping') socket.write(`${JSON.stringify({ id: req.id, result: { pid: 999992, sessions: 0 } })}\n`);
          else if (req.op === 'stop') socket.write(`${JSON.stringify({ id: req.id, result: { pid: 999992, stopped: false } })}\n`);
          else if (req.op === 'stopHarness') { socket.write(`${JSON.stringify({ id: req.id, result: { stopped: 0, remaining: 0 } })}\n`); oldServer.close(); }
        }
      });
    });
    servers.push(oldServer);
    await new Promise<void>((resolve, reject) => { oldServer.once('error', reject); oldServer.listen(ipcPath(oldSocket), resolve); });

    // Launch on generation 2: must spawn a fresh supervisor on gen2's socket
    // instead of reusing the legacy or gen1 supervisors.
    const launcher = supervisedHostLauncher(directory, scriptPath);
    const gen2Pid = await launcher.launch({
      harness: 'agy', key: 'new-session', nodePath: process.execPath, script: 'host.js', configPath: 'new-session.sock', cwd: directory, env: {}
    });
    assert.ok(gen2Pid && gen2Pid > 0, 'new generation supervisor starts');
    pidsToKill.push(gen2Pid);
    if (process.platform !== 'win32') {
      assert.ok(fs.existsSync(path.join(runtimeDir, `integrated-supervisor-${gen2}.sock`)), 'new generation uses its own versioned socket');
    }
    // Give fire-and-forget drain a moment to reach old/legacy supervisors.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && (!oldOps.includes('drain') || !legacyOps.includes('ping'))) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(oldOps.includes('drain'), 'older versioned supervisor receives drain');
    assert.equal(legacyServer.listening, true, 'legacy supervisor with an active session stays alive');

    // When the last session on a pre-versioning legacy supervisor ends on its
    // own (e.g. via a Claude/ACP session stop RPC), the background reaper shuts
    // the empty legacy supervisor down automatically.
    legacySessions.clear();
    const retireDeadline = Date.now() + 2_000;
    while (Date.now() < retireDeadline && !legacyOps.includes('shutdown')) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(legacyOps.includes('shutdown'), 'empty legacy supervisor retires automatically after its last session ends');

    // Rolling back to gen2 while gen2 was drained must reuse the live gen2
    // supervisor (same PID) rather than spawning a second process over its socket.
    fs.writeFileSync(depPath, 'module.exports = { version: 3 };\n');
    const launcher3 = supervisedHostLauncher(directory, scriptPath);
    const gen3Pid = await launcher3.launch({
      harness: 'agy', key: 'gen3-session', nodePath: process.execPath, script: 'host.js', configPath: 'gen3-session.sock', cwd: directory, env: {}
    });
    assert.ok(gen3Pid && gen3Pid !== gen2Pid, 'gen3 starts its own supervisor');
    pidsToKill.push(gen3Pid);
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.writeFileSync(depPath, 'module.exports = { version: 2 };\n');
    const rollbackPid = await supervisedHostLauncher(directory, scriptPath).launch({
      harness: 'agy', key: 'rollback-session', nodePath: process.execPath, script: 'host.js', configPath: 'rollback-session.sock', cwd: directory, env: {}
    });
    assert.equal(rollbackPid, gen2Pid, 'rolling back to a drained generation reuses its live supervisor');

    await launcher3.stopAll('agy');
    for (const pid of pidsToKill) await waitForPidExit(pid);
  } finally {
    if (previousPoll === undefined) delete process.env.PATTERM_LEGACY_SUPERVISOR_POLL_MS;
    else process.env.PATTERM_LEGACY_SUPERVISOR_POLL_MS = previousPoll;
    for (const server of servers) if (server.listening) server.close();
    for (const pid of pidsToKill) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
      await waitForPidExit(pid, 2_000);
    }
    await removeTempDir(directory);
  }

  // Isolated fixture directory so Windows named pipes never collide with the
  // previous legacy server: verify that concurrent Quit stopAll calls across
  // harnesses serialize on a pre-versioning legacy supervisor and the 50 ms
  // reaper does not shut it down while native cleanup is still in flight.
  const quitDir = fs.mkdtempSync(path.join(tempRoot, 'p-sup-'));
  const quitRuntimeDir = path.join(quitDir, 'runtime');
  fs.mkdirSync(quitRuntimeDir, { recursive: true });
  const prevQuitPoll = process.env.PATTERM_LEGACY_SUPERVISOR_POLL_MS;
  process.env.PATTERM_LEGACY_SUPERVISOR_POLL_MS = '50';
  let slowLegacyServer: net.Server | null = null;
  try {
    const legacySocket = path.join(quitRuntimeDir, 'integrated-supervisor.sock');
    const ops: string[] = [];
    const sessions = new Set(['slow-agy.sock']);
    let agyStopFinished = false;
    let agyStopPending!: () => void;
    const agyPending = new Promise<void>((resolve) => { agyStopPending = resolve; });
    slowLegacyServer = net.createServer((socket) => {
      let buf = ''; socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buf += chunk;
        for (;;) {
          const nl = buf.indexOf('\n'); if (nl < 0) return;
          const req = JSON.parse(buf.slice(0, nl)) as { id: string; op: string; harness?: string };
          buf = buf.slice(nl + 1);
          ops.push(`${req.op}:${req.harness ?? ''}`);
          if (req.op === 'drain') socket.write(`${JSON.stringify({ id: req.id, error: 'Unknown supervisor op: drain' })}\n`);
          else if (req.op === 'ping') socket.write(`${JSON.stringify({ id: req.id, result: { pid: 999993, sessions: sessions.size } })}\n`);
          else if (req.op === 'shutdown') {
            assert.equal(agyStopFinished, true, 'legacy reaper must not shut down a supervisor during an in-flight stopHarness');
            socket.write(`${JSON.stringify({ id: req.id, result: { ok: true } })}\n`);
            slowLegacyServer?.close();
          } else if (req.op === 'stopHarness') {
            if (req.harness === 'agy') {
              sessions.clear();
              agyStopPending();
              setTimeout(() => {
                agyStopFinished = true;
                socket.write(`${JSON.stringify({ id: req.id, result: { stopped: 1, remaining: 0 } })}\n`);
              }, 250);
            } else {
              assert.equal(agyStopFinished, true, 'concurrent stopHarness for another harness must wait for in-flight legacy cleanup');
              socket.write(`${JSON.stringify({ id: req.id, result: { stopped: 0, remaining: sessions.size } })}\n`);
              if (sessions.size === 0) slowLegacyServer?.close();
            }
          }
        }
      });
    });
    await new Promise<void>((resolve, reject) => { slowLegacyServer!.once('error', reject); slowLegacyServer!.listen(ipcPath(legacySocket), resolve); });

    const quitLauncher = supervisedHostLauncher(quitDir, path.join(quitDir, 'unused-supervisor.js'));
    const agyStop = quitLauncher.stopAll('agy');
    await agyPending;
    const codexStop = quitLauncher.stopAll('codex');
    await Promise.all([agyStop, codexStop]);
    assert.equal(agyStopFinished, true, 'slow legacy stopHarness completed before concurrent harness sweep');
    assert.equal(ops.some((entry) => entry.startsWith('shutdown:')), false, 'reaper did not send shutdown during in-flight stopHarness');
  } finally {
    if (prevQuitPoll === undefined) delete process.env.PATTERM_LEGACY_SUPERVISOR_POLL_MS;
    else process.env.PATTERM_LEGACY_SUPERVISOR_POLL_MS = prevQuitPoll;
    if (slowLegacyServer?.listening) slowLegacyServer.close();
    await removeTempDir(quitDir);
  }
}

// Records the transient unit's arguments with stand-in systemd commands, so
// no live user manager is touched.
async function systemdLauncherSmoke(): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-systemd-hosts-'));
  const pidFile = path.join(directory, 'stub.pid');
  try {
    const bin = path.join(directory, 'bin');
    const log = path.join(directory, 'calls.log');
    const runner = path.join(directory, 'systemd-run.js');
    fs.mkdirSync(bin);
    // Start a tiny listening socket on the supervisor path when systemd-run is
    // invoked so launch()'s waitForSupervisorSocket check succeeds without
    // touching the live user manager.
    fs.writeFileSync(runner, [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      `fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join('\\n') + '\\n');`,
      "const sock = process.argv.at(-1);",
      "const child = spawn(process.execPath, ['-e', `const net=require('node:net');const s=net.createServer();s.listen(${JSON.stringify(sock)},()=>{process.stdout.write('ok\\\\n');});setTimeout(()=>process.exit(0),10000).unref();`], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });",
      `if (child.pid) fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      "child.stdout.once('data', () => { child.unref(); process.exit(0); });",
      "child.once('error', () => process.exit(1));",
      ''
    ].join('\n'));
    fs.writeFileSync(path.join(bin, 'systemd-run'), `#!/bin/sh\nexec '${process.execPath}' '${runner}' "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'systemctl'), '#!/bin/sh\necho 4242\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
    const configPath = path.join(directory, 'host.json');
    const pid = await systemdHostLauncher(directory, env).launch({
      harness: 'codex', key: 'smoke', nodePath: process.execPath, script: 'host.js', configPath, cwd: directory, env: {}
    });
    assert.equal(pid, 4242);
    const args = fs.readFileSync(log, 'utf8').split('\n');
    // A child killed for memory must not stop the host and its conversation.
    assert.ok(args.includes('--property=OOMPolicy=continue'), args.join(' '));
    assert.ok(args.includes('--property=KillMode=control-group'));
    assert.ok(args.some((arg) => /^--unit=patterm-integrated-supervisor-[0-9a-f]{8}-[0-9a-f]{12}\.service$/.test(arg)), args.join(' '));
    assert.ok(args.some((arg) => /integrated-supervisor-[0-9a-f]{12}\.sock$/.test(arg)), args.join(' '));
  } finally {
    try {
      const stubPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      if (Number.isInteger(stubPid) && stubPid > 0) process.kill(stubPid, 'SIGTERM');
    } catch {}
    removeTree(directory);
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
