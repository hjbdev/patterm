import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { CloseProcessAction } from '../app/Actions/CloseProcessAction';
import { DatabaseService } from '../app/Services/DatabaseService';
import { IntegratedAgentService, type IntegratedProviderService } from '../app/Services/IntegratedAgentService';
import type { IntegratedHostLauncher } from '../app/Services/IntegratedHostLauncher';
import type { TerminalService } from '../app/Services/TerminalService';

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
      server.listen(path.join(directory, `${id}.sock`), resolve);
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
    await new CloseProcessAction(database, terminal, undefined, service).execute('parent');
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
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log('retired Integrated hosts smoke ok');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
