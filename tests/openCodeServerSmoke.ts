import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Client as ModernClient } from '@modelcontextprotocol/client';
import { StdioClientTransport as ModernTransport } from '@modelcontextprotocol/client/stdio';
import { DatabaseService } from '../app/Services/DatabaseService';
import { UncertainDeliveryError } from '../app/Services/IntegratedDelivery';
import { IntegratedAgentService } from '../app/Services/IntegratedAgentService';
import { isOpenCodeVersionMismatch } from '../app/Services/OpenCodeServiceErrors';
import { OpenCodeServerService, ProviderCommandError } from '../app/Services/OpenCodeServerService';
import type { IntegratedConversationEvent } from '../app/Services/IntegratedConversation';
import { McpSocketServer } from '../app/MCP/McpSocketServer';
import { McpToolRegistry } from '../app/MCP/ToolRegistry';
import { DatabaseSync } from 'node:sqlite';
import { OpenCodeHistoryAdapter } from '../app/Services/AgentHistory/OpenCodeHistoryAdapter';
import { StopProcessAction } from '../app/Actions/StopProcessAction';
import { CloseProcessAction } from '../app/Actions/CloseProcessAction';
import type { TerminalService } from '../app/Services/TerminalService';
import { TranscriptImageStore } from '../app/Services/TranscriptImageStore';
import { normaliseMessages, normaliseTranscriptAttachments } from '../resources/js/lib/integratedConversation';

async function main(): Promise<void> {
  const waitFor = async (predicate: () => boolean, timeout = 3_000): Promise<void> => {
    const deadline = Date.now() + timeout;
    while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(predicate(), 'condition was not met before the timeout');
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-opencode-bridge-'));
  const database = new DatabaseService(directory);
  database.initialize();
  const now = new Date().toISOString();
  database.connection.prepare('insert into projects (id,name,path,created_at,updated_at) values (?,?,?,?,?)').run('project_test', 'Test', directory, now, now);
  const record = path.join(directory, 'requests.jsonl');
   fs.mkdirSync(path.join(directory, 'bin'));
  // Windows cannot execute a shebang script, so an npm-style .cmd shim starts it with node.
  const script = path.join(directory, 'bin', process.platform === 'win32' ? 'opencode.cjs' : 'opencode');
  const executable = process.platform === 'win32' ? path.join(directory, 'bin', 'opencode.cmd') : script;
  if (process.platform === 'win32') fs.writeFileSync(executable, '@ECHO off\r\n"%~dp0\\opencode.cjs" %*\r\n');
  fs.writeFileSync(script, `#!${process.execPath}
const fs = require('node:fs');
const [, , api, method, route, , json] = process.argv;
 if (api === '--version') { console.log('opencode v2.0.14'); process.exit(0); }
if (api === 'service' && method === 'restart') { if (process.env.RESTARTED) fs.writeFileSync(process.env.RESTARTED, ''); process.exit(0); }
if (api !== 'api') process.exit(2);
const body = json ? JSON.parse(json) : undefined;
const rows = fs.existsSync(process.env.RECORD) ? fs.readFileSync(process.env.RECORD, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse) : [];
if (process.env.REJECT_PROMPT && method === 'POST' && route.endsWith('/prompt')) { console.log('HTTP 400 Bad Request'); process.exit(1); }
if (process.env.REJECT_COMPACT && method === 'POST' && route.endsWith('/compact')) { console.log('HTTP ' + process.env.REJECT_COMPACT); process.exit(1); }
fs.appendFileSync(process.env.RECORD, JSON.stringify({method,route,body})+'\\n');
if (process.env.MCP_OVERLAP && method === 'PUT' && route.startsWith('/api/experimental/mcp/') && !route.startsWith('/api/experimental/mcp/patterm_')) {
  // A native install waits for its server to connect. Each one holds until
  // every install has started, so sequential installs time out instead.
  fs.appendFileSync(process.env.MCP_OVERLAP, 'start\\n');
  const deadline = Date.now() + 10000;
  const started = () => fs.readFileSync(process.env.MCP_OVERLAP, 'utf8').split('\\n').filter((line) => line === 'start').length;
  while (started() < Number(process.env.MCP_OVERLAP_COUNT) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  fs.appendFileSync(process.env.MCP_OVERLAP, 'end\\n');
}
if (process.env.FAIL_API) { console.error(json); process.exit(1); }
 if (route === '/api/info') console.log(JSON.stringify({version:process.env.WRONG_VERSION && !(process.env.RESTARTED && fs.existsSync(process.env.RESTARTED)) ? '2.0.13' : '2.0.14',pid:4242}));
else if (method === 'GET' && route.startsWith('/api/model/default?')) console.log(JSON.stringify({data:{providerID:'openai',id:'gpt-other',modelID:'gpt-other'}}));
else if (method === 'GET' && route.startsWith('/api/model?')) console.log(JSON.stringify({data:[
  {providerID:'openai',modelID:'gpt-other',name:'GPT Other',enabled:true,variants:[{id:'low'},{id:'high'}]},
  {providerID:'openai',modelID:'gpt-test',name:'GPT Test',enabled:true,variants:[{id:'low'},{id:'high'}],limit:{context:400000,output:128000}}
]}));
else if (method === 'GET' && route.startsWith('/api/agent?')) console.log(JSON.stringify({data:[{name:'build',description:'Build'},{name:'plan',description:'Plan'}]}));
else if (method === 'GET' && route.startsWith('/api/command?')) console.log(JSON.stringify({data:[{name:'review',description:'Review changes'}, ...(process.env.CUSTOM_UNDO ? [{name:'undo',description:'Custom undo'}] : [])]}));
else if (method === 'GET' && route.startsWith('/api/mcp?')) {
  const names = new Set(rows.filter(x => x.method === 'PUT' && x.route.startsWith('/api/experimental/mcp/')).map(x => x.route.split('/').at(-1).split('?')[0]));
  console.log(JSON.stringify({data:[...names].map(name => ({name,status:{status:'connected'}}))}));
} else if (method === 'POST' && route.endsWith('/interrupt')) {
  if (process.env.FAIL_INTERRUPT) { console.log('HTTP 500 Internal Server Error'); process.exit(1); }
  console.log(JSON.stringify({data:{}}));
}
else if (method === 'POST' && route.endsWith('/prompt')) {
  if (body.delivery !== 'steer' || typeof body.text !== 'string' || body.prompt) { console.log('HTTP 400 Bad Request'); process.exit(1); }
  if (process.env.LOST_PROMPT_RESPONSE) { console.error('prompt response lost'); process.exit(1); }
  console.log(JSON.stringify({data:{id:body.id ?? 'msg_test',sessionID:'ses_test',timeCreated:1,type:'user',payload:{text:body.text,files:body.files},delivery:body.delivery}}));
}
else if (method === 'GET' && route.startsWith('/api/shell?')) console.log(JSON.stringify({data:process.env.SUBAGENT_SESSION ? [{id:'sh_bg',status:'running'}] : []}));
else if (method === 'GET' && route.startsWith('/api/shell/sh_gone')) { console.log(JSON.stringify({_tag:'ShellNotFoundError',message:'Shell command not found: sh_gone'})); console.log('HTTP 404 Not Found'); process.exit(1); }
else if (method === 'GET' && route.startsWith('/api/shell/sh_') && route.split('?')[0].endsWith('/output')) {
  const text = 'x'.repeat(300 * 1024) + 'ready' + String.fromCharCode(10);
  const query = new URLSearchParams(route.split('?')[1]);
  const cursor = Number(query.get('cursor') ?? 0);
  const limit = Number(query.get('limit') ?? text.length);
  // OpenCode 2.0.15 fails an empty read.
  if (limit === 0) { console.log('HTTP 500 Internal Server Error'); process.exit(1); }
  console.log(JSON.stringify({data:{output:text.slice(cursor, cursor + limit),cursor:Math.min(text.length, cursor + limit),size:text.length,truncated:false}}));
}
else if (method === 'GET' && route.startsWith('/api/shell/sh_')) {
  const id = route.slice('/api/shell/'.length).split('?')[0];
  console.log(JSON.stringify({data:{id,status:id === 'sh_bg' ? 'running' : 'exited',exit:id === 'sh_bg' ? undefined : 1,metadata:{sessionID:id === 'sh_foreign' ? 'ses_foreign' : 'ses_sub'}}}));
}
else if (method === 'GET' && route.startsWith('/api/session/ses_sub/message?')) {
  console.log(JSON.stringify({data:[
    {id:'msg_sub_2',type:'assistant',content:[{type:'tool',id:'call_sub_read',name:'read',state:{status:'completed',input:{filePath:'c.ts'},content:[]}}],time:{created:4}},
    {id:'msg_sub_1',type:'user',text:'Look around',time:{created:3}}
  ],cursor:{}}));
}
else if (method === 'GET' && process.env.SUBAGENT_ROOT && route === '/api/session/' + process.env.SUBAGENT_ROOT) {
  console.log(JSON.stringify({data:{id:process.env.SUBAGENT_ROOT,cost:1.25,tokens:{input:90000,output:4000,reasoning:1000,cache:{read:10000,write:0}}}}));
}
else if (method === 'GET' && route.includes('/message?')) {
  const messages = [{id:'msg_test',type:'user',text:'hello',time:{created:1}}];
  if (process.env.MANY_SUBAGENTS) {
    for (let index = 0; index < 10; index++) messages.push({id:'msg_s' + index,type:'assistant',content:[{type:'tool',id:'call_s' + index,name:'subagent',state:{status:'completed',input:{description:'Sub ' + index},metadata:{sessionID:'ses_c' + index},content:[]}}],time:{created:100 + index}});
  }
  if (process.env.SUBAGENT_SESSION) messages.push({id:'msg_task',type:'assistant',content:[
    {type:'tool',id:'call_shell',name:'shell',state:{status:'completed',input:{command:'ls'},metadata:{sessionID:process.env.SUBAGENT_ROOT},content:[]}},
    {type:'tool',id:'call_task',name:'subagent',state:{status:'running',input:{description:'Explore'},metadata:{sessionID:'ses_sub',status:'running'},content:[]}},
    {type:'tool',id:'call_bg',name:'shell',state:{status:'completed',input:{command:'npm run dev',background:true},metadata:{shellID:'sh_bg',status:'running'},content:[]}},
    {type:'tool',id:'call_done',name:'shell',state:{status:'completed',input:{command:'sleep 1',background:true},metadata:{shellID:'sh_done',status:'running'},content:[]}}
  ],model:{providerID:'openai',id:'gpt-test'},tokens:{input:3000,output:200,reasoning:0,cache:{read:17000,write:0}},time:{created:2}});
  if (process.env.COMPACTED) messages.push({id:'msg_compacted',type:'compaction',status:'completed',reason:'manual',model:{providerID:'openai',id:'gpt-test'},tokens:{input:3000,output:500,reasoning:0,cache:{read:17000,write:0}},summary:'Summary',time:{created:3}});
  for (const item of rows) {
    if (item.method !== 'POST' || !item.route.endsWith('/prompt') || typeof item.body?.id !== 'string') continue;
    messages.push({id:item.body.id,type:'user',text:String(item.body.text ?? ''),time:{created:2}});
  }
  if (process.env.MANY_MESSAGES) {
    for (let index = 0; index < 250; index++) messages.push({id:'msg_history_' + index,type:'user',text:'history ' + index,time:{created:index + 10}});
  }
  if (process.env.BIG_RESPONSE) messages.push({id:'msg_big',type:'user',text:'x'.repeat(3*1024*1024),time:{created:999}});
  if (process.env.IMAGES) {
    messages.push({id:'msg_upload',type:'user',text:'[Image 1] look',files:[{data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',mime:'image/png',source:{type:'inline'},name:'shot.png'}],time:{created:3}});
    messages.push({id:'msg_read',type:'assistant',content:[{type:'tool',id:'call_read',name:'read',state:{status:'completed',input:{path:'/tmp/shot.png'},content:[{type:'text',text:'Image read successfully'},{type:'file',uri:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',mime:'image/png',name:'/tmp/shot.png'}]}}],time:{created:4}});
  }
  if (process.env.STREAM_SEED) messages.push({id:'msg_seed',type:'assistant',content:[{type:'text',text:'Hello'}],time:{created:1}});
  if (process.env.STREAM_SEED === '2') messages.push({id:'msg_v2',type:'assistant',content:[{type:'reasoning',text:'Think'},{type:'text',text:'Hi'},{type:'tool',id:'call_1',name:'shell',state:{status:'running',input:{command:'ls'},content:[]}}],time:{created:2}});
  if (process.env.DELAYED_MESSAGE) {
    const marker = process.env.RECORD + '.delayed';
    if (!fs.existsSync(marker)) { fs.writeFileSync(marker, '1'); messages.length = 0; }
  }
  const limitMatch = /limit=([0-9]+)/.exec(route);
  const limit = limitMatch ? Number(limitMatch[1]) : messages.length;
  const offset = Number(/cursor=([0-9]+)/.exec(route)?.[1] ?? 0);
  const ordered = process.env.MANY_MESSAGES
    ? messages.slice().reverse().slice(offset, offset + limit)
    : route.includes('order=desc') ? messages.slice(-limit).reverse() : messages.slice(0, limit);
  console.log(JSON.stringify({data:ordered,cursor:process.env.MANY_MESSAGES && offset + limit < messages.length ? {next:String(offset + limit)} : {}}));
}
else if (method === 'GET' && route.startsWith('/api/permission/request?')) {
  if (!process.env.CHILD_ROOT) { console.log('HTTP 404 Not Found'); process.exit(1); }
  console.log(JSON.stringify({location:{directory:process.cwd()},data:[
    {id:'per_child',sessionID:'ses_child',action:'bash',resources:['rm -rf build'],save:['rm *'],message:'Clean the build output'},
    {id:'per_grandchild',sessionID:'ses_grandchild',action:'edit',resources:['src/a.ts'],save:[],metadata:{diff:'@@ -1 +1 @@\\n-a\\n+b'}},
    {id:'per_foreign',sessionID:'ses_foreign',action:'bash',resources:['ls']},
    {id:'per_root_dup',sessionID:process.env.CHILD_ROOT,action:'bash',resources:['pwd']}
  ]}));
}
else if (method === 'GET' && route.startsWith('/api/form?')) {
  if (!process.env.CHILD_ROOT) { console.log('HTTP 404 Not Found'); process.exit(1); }
  console.log(JSON.stringify({location:{directory:process.cwd()},data:[{id:'frm_child',sessionID:'ses_child',title:'Child form',fields:[{key:'ok',type:'boolean'}]}]}));
}
else if (method === 'GET' && ['/api/session/ses_child', '/api/session/ses_grandchild', '/api/session/ses_foreign'].includes(route)) {
  const parents = {ses_child: process.env.CHILD_ROOT, ses_grandchild: 'ses_child', ses_foreign: null};
  const id = route.split('/').at(-1);
  console.log(JSON.stringify({data:{id, parentID: parents[id] ?? undefined}}));
}
else if (method === 'GET' && route.endsWith('/inbox')) {
  console.log(JSON.stringify({data:process.env.QUEUE ? [
    {id:'msg_q1',sessionID:'ses_x',type:'user',time:{created:1},payload:{text:'Then add tests'},delivery:'queue'},
    {id:'msg_c1',sessionID:'ses_x',type:'compaction',time:{created:2},payload:{},delivery:'queue'}
  ] : []}));
}
else if (method === 'GET' && route.endsWith('/permission')) console.log(JSON.stringify({data:[]}));
else if (method === 'GET' && route.endsWith('/form')) {
  if (process.env.FORMS) console.log(JSON.stringify({data:[{id:'frm_test',sessionID:'ses_test',title:'Deploy settings',fields:[
    {key:'name',type:'string',title:'Name',required:true},
    {key:'count',type:'integer',title:'Count',minimum:1,maximum:10},
    {key:'enabled',type:'boolean',title:'Enabled',default:true},
    {key:'labels',type:'multiselect',title:'Labels',options:[{value:'a',label:'A'},{value:'b',label:'B'}],minItems:1},
    {key:'callback',type:'external',title:'Callback',url:'https://example.test/cb'}
  ]}]}));
  else console.log(JSON.stringify({data:[]}));
}
else if (method === 'POST' && route.includes('/form/') && route.endsWith('/reply')) {
  if (process.env.REJECT_FORM) { console.log(JSON.stringify({_tag:'FormInvalidAnswerError',id:'frm_test',message:'count must be positive'})); console.log('HTTP 400 Bad Request'); process.exit(1); }
  // Native 204: no response body.
}
else if (method === 'POST' && route.includes('/permission/') && route.endsWith('/reply')) {
  if (!['once', 'always', 'reject'].includes(body?.decision)) { console.log(JSON.stringify({_tag:'InvalidRequestError',message:'Missing key at ["decision"]'})); console.log('HTTP 400 Bad Request'); process.exit(1); }
}
else if (method === 'GET' && route.endsWith('/question')) { console.log('HTTP 404 Not Found'); process.exit(1); }
else if (method === 'GET' && route === '/api/session/status') {
  // Installed 2.0.1 matches this as the session lookup route with an invalid id.
  console.log('HTTP 400 Bad Request'); process.exit(1);
}
else if (method === 'GET' && route === '/api/session/active') {
  if (process.env.ACTIVE_UNSUPPORTED) { console.log('HTTP 404 Not Found'); process.exit(1); }
  if (process.env.ACTIVE_FAIL) { console.error('active snapshot failed'); process.exit(1); }
  if (process.env.ACTIVE_MALFORMED) console.log(JSON.stringify({}));
  else if (process.env.ACTIVE_EMPTY) console.log(JSON.stringify({data:{}}));
  else {
    const created = rows.filter(x => x.method === 'POST' && x.route === '/api/session');
    console.log(JSON.stringify({data:Object.fromEntries(created.map((_, index) => ['ses_' + index, {type:'running'}]))}));
  }
}
else if (method === 'PUT' && route.includes('/instructions/entries/')) {
  if (!route.startsWith('/api/experimental/session/')) { console.log('HTTP 404 Not Found'); process.exit(1); }
  console.log(JSON.stringify({data:{key:'patterm',value:body.value}}));
}
else if (method === 'POST') console.log(JSON.stringify({data:{id:'ses_'+rows.filter(x=>x.method==='POST' && x.route==='/api/session').length}}));
else if (method === 'GET') console.log(JSON.stringify({data:{location:{directory:process.cwd()},model:{providerID:'openai',id:'gpt-test',variant:'low'}}}));
`, { mode: 0o700 });
  // No discoverable background service: requests use the fake CLI and never
  // reach a real OpenCode daemon on the test machine.
  const env = { ...process.env, RECORD: record, XDG_STATE_HOME: path.join(directory, 'no-service') };
  let service = new OpenCodeServerService(database, env, { persistent: true });
  const socketPath = path.join(directory, 'mcp.sock');
  const registry = new McpToolRegistry();
  registry.register({ name: 'whoami', namespace: 'cli', description: 'Identity test', inputSchema: {} }, (_input, context) => ({ identity: context.identity }));
  const socket = new McpSocketServer(socketPath, registry, undefined, (token, id) => service.resolveIdentity(token, id));
  const clients: Client[] = [];
  let modernClient: ModernClient | null = null;
  try {
    checkHistory(directory);
    await socket.start();
    const mcp = { command: process.execPath, args: [path.resolve('dist/mcp/patterm-mcp.js')], env: { PATTERM_MCP_SOCKET: socketPath, PATTERM_MCP_IDENTITY: 'must-not-leak' } };
    const helped = { id: 'mcpsrv_helped', name: 'helped', transport: 'http' as const, url: 'https://example.com/mcp', managedHeaders: true };
    const input = { executable, cwd: directory, name: 'Fixture', context: 'Project-specific instructions', mcp, mcpServers: [helped], resumeId: null };
    const first = (await service.prepare(input)).resumeId;
    const second = (await service.prepare({ ...input, name: null, model: 'openai/gpt-test', reasoning: 'high' })).resumeId;
    assert.notEqual(first, second);
    const requests = fs.readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const sessionCreates = requests.filter((request) => request.route === '/api/session' && request.method === 'POST');
    assert.equal(sessionCreates[0]?.body.title, 'Fixture', 'a chosen name becomes the native title');
    assert.equal('title' in (sessionCreates[1]?.body ?? {}), false, 'an unnamed session is left for OpenCode to title');
    assert.deepEqual(sessionCreates[1]?.body.model, { providerID: 'openai', id: 'gpt-test', variant: 'high' }, 'Integrated OpenCode sends the selected model and reasoning variant at native session creation');
    const registrations = requests.filter((request) => request.route.startsWith('/api/experimental/mcp/patterm_') && request.method === 'PUT');
    const helpers = requests.filter((request) => request.route.startsWith('/api/experimental/mcp/helped') && request.method === 'PUT');
    assert.ok(helpers.length > 0);
    assert.ok(helpers.every((request) => JSON.stringify(request.body) === JSON.stringify(helpers[0].body)), 'every session gets the same shared helper');
    const helperEnv = helpers[0].body.config.environment as Record<string, string>;
    assert.equal(helperEnv.PATTERM_MCP_IDENTITY, undefined, 'shared helpers never carry one agent identity');
    assert.ok(helperEnv.PATTERM_OPENCODE_BRIDGE, 'shared helpers identify as the OpenCode daemon');
    assert.deepEqual(registrations[0], registrations[1], 'sessions share one stable runtime bridge');
    const bridgeEnv = registrations[0].body.config.environment as Record<string, string>;
    assert.equal(bridgeEnv.PATTERM_MCP_IDENTITY, undefined, 'never configure a shared MCP client with an agent identity');
    assert.equal(registrations[0].body.config.codemode, false, 'compact orchestration tools remain directly discoverable');
    assert.equal(requests.filter((request) => request.route.startsWith('/api/experimental/session/') && request.route.endsWith('/instructions/entries/patterm')).length, 2);
    // Replacing an unchanged server is a no-op in OpenCode, so a restart
    // reconnects it to fetch its tool list again.
    await service.prepare({ ...input, resumeId: first, reconnectMcp: true });
    const restartRequests = fs.readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).slice(requests.length);
    assert.deepEqual(restartRequests.filter((request) => request.route.startsWith('/api/experimental/mcp/helped')).map((request) => `${request.method} ${request.route.split('?')[0]}`),
      ['POST /api/experimental/mcp/helped/connect'], 'a restart reconnects an unchanged shared helper instead of replacing it');
    // After a Patterm restart the install cache is empty; the replacement may
    // be a no-op, so a restart still reconnects.
    const coldCount = fs.readFileSync(record, 'utf8').trim().split('\n').length;
    await new OpenCodeServerService(database, env, { persistent: true }).prepare({ ...input, resumeId: first, reconnectMcp: true });
    const coldRequests = fs.readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).slice(coldCount);
    assert.deepEqual(coldRequests.filter((request) => request.route.startsWith('/api/experimental/mcp/helped')).map((request) => `${request.method} ${request.route.split('?')[0]}`),
      ['PUT /api/experimental/mcp/helped', 'POST /api/experimental/mcp/helped/connect'], 'a restart reconnects even when Patterm forgot what it installed');
    // A directory the daemon has not seen installs every server; each install
    // waits for its connection, so they run together.
    const overlap = path.join(directory, 'mcp-overlap.log');
    const servers = ['one', 'two', 'three'].map((name) => ({ ...helped, id: `mcpsrv_${name}`, name: `overlap_${name}` }));
    await new OpenCodeServerService(database, { ...env, MCP_OVERLAP: overlap, MCP_OVERLAP_COUNT: String(servers.length) }, { persistent: true })
      .prepare({ ...input, cwd: fs.mkdtempSync(path.join(directory, 'fresh-')), mcp: { ...mcp, env: { ...mcp.env, PATTERM_MCP_SOCKET: `${socketPath}-fresh` } }, mcpServers: servers });
    assert.deepEqual(fs.readFileSync(overlap, 'utf8').trim().split('\n').slice(0, servers.length), servers.map(() => 'start'),
      'global MCP servers install concurrently, not one after another');
    for (const [index, id] of [first, second].entries()) {
      database.connection.prepare(`insert into processes (id,project_id,kind,name,status,created_at,updated_at) values (?, 'project_test','agent','Fixture','running',?,?)`).run(`process_${index}`, now, now);
      database.connection.prepare(`insert into sessions (id,project_id,process_id,harness,mcp_identity,resume_id,started_at,session_role,resume_status,created_by_actor) values (?, 'project_test',?,'opencode',?,?,?,'orchestrator','found','user')`).run(`session_${index}`, `process_${index}`, `identity_${index}`, id, now);
    }
    database.connection.prepare(`update sessions set interface_mode = 'integrated' where id = 'session_0'`).run();
    database.connection.prepare(`update processes set argv = ?, cwd = ? where id = 'process_0'`).run(JSON.stringify([executable]), directory);
    database.connection.prepare(`update sessions set interface_mode = 'integrated', model = 'openai/gpt-test', reasoning = 'high' where id = 'session_1'`).run();
    database.connection.prepare(`update processes set argv = ?, cwd = ? where id = 'process_1'`).run(JSON.stringify([executable]), directory);
    const presetControls = await service.controls('process_1');
    assert.equal(presetControls.selectors.find((selector) => selector.id === 'model')?.value, 'openai/gpt-test', 'the composer shows the native session model, not the global default');
    assert.equal(presetControls.selectors.find((selector) => selector.id === 'variant')?.value, 'high', 'the composer shows the native session variant');
    assert.deepEqual(await service.nativeSettings('process_1'), { model: 'openai/gpt-test', reasoning: 'low' },
      'a restart reads the variant from the native session, not the launch value');
    database.connection.prepare(`update sessions set interface_mode = 'tui' where id = 'session_1'`).run();
    assert.deepEqual(await service.prompt('process_0', { text: 'hello', references: [], attachments: [] }), { id: 'msg_test' });
    const controls = await service.controls('process_0');
    assert.deepEqual(controls.selectors.map((selector) => selector.id), ['model', 'variant', 'agent']);
    assert.deepEqual(controls.selectors[1]?.options.map((option) => option.value), ['default', 'low', 'high']);
    assert.deepEqual(controls.commands.at(-1), { name: 'review', description: 'Review changes' }, 'custom commands follow the TUI built-ins');
    await service.configure('process_0', 'agent', 'plan');
    await service.configure('process_0', 'model', 'openai/gpt-test');
    await service.configure('process_0', 'variant', 'high');
    await service.command('process_0', 'review', 'current changes');
    const controlRequests = fs.readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(controlRequests.some((request) => request.route.endsWith('/agent') && request.body.agent === 'plan'));
    assert.ok(controlRequests.some((request) => request.route.endsWith('/model') && request.body.model.id === 'gpt-test' && request.body.model.modelID === undefined));
    assert.ok(controlRequests.some((request) => request.route.endsWith('/model') && request.body.model.variant === 'high'));
    assert.ok(controlRequests.some((request) => request.route.endsWith('/command') && request.body.name === 'review' && !('command' in request.body) && request.body.delivery === 'queue'));
    assert.match(JSON.stringify(await service.conversation('process_0')), /msg_test/);
    // Project references use file URIs, including paths with URL metacharacters.
    const sourceFile = path.join(directory, 'source.ts');
    fs.writeFileSync(sourceFile, 'export const answer = 42;');
    const trickyFile = path.join(directory, 'note file #1%.txt');
    fs.writeFileSync(trickyFile, 'tricky');
    const messageId = '11111111-1111-1111-1111-111111111111';
    await service.prompt('process_0', {
      text: 'review these',
      references: [
        { path: sourceFile, name: 'source.ts', relativePath: 'source.ts' },
        { path: trickyFile, name: 'note file #1%.txt', relativePath: 'note file #1%.txt' },
        { path: directory, name: 'project/', relativePath: 'project/', directory: true }
      ],
      attachments: [],
      messageId
    });
    const promptRequests = fs.readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((request) => request.route.endsWith('/prompt'));
    const structured = promptRequests.at(-1)!.body as { text: string; files: Array<{ uri: string; name?: string }>; id?: string; delivery?: string };
    assert.equal(structured.text, 'review these');
    assert.equal(structured.delivery, 'steer', 'a prompt joins a running turn at its next step, as in OpenCode');
    assert.equal(structured.id, `msg_${messageId}`);
    assert.deepEqual(structured.files, [
      { uri: pathToFileURL(sourceFile).href, name: 'source.ts' },
      { uri: pathToFileURL(trickyFile).href, name: 'note file #1%.txt' },
      { uri: `${pathToFileURL(directory).href}/`, name: 'project/' }
    ]);

    // A message body that cannot fit one argv entry fails definitively before
    // the CLI starts; it is never an ambiguous, retryable submission.
    const promptCount = promptRequests.length;
    await assert.rejects(
      service.prompt('process_0', { text: 'x'.repeat(200_000), references: [], attachments: [], messageId: 'cccccccc-cccc-cccc-cccc-cccccccccccc' }),
      (error: unknown) => error instanceof ProviderCommandError && error.definitive === true && /too large/.test(error.message)
    );
    assert.equal(
      fs.readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((request) => request.route.endsWith('/prompt')).length,
      promptCount,
      'the oversized body never reaches the CLI'
    );
    if (process.platform === 'win32') {
      // Windows caps the whole command line at 32767 characters, far below the
      // 128 KiB POSIX argument limit, and every JSON quote costs two of them.
      for (const text of ['x'.repeat(40_000), '"'.repeat(20_000)]) {
        await assert.rejects(
          service.prompt('process_0', { text, references: [], attachments: [], messageId: 'dddddddd-dddd-dddd-dddd-dddddddddddd' }),
          (error: unknown) => error instanceof ProviderCommandError && error.definitive === true && /too large/.test(error.message)
        );
      }
    }

    // Native message listings can exceed the old 2 MiB capture bound; a 3 MiB
    // row must stay readable instead of failing the transcript read.
    const bigService = new OpenCodeServerService(database, { ...env, BIG_RESPONSE: '1' });
    const big = await bigService.conversation('process_0') as { messages: { data: Array<{ id: string; text?: string }> } };
    assert.equal(big.messages.data.at(-1)?.id, 'msg_big', 'the newest bounded row survives a response above 2 MiB');
    assert.equal(big.messages.data.at(-1)?.text?.length, 3 * 1024 * 1024);
    // Native user files and tool data URIs become stored image references.
    const imageStore = new TranscriptImageStore(path.join(directory, 'transcript-images'));
    const imageService = new OpenCodeServerService(database, { ...env, IMAGES: '1' }, { images: imageStore });
    const imageConversation = await imageService.conversation('process_0') as { messages: { data: unknown[] } };
    assert.ok(!JSON.stringify(imageConversation).includes('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), 'OpenCode image bytes never reach the renderer');
    const imageRows = normaliseMessages(imageConversation.messages);
    const uploaded = normaliseTranscriptAttachments(imageRows.find((message) => message.id === 'msg_upload')?.attachments);
    const readImage = imageRows.find((message) => message.id === 'msg_read-0')?.tool?.images?.[0];
    assert.equal(uploaded[0]?.name, 'shot.png');
    assert.equal(uploaded[0]?.sha256, readImage?.sha256, 'the uploaded and read copies share one stored image');
    assert.deepEqual(imageStore.read(String(readImage?.sha256)), { mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' });
    const activityNotifications: string[] = [];
    const integrated = new IntegratedAgentService(database, { opencode: service }, () => activityNotifications.push('changed'));
    assert.match(JSON.stringify(await integrated.conversation('process_0')), /msg_test/);
    assert.equal(
      (database.connection.prepare(`select activity from processes where id = 'process_0'`).get() as { activity: string }).activity,
      'working',
      'OpenCode busy status maps to working activity'
    );
    assert.deepEqual(activityNotifications, ['changed']);
    await integrated.conversation('process_0');
    assert.deepEqual(activityNotifications, ['changed'], 'an unchanged OpenCode activity does not notify');
    const activityOf = () => (database.connection.prepare(`select activity from processes where id = 'process_0'`).get() as { activity: string }).activity;
    const conversationRequests = fs.readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(!conversationRequests.some((request) => request.route.startsWith('/api/session/status')), 'the obsolete session status route is never called');
    assert.ok(conversationRequests.some((request) => request.route === '/api/session/active'), 'conversation reads the server-scoped active snapshot without a location query');
    await new IntegratedAgentService(database, { opencode: new OpenCodeServerService(database, { ...env, ACTIVE_EMPTY: '1' }) }).conversation('process_0');
    assert.equal(activityOf(), 'idle', 'sessions absent from the active snapshot are idle');
    database.connection.prepare(`update processes set activity = 'thinking' where id = 'process_0'`).run();
    await assert.rejects(
      new IntegratedAgentService(database, { opencode: new OpenCodeServerService(database, { ...env, ACTIVE_UNSUPPORTED: '1' }) }).conversation('process_0'),
      /OpenCode command failed/
    );
    assert.equal(activityOf(), 'thinking', 'an unsupported API cannot report activity');
    await assert.rejects(
      new IntegratedAgentService(database, { opencode: new OpenCodeServerService(database, { ...env, ACTIVE_MALFORMED: '1' }) }).conversation('process_0'),
      /invalid active-session response/
    );
    await assert.rejects(
      new IntegratedAgentService(database, { opencode: new OpenCodeServerService(database, { ...env, ACTIVE_FAIL: '1' }) }).conversation('process_0'),
      /OpenCode command failed/
    );

    // Accepted-but-response-lost: the transparent reconcile finds the recorded
    // msg_ id and reports success instead of an uncertain state.
    const lostId = '99999999-9999-9999-9999-999999999999';
    const lostService = new OpenCodeServerService(database, { ...env, LOST_PROMPT_RESPONSE: '1' });
    assert.deepEqual(
      await lostService.prompt('process_0', { text: 'lost prompt', references: [], attachments: [], messageId: lostId }),
      { id: `msg_${lostId}` },
      'the recorded message id proves admission'
    );
    // Delayed appearance: the first bounded read is empty, so the prompt stays
    // uncertain until a later read finds it.
    const delayedId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const delayedService = new OpenCodeServerService(database, { ...env, LOST_PROMPT_RESPONSE: '1', DELAYED_MESSAGE: '1' });
    await assert.rejects(
      delayedService.prompt('process_0', { text: 'delayed prompt', references: [], attachments: [], messageId: delayedId }),
      UncertainDeliveryError
    );
    assert.equal(await delayedService.reconcile('process_0', delayedId), 'accepted', 'delayed appearance is accepted later');
    // Definitive rejection: a 4xx never recorded the prompt.
    const rejectedId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const rejectedService = new OpenCodeServerService(database, { ...env, REJECT_PROMPT: '1' });
    await assert.rejects(
      rejectedService.prompt('process_0', { text: 'rejected prompt', references: [], attachments: [], messageId: rejectedId }),
      (error: unknown) => error instanceof Error && !(error instanceof UncertainDeliveryError)
    );
    assert.equal(await rejectedService.reconcile('process_0', rejectedId), 'unknown');
    // A restart's idle compaction check reads OpenCode's native row times,
    // and a session with a running execution is active now.
    // The newest is a prompt sent earlier in this test, at native time 2.
    assert.equal(await new IntegratedAgentService(database, { opencode: new OpenCodeServerService(database, { ...env, ACTIVE_EMPTY: '1' }) }).lastActivity('process_0'), 2);
    const beforeActive = Date.now();
    assert.ok((await new IntegratedAgentService(database, { opencode: new OpenCodeServerService(database, env) }).lastActivity('process_0'))! >= beforeActive);
    // A 4xx rejects a compaction definitively, as it does a prompt; a 5xx may
    // have queued it.
    await assert.rejects(new OpenCodeServerService(database, { ...env, REJECT_COMPACT: '409 Conflict' }).compact('process_0'),
      (error: unknown) => error instanceof ProviderCommandError && error.status === 409 && error.definitive);
    await assert.rejects(new OpenCodeServerService(database, { ...env, REJECT_COMPACT: '502 Bad Gateway' }).compact('process_0'),
      (error: unknown) => error instanceof ProviderCommandError && error.status === 502 && !error.definitive);

    // A session longer than one bounded page still shows its newest rows.
    const manyService = new OpenCodeServerService(database, { ...env, MANY_MESSAGES: '1' });
    const many = await manyService.conversation('process_0') as { messages: { data: Array<{ id: string }> }; history_truncated: boolean; history_cursor: { next: string } };
    assert.equal(many.history_truncated, true, 'a full page is reported as truncated history');
    assert.equal(many.messages.data.at(-1)?.id, 'msg_history_249', 'the newest row is displayed');
    assert.ok(!many.messages.data.some((message) => message.id === 'msg_history_0'), 'the oldest rows are outside the bounded page');
    const older = await manyService.olderMessages('process_0', many.history_cursor.next) as { messages: { data: Array<{ id: string }> }; cursor: string | null };
    assert.equal(older.messages.data[0]?.id, 'msg_history_0', 'older page starts before the live window');
    assert.equal(older.messages.data.at(-1)?.id, 'msg_history_49', 'older page is chronological');
    assert.equal(older.cursor, '250', 'the provider cursor advances to the final older page');
    const oldest = await manyService.olderMessages('process_0', older.cursor!) as { messages: { data: Array<{ id: string }> }; cursor: string | null };
    assert.equal(oldest.messages.data[0]?.id, 'msg_test');
    assert.equal(oldest.cursor, null);

    // Installed 2.0.1 typed forms: the list is returned as native field shapes
    // and replies keep each field's own JSON type.
    const formService = new OpenCodeServerService(database, { ...env, FORMS: '1' });
    const formConversation = await formService.conversation('process_0') as { forms: { data: Array<{ id: string; title: string; fields: Array<{ key: string; type: string; minimum?: number }> }> } };
    const form = formConversation.forms.data[0]!;
    assert.equal(form.id, 'frm_test');
    assert.equal(form.title, 'Deploy settings');
    assert.deepEqual(form.fields.map((field) => [field.key, field.type]), [
      ['name', 'string'], ['count', 'integer'], ['enabled', 'boolean'], ['labels', 'multiselect'], ['callback', 'external']
    ]);
    assert.equal(form.fields[1]?.minimum, 1);
    await formService.replyForm('process_0', 'frm_test', { name: 'Patterm', count: 3, enabled: true, labels: ['a', 'b'] });
    const formReply = fs.readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      .find((request) => request.route.endsWith('/form/frm_test/reply'));
    assert.deepEqual(formReply.body, { answer: { name: 'Patterm', count: 3, enabled: true, labels: ['a', 'b'] } }, 'form answers keep native JSON types');
    const rejectedForm = new OpenCodeServerService(database, { ...env, FORMS: '1', REJECT_FORM: '1' });
    await assert.rejects(
      rejectedForm.replyForm('process_0', 'frm_test', { count: -1 }),
      /count must be positive/,
      'native form validation messages are surfaced'
    );

    // Queued prompts come from the native inbox and can be steered or cancelled.
    const queueService = new OpenCodeServerService(database, { ...env, QUEUE: '1' });
    const queued = await queueService.conversation('process_0') as { queue: unknown };
    assert.deepEqual(queued.queue, [{ id: 'msg_q1', text: 'Then add tests', delivery: 'queue' }], 'only queued user prompts are listed');
    await queueService.updateQueued('process_0', 'msg_q1', 'steer');
    await queueService.updateQueued('process_0', 'msg_q1', 'cancel');
    const queueCalls = fs.readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { method: string; route: string; body?: unknown }).slice(-2);
    assert.deepEqual(queueCalls.map((call) => [call.method, call.route.split('/').slice(-2).join('/'), call.body]), [
      ['PATCH', 'inbox/msg_q1', { delivery: 'steer' }],
      ['DELETE', 'inbox/msg_q1', undefined]
    ]);

    // TUI built-ins are session API calls; custom commands still run natively.
    const commandService = new OpenCodeServerService(database, env);
    const commandRoot = (database.connection.prepare(`select resume_id from sessions where process_id = 'process_0'`).get() as { resume_id: string }).resume_id;
    assert.deepEqual((await commandService.controls('process_0')).commands.map((command) => command.name), ['compact', 'undo', 'redo', 'rename', 'shell', 'review']);
    await commandService.command('process_0', 'compact', '');
    await commandService.command('process_0', 'rename', 'Auth work');
    await commandService.command('process_0', 'shell', 'ls -la');
    await commandService.command('process_0', 'redo', '');
    await commandService.command('process_0', 'review', 'focus');
    await assert.rejects(commandService.command('process_0', 'undo', ''), /Stop the running turn/, 'undo never reverts a running turn');
    const idleCommands = new OpenCodeServerService(database, { ...env, ACTIVE_EMPTY: '1' });
    await idleCommands.command('process_0', 'undo', '');
    const commandCalls = fs.readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { method: string; route: string; body?: Record<string, unknown> })
      .filter((call) => call.method !== 'GET').slice(-6);
    const staged = commandCalls[5]?.body?.messageID;
    assert.ok(typeof staged === 'string' && staged.startsWith('msg_'), 'undo stages the newest user message');
    assert.deepEqual(commandCalls.map((call) => [call.method, call.route.replace(commandRoot, 'ROOT'), call.body]), [
      ['POST', '/api/session/ROOT/compact', { delivery: 'queue' }],
      ['PATCH', '/api/session/ROOT', { title: 'Auth work' }],
      ['POST', '/api/session/ROOT/shell', { command: 'ls -la' }],
      ['DELETE', '/api/session/ROOT/revert', undefined],
      ['POST', '/api/session/ROOT/command', { name: 'review', text: 'focus', delivery: 'queue' }],
      ['POST', '/api/session/ROOT/revert/stage', { messageID: staged }]
    ], 'built-ins call the session API; undo stages like the TUI and is never committed');
    const customUndo = new OpenCodeServerService(database, { ...env, CUSTOM_UNDO: '1' });
    await customUndo.command('process_0', 'undo', 'last');
    const customCall = fs.readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { method: string; route: string; body?: unknown }).filter((call) => call.method !== 'GET').at(-1);
    assert.deepEqual([customCall?.route.endsWith('/command'), customCall?.body], [true, { name: 'undo', text: 'last', delivery: 'queue' }], 'a custom command with a built-in name wins');

    // Subagent sessions nest under the subagent tool that started them. A shell
    // tool's own sessionID is not a subagent.
    const nestedService = new OpenCodeServerService(database, { ...env, SUBAGENT_SESSION: '1', SUBAGENT_ROOT: (database.connection.prepare(`select resume_id from sessions where process_id = 'process_0'`).get() as { resume_id: string }).resume_id });
    const nestedView = await nestedService.conversation('process_0') as { usage: unknown; messages: { data: Array<{ id: string; parentId?: string }> } };
    assert.deepEqual((nestedView as unknown as { tasks: unknown }).tasks, [
      { id: 'ses_sub', label: 'Explore', kind: 'subagent', status: 'running', stoppable: true },
      { id: 'sh_bg', label: 'npm run dev', kind: 'shell', status: 'running', stoppable: false },
      { id: 'sh_done', label: 'sleep 1', kind: 'shell', status: 'completed', stoppable: false }
    ], 'a running subagent is a stoppable task; background shells are tasks the daemon reports as running or not');
    // A shell's output is the end of its file, read through the daemon; the
    // shell must belong to this session or one of its subagents.
    const shellOutput = await nestedService.taskOutput('process_0', 'sh_done');
    assert.ok(shellOutput.format === 'text' && shellOutput.truncated && shellOutput.text.endsWith('ready\n\n[exited with code 1]\n') && shellOutput.text.length === 256 * 1024 + '\n[exited with code 1]\n'.length, 'the last 256 KiB of a finished shell');
    const runningShell = await nestedService.taskOutput('process_0', 'sh_bg');
    assert.ok(runningShell.format === 'text' && runningShell.text.endsWith('ready\n'), 'a running shell has no exit line');
    await assert.rejects(nestedService.taskOutput('process_0', 'sh_foreign'), /does not belong/, 'another session\'s shell is never read');
    assert.equal((await nestedService.taskOutput('process_0', 'sh_gone')).format, 'missing', 'a removed shell has no output');
    await nestedService.stopTask('process_0', 'ses_sub');
    assert.ok(fs.readFileSync(record, 'utf8').includes('"route":"/api/session/ses_sub/interrupt"'), 'Stop interrupts only the subagent session');
    await assert.rejects(nestedService.stopTask('process_0', 'ses_foreign'), /does not belong/);
    // The task drawer reads the subagent's own messages, oldest first.
    const subOutput = await nestedService.taskOutput('process_0', 'ses_sub');
    assert.ok(subOutput.format === 'messages');
    assert.deepEqual(subOutput.messages.map((row) => (row as { id: string }).id), ['msg_sub_1', 'msg_sub_2'], 'task output is the subagent session, oldest first');
    assert.equal(subOutput.cursor, null, 'a short subagent has no earlier page');
    assert.equal((await nestedService.taskOutput('process_0', 'ses_sub', subOutput.version)).format, 'unchanged', 'an unchanged subagent skips its rows');
    await assert.rejects(nestedService.taskOutput('process_0', 'ses_foreign'), /does not belong/, 'another session is never read');
    assert.deepEqual(nestedView.usage, { contextTokens: 20_000, contextWindow: 400_000, inputTokens: 100_000, outputTokens: 5_000, costUsd: 1.25, lastModelActivityAt: new Date(2).toISOString() }, 'session totals, latest context, the model window, and the newest request start are reported');
    const compactedView = await new OpenCodeServerService(database, { ...env, SUBAGENT_SESSION: '1', COMPACTED: '1', SUBAGENT_ROOT: (database.connection.prepare(`select resume_id from sessions where process_id = 'process_0'`).get() as { resume_id: string }).resume_id }).conversation('process_0') as { usage: Record<string, unknown> };
    assert.equal(compactedView.usage.contextTokens, undefined, 'a newer compaction drops the stale context');
    assert.equal(compactedView.usage.contextWindow, 400_000, 'the window still comes from the compaction model');
    assert.deepEqual(nestedView.messages.data.filter((row) => row.parentId).map((row) => [row.id, row.parentId]), [['msg_sub_1', 'msg_task-1'], ['msg_sub_2', 'msg_task-1']]);
    const nestedRoutes = fs.readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { route: string });
    assert.ok(!nestedRoutes.some((request) => request.route.startsWith(`/api/session/${(database.connection.prepare(`select resume_id from sessions where process_id = 'process_0'`).get() as { resume_id: string }).resume_id}/message?limit=40`)), 'a shell tool session is not read as a subagent');

    // The newest subagents are the ones kept, and each can be stopped.
    const manySubagents = new OpenCodeServerService(database, { ...env, MANY_SUBAGENTS: '1' });
    const beforeMany = fs.readFileSync(record, 'utf8').trim().split('\n').length;
    await manySubagents.conversation('process_0');
    const childReads = fs.readFileSync(record, 'utf8').trim().split('\n').slice(beforeMany).map((line) => JSON.parse(line) as { route: string })
      .flatMap((call) => /^\/api\/session\/(ses_c\d+)\/message/.exec(call.route)?.[1] ?? []).sort();
    assert.deepEqual(childReads, ['ses_c2', 'ses_c3', 'ses_c4', 'ses_c5', 'ses_c6', 'ses_c7', 'ses_c8', 'ses_c9'], 'the newest eight subagents keep their nesting');
    await manySubagents.stopTask('process_0', 'ses_c9');

    // Subagent sessions: their requests pause the parent turn, so descendants
    // (not unrelated daemon sessions) are shown, labelled, and replied to on
    // the owning session.
    const root = (database.connection.prepare(`select resume_id from sessions where process_id = 'process_0'`).get() as { resume_id: string }).resume_id;
    const childService = new OpenCodeServerService(database, { ...env, CHILD_ROOT: root });
    const childView = await childService.conversation('process_0') as { permissions: { data: Array<{ id: string; action: string }> }; forms: { data: Array<{ id: string; detail?: string; declinable?: boolean }> } };
    assert.deepEqual(childView.permissions.data.map((item) => [item.id, item.action]), [['per_child', 'Subagent: bash'], ['per_grandchild', 'Subagent: edit']]);
    assert.equal((childView as { status?: string }).status, 'permission', 'a subagent waiting on the user reads as permission');
    const [childPermission, grandchildPermission] = childView.permissions.data as Array<Record<string, unknown>>;
    assert.equal(childPermission?.detail, 'Clean the build output', 'the agent message explains the request');
    assert.equal(childPermission?.always_label, 'Always allow rm *', 'Always names the pattern it saves');
    assert.equal(grandchildPermission?.always, false, 'Always is hidden when there is no pattern to save');
    assert.equal(grandchildPermission?.patch, '@@ -1 +1 @@\n-a\n+b', 'an edit request previews its diff');
    assert.equal(childPermission?.feedback, true);
    assert.deepEqual(childView.forms.data.map((item) => [item.id, item.detail, item.declinable]), [['frm_child', 'Requested by a subagent', true]]);
    await childService.replyPermission('process_0', 'per_grandchild', 'once');
    await childService.replyForm('process_0', 'frm_child', {}, 'decline');
    const childRoutes = fs.readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { method: string; route: string });
    assert.ok(childRoutes.some((request) => request.method === 'POST' && request.route === '/api/session/ses_grandchild/permission/per_grandchild/reply'), 'a subagent permission is answered on its own session');
    assert.ok(childRoutes.some((request) => request.method === 'DELETE' && request.route === '/api/session/ses_child/form/frm_child'), 'declining a form cancels it natively');

    // Native event stream: discovery from the CLI's service registration,
    // Basic auth, session scoping, and automatic reconnect.
    const daemonResponses = new Set<http.ServerResponse>();
    const daemonState: FakeDaemonState = {
      connections: 0, auth: '', prompts: [], messageReads: 0, emit: () => {}, write: () => {},
      burst: true, active: { [first]: { type: 'running' } }, rows: null, permissions: [], shells: []
    };
    const daemonFrame = (type: string, data: unknown): string => `data: ${JSON.stringify({ id: `evt_${daemonState.connections}`, type, data })}\n\n`;
    const daemon = http.createServer((request, response) => {
      daemonState.auth = String(request.headers.authorization ?? '');
      if (request.url === '/api/info') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ version: '2.0.14', pid: 4242 }));
        return;
      }
      if (request.method === 'POST' && request.url?.endsWith('/prompt')) {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          daemonState.prompts.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ data: { id: 'msg_inline' } }));
        });
        return;
      }
      // A discovered daemon serves ordinary API reads over HTTP, not the CLI.
      if (request.method === 'GET' && request.url?.startsWith(`/api/session/${first}/message?`)) {
        daemonState.messageReads += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: daemonState.rows ?? [
          { id: 'msg_v2', type: 'assistant', content: [{ type: 'reasoning', text: 'Think' }, { type: 'text', text: 'Hi' }, { type: 'tool', id: 'call_1', name: 'shell', state: { status: 'running', input: { command: 'ls' }, content: [] } }], time: { created: 2 } },
          { id: 'msg_seed', type: 'assistant', content: [{ type: 'text', text: 'Hello' }], time: { created: 1 } }
        ], cursor: {} }));
        return;
      }
      if (request.method === 'GET' && (request.url === `/api/session/${first}/permission` || request.url === `/api/session/${first}/form`)) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: request.url.endsWith('/permission') ? daemonState.permissions : [] }));
        return;
      }
      if (request.method === 'GET' && request.url === '/api/session/active') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: daemonState.active }));
        return;
      }
      if (request.method === 'GET' && request.url?.startsWith('/api/shell?')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: daemonState.shells }));
        return;
      }
      if (request.method === 'POST' && request.url === `/api/session/${first}/agent`) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ _tag: 'InvalidRequestError', message: 'Unknown agent' }));
        return;
      }
      if (request.url === '/api/event') {
        daemonState.connections += 1;
        daemonResponses.add(response);
        response.on('close', () => daemonResponses.delete(response));
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const frame = (type: string, data: unknown, created?: number): string => `data: ${JSON.stringify({ id: `evt_${daemonState.connections}`, type, data, ...(created !== undefined ? { created } : {}) })}\n\n`;
        const send = (type: string, data: unknown, created?: number): void => { response.write(frame(type, data, created)); };
        // Later events reach every open stream, as the daemon's do.
        daemonState.write = (raw) => { for (const open of daemonResponses) open.write(raw); };
        daemonState.emit = (type, data, created) => daemonState.write(frame(type, data, created));
        send('server.connected', {});
        if (!daemonState.burst) return;
        send('message.part.delta', { sessionID: 'ses_other', messageID: 'm', partID: 'p', field: 'text', delta: 'leak' });
        send('session.execution.started', { sessionID: first });
        send('form.created', { form: { id: 'frm_live', sessionID: first, title: 'Live form', fields: [] } });
        send('message.part.delta', { sessionID: first, messageID: 'm', partID: 'p', field: 'text', delta: 'live' });
        send('session.idle', { sessionID: first });
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => daemon.listen(0, '127.0.0.1', () => resolve()));
    const daemonPort = (daemon.address() as AddressInfo).port;
    fs.mkdirSync(path.join(directory, 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'opencode', 'service.json'), JSON.stringify({
      id: 'daemon_test', version: '2.0.14', url: `http://127.0.0.1:${daemonPort}`, pid: 4242, password: 'test-password'
    }));
    const streamService = new OpenCodeServerService(database, { ...env, XDG_STATE_HOME: directory, STREAM_SEED: '2' });
    const imageBytes = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(150_000)]);
    await streamService.prompt('process_0', { text: 'inspect', references: [], attachments: [{ path: path.join(directory, 'uploads', 'pixel.png'), name: 'pixel.png', mime: 'image/png', size: imageBytes.length, data: imageBytes.toString('base64') }] });
    assert.deepEqual(daemonState.prompts, [{ text: 'inspect', files: [{ uri: `data:image/png;base64,${imageBytes.toString('base64')}`, name: 'pixel.png' }], delivery: 'steer', resume: true }], 'uploads use inline data, and prompts steer as in OpenCode');
    assert.equal(daemonState.auth, `Basic ${Buffer.from('opencode:test-password').toString('base64')}`, 'inline uploads use the authenticated daemon');
    const streamed: IntegratedConversationEvent[] = [];
    const releaseStream = await streamService.subscribe('process_0', (event) => streamed.push(event));
    await waitFor(() => streamed.some((event) => event.kind === 'status' && event.status === 'idle'));
    assert.equal(daemonState.auth, `Basic ${Buffer.from('opencode:test-password').toString('base64')}`, 'the event stream uses the daemon Basic credential');
    assert.ok(streamed.some((event) => event.kind === 'status' && event.status === 'working'), 'execution start maps to working');
    assert.ok(streamed.some((event) => event.kind === 'pending'), 'message, form, and permission events trigger a snapshot refresh');
    assert.ok(!JSON.stringify(streamed).includes('leak'), 'events for another session are not surfaced');
    const streamRevisions = streamed.map((event) => event.revision);
    assert.deepEqual(streamRevisions, [...streamRevisions].sort((left, right) => left - right), 'event revisions are ordered');

    // Targeted streaming: native part events update only their row, and a
    // stream of deltas does not trigger another full-snapshot cycle.
    const messageReads = (): number => daemonState.messageReads + fs.readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      .filter((request) => typeof request.route === 'string' && request.route.includes('/message?')).length;
    assert.ok(daemonState.messageReads > 0, 'the subscription seed reads the discovered daemon over HTTP');
    const beforeTargeted = streamed.length;
    const readsBefore = messageReads();
    daemonState.emit('message.part.updated', { sessionID: first, part: { id: 'prt_seed', messageID: 'msg_seed', type: 'text', text: 'Hello' } });
    daemonState.emit('message.part.delta', { sessionID: first, messageID: 'msg_seed', partID: 'prt_seed', field: 'text', delta: ' world' });
    daemonState.emit('message.part.updated', { sessionID: first, part: { id: 'prt_new', messageID: 'msg_seed', type: 'text', text: 'New part' } });
    daemonState.emit('message.part.updated', { sessionID: first, part: { id: 'prt_tool', messageID: 'msg_seed', type: 'tool', name: 'bash', state: { status: 'running', input: {} } } });
    daemonState.emit('message.part.delta', { sessionID: first, messageID: 'msg_seed', partID: 'prt_tool', field: 'input', delta: '{"command":' });
    daemonState.emit('message.part.updated', { sessionID: first, part: { id: 'prt_tool', messageID: 'msg_seed', type: 'tool', name: 'bash', state: { status: 'completed', input: { command: 'echo hi' }, content: [{ type: 'text', text: 'hi' }] } } });
    await waitFor(() => streamed.some((event) => event.kind === 'append' && event.id === 'msg_seed-0'));
    const targeted = streamed.slice(beforeTargeted);
    assert.ok(targeted.some((event) => event.kind === 'replace' && event.message?.id === 'msg_seed-0'), 'a seeded part maps to its snapshot row');
    assert.ok(targeted.some((event) => event.kind === 'append' && event.id === 'msg_seed-0' && event.delta === ' world'), 'text deltas append to the affected row');
    assert.ok(targeted.some((event) => event.kind === 'replace' && event.message?.id === 'msg_seed-1' && event.message.text === 'New part'), 'a new part appends at the next index');
    const toolEvents = targeted.filter((event) => event.message?.id === 'msg_seed-2');
    assert.ok(toolEvents.some((event) => typeof event.message?.tool?.input === 'string'), 'tool input streams as a partial string');
    assert.ok(toolEvents.some((event) => event.message?.text === 'hi' && (event.message?.tool?.state as { status?: string } | undefined)?.status === 'completed'), 'tool completion replaces the row');
    assert.ok(!targeted.some((event) => event.kind === 'pending'), 'no full-snapshot cycle for part deltas');
    assert.equal(messageReads(), readsBefore, 'part deltas do not re-read the message snapshot');

    // Native V2 contracts captured from OpenCode: family
    // ordinals (reasoning and text both start at zero), the tool call id, and
    // the user admission row. Each maps onto its native content index.
    const beforeV2 = streamed.length;
    const readsBeforeV2 = messageReads();
    daemonState.emit('session.reasoning.started', { sessionID: first, assistantMessageID: 'msg_v2', ordinal: 0, state: { reasoningField: 'reasoning_content' } });
    daemonState.emit('session.reasoning.delta', { sessionID: first, assistantMessageID: 'msg_v2', ordinal: 0, delta: ' more' });
    daemonState.emit('session.reasoning.ended', { sessionID: first, assistantMessageID: 'msg_v2', ordinal: 0, text: 'Think more' }, 5_000);
    daemonState.emit('session.text.started', { sessionID: first, assistantMessageID: 'msg_v2', ordinal: 0 });
    daemonState.emit('session.text.delta', { sessionID: first, assistantMessageID: 'msg_v2', ordinal: 0, delta: ' there' });
    daemonState.emit('session.text.ended', { sessionID: first, assistantMessageID: 'msg_v2', ordinal: 0, text: 'Hi there' }, 6_000);
    daemonState.emit('session.tool.input.started', { sessionID: first, assistantMessageID: 'msg_v2', id: 'call_1', name: 'shell' });
    daemonState.emit('session.tool.input.ended', { sessionID: first, assistantMessageID: 'msg_v2', id: 'call_1', text: '{"command":"ls"}' });
    daemonState.emit('session.tool.called', { sessionID: first, assistantMessageID: 'msg_v2', id: 'call_1', input: { command: 'ls' }, executed: false });
    daemonState.emit('session.tool.progress', { sessionID: first, assistantMessageID: 'msg_v2', id: 'call_1', metadata: { shellID: 'sh_1' } });
    daemonState.emit('session.tool.success', { sessionID: first, assistantMessageID: 'msg_v2', id: 'call_1', content: [{ type: 'text', text: 'ls output' }], metadata: { status: 'completed', truncated: false, exit: 0 }, executed: false }, 7_000);
    daemonState.emit('session.inbox.enqueued', { sessionID: first, inboxID: 'msg_inbox_1', item: { type: 'user', payload: { text: 'run ls', delivery: 'queue' } } }, 8_000);
    await waitFor(() => streamed.some((event) => event.kind === 'replace' && event.message?.id === 'msg_v2-2' && event.message.text === 'ls output'));
    const v2 = streamed.slice(beforeV2);
    assert.ok(v2.some((event) => event.kind === 'append' && event.id === 'msg_v2-0' && event.delta === ' more'), 'reasoning ordinal 0 maps to its content index');
    assert.ok(v2.some((event) => event.kind === 'replace' && event.message?.id === 'msg_v2-0' && event.message.kind === 'reasoning' && event.message.text === 'Think more'), 'reasoning completion reconciles the row');
    assert.ok(v2.some((event) => event.kind === 'append' && event.id === 'msg_v2-1' && event.delta === ' there'), 'text ordinal 0 maps to a different content index than reasoning ordinal 0');
    assert.ok(v2.some((event) => event.kind === 'replace' && event.message?.id === 'msg_v2-1' && event.message.kind === 'text' && event.message.text === 'Hi there'), 'text completion reconciles the row');
    const v2Tool = v2.filter((event) => event.message?.id === 'msg_v2-2');
    assert.ok(v2Tool.some((event) => event.message?.tool?.input !== undefined && (event.message.tool.state as { status?: string } | undefined)?.status === 'running'), 'the native tool call id maps to its content index');
    assert.ok(v2Tool.some((event) => event.message?.text === 'ls output' && (event.message.tool?.state as { status?: string } | undefined)?.status === 'completed'), 'tool success replaces output and state');
    assert.ok(v2.some((event) => event.kind === 'replace' && event.message?.id === 'msg_inbox_1' && event.message.role === 'user' && event.message.text === 'run ls'), 'user admission keeps the native inbox id');
    assert.ok(!v2.some((event) => event.kind === 'pending'), 'native V2 events never force a full-snapshot cycle');
    // Row times: seeded rows start with their native message, and an ended
    // event's envelope time finishes them. Events without one use the host clock.
    const lastFor = (id: string) => [...v2].reverse().find((event) => event.kind === 'replace' && event.message?.id === id)?.message;
    const iso = (ms: number): string => new Date(ms).toISOString();
    assert.deepEqual([lastFor('msg_v2-0')?.createdAt, lastFor('msg_v2-0')?.completedAt], [iso(2), iso(5_000)], 'reasoning keeps its native start and ends with its event');
    assert.deepEqual([lastFor('msg_v2-1')?.createdAt, lastFor('msg_v2-1')?.completedAt], [iso(2), iso(6_000)]);
    assert.deepEqual([lastFor('msg_v2-2')?.createdAt, lastFor('msg_v2-2')?.completedAt], [iso(2), iso(7_000)], 'a tool finishes when it succeeds');
    assert.deepEqual([lastFor('msg_inbox_1')?.createdAt, lastFor('msg_inbox_1')?.completedAt], [iso(8_000), iso(8_000)], 'a user admission uses its event time');
    assert.equal(messageReads(), readsBeforeV2, 'native V2 streaming does not re-read the message snapshot');

    // A subagent's live content nests under its tool row; its idle status is
    // its own and does not settle this session.
    const beforeChild = streamed.length;
    daemonState.emit('session.tool.input.started', { sessionID: first, assistantMessageID: 'msg_v2', id: 'call_sub', name: 'subagent' });
    daemonState.emit('session.tool.progress', { sessionID: first, assistantMessageID: 'msg_v2', id: 'call_sub', metadata: { sessionID: 'ses_live_child', status: 'running' } });
    daemonState.emit('session.text.started', { sessionID: 'ses_live_child', assistantMessageID: 'msg_child', ordinal: 0 });
    daemonState.emit('session.text.delta', { sessionID: 'ses_live_child', assistantMessageID: 'msg_child', ordinal: 0, delta: 'child text' });
    daemonState.emit('session.text.ended', { sessionID: 'ses_live_child', assistantMessageID: 'msg_child', ordinal: 0, text: 'child text' });
    daemonState.emit('session.idle', { sessionID: 'ses_live_child' });
    await waitFor(() => streamed.slice(beforeChild).some((event) => event.kind === 'replace' && event.message?.text === 'child text'));
    const childEvents = streamed.slice(beforeChild);
    const subRow = childEvents.find((event) => event.kind === 'replace' && event.message?.tool?.name === 'subagent')?.message?.id;
    assert.ok(subRow, 'the subagent tool row streams');
    assert.equal(childEvents.find((event) => event.kind === 'replace' && event.message?.text === 'child text')?.message?.parentId, subRow, 'child content nests under the subagent row');
    const childText = [...childEvents].reverse().find((event) => event.kind === 'replace' && event.message?.text === 'child text')?.message;
    assert.ok(childText?.createdAt && childText.completedAt, 'without an envelope time the host clock stamps live rows');
    assert.ok(!childEvents.some((event) => event.kind === 'status'), 'a subagent going idle does not settle the parent');

    // Dropping the daemon connection reconnects on its own and hands the
    // renderer a fresh snapshot boundary.
    for (const response of daemonResponses) response.destroy();
    await waitFor(() => daemonState.connections >= 2, 4_000);
    assert.ok(streamed.some((event) => event.kind === 'reconnecting'), 'a dropped stream is announced');
    releaseStream();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const connectionsAfterRelease = daemonState.connections;
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(daemonState.connections, connectionsAfterRelease, 'releasing the subscription stops reconnecting');
    // Conversation reads use the verified daemon over HTTP, in parallel, and
    // never start a CLI process.
    const cliCallsBefore = fs.readFileSync(record, 'utf8').trim().split('\n').length;
    // The stream last reported this session's end; the daemon agrees.
    daemonState.active = {};
    const httpConversation = await streamService.conversation('process_0') as { status: string; messages: { data: Array<{ id: string }> } };
    assert.equal(httpConversation.status, 'idle');
    assert.deepEqual(httpConversation.messages.data.map((message) => message.id), ['msg_seed', 'msg_v2']);
    assert.equal(fs.readFileSync(record, 'utf8').trim().split('\n').length, cliCallsBefore, 'daemon reads do not spawn the CLI');
    await assert.rejects(
      streamService.configure('process_0', 'agent', 'missing'),
      (error: unknown) => error instanceof ProviderCommandError && error.status === 400 && error.message === 'Unknown agent',
      'native HTTP errors keep their status and tagged message'
    );
    try {
      await checkStreamedActivity({ database, env: { ...env, XDG_STATE_HOME: directory }, first, daemonState, daemonResponses, daemonFrame, waitFor });
      await checkActivityOrdering(database, env);
    } catch (error) {
      // An open stream would keep the process alive after a failure.
      daemon.closeAllConnections();
      daemon.close();
      throw error;
    }
    await new Promise<void>((resolve) => daemon.close(() => resolve()));
    // A daemon that has gone away is rediscovered; without a live service the
    // CLI transport takes over.
    assert.match(JSON.stringify(await streamService.conversation('process_0')), /msg_seed/);
    assert.ok(fs.readFileSync(record, 'utf8').trim().split('\n').length > cliCallsBefore, 'a stale daemon falls back to the CLI');
    await service.replyPermission('process_0', 'per_test', 'once');
    assert.deepEqual(fs.readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((request: { route: string }) => request.route.endsWith('/permission/per_test/reply')).at(-1)?.body, { decision: 'once' });
    await assert.rejects(service.replyQuestion('process_0', 'que_test', [['Yes']]), /native forms/);
    assert.throws(() => service.resolveIdentity('wrong', first), /Invalid/);
    assert.throws(() => service.resolveIdentity(bridgeEnv.PATTERM_OPENCODE_BRIDGE, 'ses_unmanaged'), /not attached/);
    await assert.rejects(service.prepare({ ...input, resumeId: first }), /already attached/);
    const client = new Client({ name: 'bridge-test', version: '1' });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: mcp.args, env: bridgeEnv, stderr: 'pipe' }));
    const identities = await Promise.all([first, second].map((id) => client.callTool({ name: 'whoami', arguments: {}, _meta: { sessionID: id } })));
    assert.match(JSON.stringify(identities[0]), /identity_0/);
    assert.match(JSON.stringify(identities[1]), /identity_1/);
    modernClient = new ModernClient({ name: 'modern-bridge-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await modernClient.connect(new ModernTransport({ command: process.execPath, args: mcp.args, env: bridgeEnv, stderr: 'pipe' }));
    assert.match(JSON.stringify(await modernClient.callTool({ name: 'whoami', arguments: {}, _meta: { sessionID: first } })), /identity_0/, 'modern requests retain the OpenCode session identity');
    assert.match(JSON.stringify(await modernClient.callTool({ name: 'whoami', arguments: {}, _meta: { 'ai.opencode/sessionID': second } })), /identity_1/, 'OpenCode 2 namespaced session metadata resolves the caller');
    assert.equal((await modernClient.callTool({ name: 'whoami', arguments: {} })).isError, true, 'modern requests without session metadata fail closed');
    socket.stop();
    service = new OpenCodeServerService(database, env, { persistent: true });
    await socket.start();
    assert.match(JSON.stringify(await client.callTool({ name: 'whoami', arguments: {}, _meta: { sessionID: first } })), /identity_0/, 'existing bridge clients keep their identity after a backend restart');
    const tokenPath = path.join(directory, 'opencode-bridge-token');
    // Windows has no POSIX modes; the data directory's profile ACL protects the credential there.
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600, 'the durable bridge credential is owner-only');
      fs.chmodSync(tokenPath, 0o644);
      assert.throws(() => new OpenCodeServerService(database, env, { persistent: true }), /owner-only/);
      fs.chmodSync(tokenPath, 0o600);
    } else {
      assert.match(fs.readFileSync(tokenPath, 'utf8'), /^[0-9a-f-]{36}$/, 'the durable bridge credential is saved');
      assert.doesNotThrow(() => new OpenCodeServerService(database, env, { persistent: true }), 'a saved credential is accepted despite synthesised modes');
    }
    assert.equal((await client.callTool({ name: 'whoami', arguments: {} })).isError, true, 'missing metadata fails closed');
    assert.equal((await client.callTool({ name: 'whoami', arguments: {}, _meta: { sessionID: 'ses_unmanaged' } })).isError, true);
    database.connection.prepare(`update sessions set exited_at = ? where id = 'session_0'`).run(now);
    assert.equal((await client.callTool({ name: 'whoami', arguments: {}, _meta: { sessionID: first } })).isError, true, 'closed agent identity is revoked');
    assert.equal((await service.prepare({ ...input, resumeId: first })).resumeId, first, 'resume retains the native session ID');
    const stopped: string[] = [];
    const terminal = { request: async (_method: string, params: { process_id: string }) => {
      const calls = fs.readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.ok(calls.some((call) => call.route === `/api/session/${second}/interrupt`), 'native session interrupted before terminating the TUI');
      stopped.push(params.process_id);
      return { status: 'stopped' };
    } } as unknown as TerminalService;
    database.connection.prepare('update processes set argv = ?, cwd = ?').run(JSON.stringify([executable, '--session', second]), directory);
    await new StopProcessAction(database, terminal, service).execute('process_1');
    assert.deepEqual(stopped, ['process_1']);
    await new CloseProcessAction(database, terminal, service).execute('process_1');
    assert.equal((database.connection.prepare(`select status from processes where id = 'process_1'`).get() as { status: string }).status, 'closed');

    // An OpenCode stop is the native interrupt: a failed interrupt must not let
    // close mark a possibly-running turn closed, and the shared daemon is never
    // stopped.
    database.connection.prepare(`update processes set status = 'running', exited_at = null where id = 'process_0'`).run();
    database.connection.prepare(`update sessions set exited_at = null where id = 'session_0'`).run();
    const interruptStop = new IntegratedAgentService(database, { opencode: service });
    await interruptStop.stop('process_0');
    const failingInterrupt = new OpenCodeServerService(database, { ...env, FAIL_INTERRUPT: '1' });
    const failingStop = new IntegratedAgentService(database, { opencode: failingInterrupt });
    await assert.rejects(failingStop.stop('process_0'), /OpenCode command failed|interrupt/i);
    await assert.rejects(
      new CloseProcessAction(database, terminal, undefined, failingStop).execute('process_0'),
      /OpenCode command failed|interrupt/i,
      'a failed native interrupt surfaces instead of closing the process'
    );
    assert.equal((database.connection.prepare(`select status from processes where id = 'process_0'`).get() as { status: string }).status, 'running', 'a failed native interrupt leaves the process open');
    const failing = new OpenCodeServerService(database, { ...env, FAIL_API: '1' });
    await assert.rejects(failing.prepare(input), (error: Error) => !error.message.includes('PATTERM_OPENCODE_BRIDGE') && !error.message.includes('config'));
    const mismatched = new OpenCodeServerService(database, { ...env, WRONG_VERSION: '1' });
    await assert.rejects(mismatched.prepare(input), (error: Error) => isOpenCodeVersionMismatch(error.message) && error.message.includes('CLI 2.0.14, server 2.0.13'));
    // Desktop IPC rejections arrive wrapped in Electron's channel prefix.
    assert.ok(isOpenCodeVersionMismatch("Error invoking remote method 'patterm:mcp:call': Error: OpenCode server version mismatch: CLI 2.0.14, server 2.0.13."));
    // The user-requested restart replaces the stale server; a restart that
    // leaves it stale reports that instead of letting launches retry blindly.
    await assert.rejects(mismatched.restartService(executable), /still reports 2\.0\.13/);
    const restarted = path.join(directory, 'restarted');
    const restartable = new OpenCodeServerService(database, { ...env, WRONG_VERSION: '1', RESTARTED: restarted });
    assert.deepEqual(await restartable.restartService(executable), { version: '2.0.14' });
    assert.ok(fs.existsSync(restarted), 'the CLI restarted the shared server');

    // Optional real beta acceptance uses isolated native service state, no model
    // calls or credentials, and always stops only that temporary service.
    if (process.env.PATTERM_TEST_OPENCODE) {
      const nativeEnv = { ...process.env, XDG_DATA_HOME: path.join(directory, 'data'), XDG_CONFIG_HOME: path.join(directory, 'config'), XDG_CACHE_HOME: path.join(directory, 'cache'), XDG_STATE_HOME: path.join(directory, 'state') };
      const native = new OpenCodeServerService(database, nativeEnv);
      try {
        const nativeInput = { ...input, executable: process.env.PATTERM_TEST_OPENCODE };
        execFileSync(nativeInput.executable, ['service', 'set', 'port', String(50_000 + process.pid % 10_000)], { cwd: directory, env: nativeEnv, timeout: 20_000, stdio: 'pipe' });
        const ids = [(await native.prepare(nativeInput)).resumeId, (await native.prepare(nativeInput)).resumeId];
        assert.notEqual(ids[0], ids[1]);
        assert.equal((await native.prepare({ ...nativeInput, resumeId: ids[0]! })).resumeId, ids[0]);
        console.log('real OpenCode shared server: two sessions, MCP connected, context and exact resume passed');
      } finally {
        execFileSync(process.env.PATTERM_TEST_OPENCODE, ['service', 'stop'], { cwd: directory, env: nativeEnv, timeout: 20_000, stdio: 'pipe' });
      }
    }
    console.log('OpenCode shared-server bridge smoke passed');
  } finally {
    await modernClient?.close();
    for (const client of clients) await client.close();
    socket.stop();
    database.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// Activity follows the native stream: requests that wait on the user, ends
// that work resumes from at once, subagents that outlive their parent's turn,
// failures, daemon shutdowns, and a stream that goes quiet.
async function checkStreamedActivity(input: {
  database: DatabaseService;
  env: NodeJS.ProcessEnv;
  first: string;
  daemonState: FakeDaemonState;
  daemonResponses: Set<http.ServerResponse>;
  daemonFrame: (type: string, data: unknown) => string;
  waitFor: (predicate: () => boolean, timeout?: number) => Promise<void>;
}): Promise<void> {
  const { database, env, first, daemonState, daemonResponses, daemonFrame, waitFor } = input;
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 450));
  daemonState.burst = false;
  daemonState.active = {};
  // The default hold on an end, 150 ms.
  const service = new OpenCodeServerService(database, env);
  const events: IntegratedConversationEvent[] = [];
  const release = await service.subscribe('process_0', (event) => events.push(event));
  const statuses = (from: number): string[] => events.slice(from).flatMap((event) => event.kind === 'status' && event.status ? [event.status] : []);
  const read = async (target = service): Promise<{ status?: string; status_detail?: string }> => await target.conversation('process_0') as { status?: string; status_detail?: string };
  try {
    let mark = events.length;
    daemonState.active = { [first]: { type: 'running' } };
    daemonState.emit('session.execution.started', { sessionID: first });
    await waitFor(() => statuses(mark).includes('working'));

    // Foreground shell activity does not end the execution. A quiet tool,
    // then its completion, stays working until the execution ends.
    mark = events.length;
    daemonState.emit('session.tool.input.started', { sessionID: first, assistantMessageID: 'msg_fg_shell', id: 'call_fg_shell', name: 'shell' });
    daemonState.emit('session.tool.called', { sessionID: first, assistantMessageID: 'msg_fg_shell', id: 'call_fg_shell', input: { command: 'sleep 60' } });
    await waitFor(() => events.slice(mark).some((event) => event.kind === 'replace' && event.message?.id === 'msg_fg_shell-0'));
    await settle();
    assert.equal((await read()).status, 'working', 'a quiet foreground OpenCode shell stays working');
    assert.equal((await read(new OpenCodeServerService(database, env))).status, 'working', 'a fresh connection sees the running OpenCode execution');
    daemonState.emit('session.tool.success', { sessionID: first, assistantMessageID: 'msg_fg_shell', id: 'call_fg_shell', content: [{ type: 'text', text: 'done' }] });
    await waitFor(() => events.slice(mark).some((event) => event.kind === 'replace' && event.message?.text === 'done'));
    await settle();
    assert.equal((await read()).status, 'working', 'finishing the OpenCode shell does not finish its execution');
    assert.ok(!statuses(mark).includes('idle'), 'OpenCode never streams idle between a tool and the execution end');

    // A finished compaction re-reads the snapshot for its usage.
    mark = events.length;
    daemonState.emit('session.compaction.ended', { sessionID: first });
    await waitFor(() => events.slice(mark).some((event) => event.kind === 'replace' && event.message?.text === 'Conversation compacted'));
    assert.ok(events.slice(mark).some((event) => event.kind === 'pending'), 'a finished compaction re-reads the snapshot');

    // A permission request is streamed and read as permission, and its reply
    // returns to work. The request also re-reads the snapshot for the dock.
    mark = events.length;
    daemonState.permissions = [{ id: 'per_live', sessionID: first, action: 'bash', resources: ['ls'] }];
    daemonState.emit('permission.asked', { id: 'per_live', sessionID: first, action: 'bash', resources: ['ls'] });
    await waitFor(() => statuses(mark).includes('permission'));
    assert.ok(events.slice(mark).some((event) => event.kind === 'pending'), 'a permission request re-reads the snapshot');
    assert.equal((await read()).status, 'permission', 'the snapshot reports a pending permission');
    assert.equal((await read(new OpenCodeServerService(database, env))).status, 'permission', 'a snapshot without a stream reads the pending permission natively');
    mark = events.length;
    daemonState.permissions = [];
    daemonState.emit('permission.replied', { sessionID: first, requestID: 'per_live', reply: 'once' });
    await waitFor(() => statuses(mark).includes('working'));
    assert.equal((await read()).status, 'working');

    // A subagent's form pauses this session too.
    mark = events.length;
    daemonState.emit('session.created', { sessionID: 'ses_fg_child', parentID: first });
    // A form alone is a question, not a permission.
    daemonState.emit('form.created', { form: { id: 'frm_child_live', sessionID: 'ses_fg_child', title: 'Pick', fields: [] } });
    await waitFor(() => statuses(mark).includes('question'));
    mark = events.length;
    daemonState.emit('form.cancelled', { id: 'frm_child_live', sessionID: 'ses_fg_child' });
    await waitFor(() => statuses(mark).includes('working'));

    // An end that a successor execution follows at once is never shown.
    mark = events.length;
    daemonState.emit('session.execution.succeeded', { sessionID: first });
    daemonState.emit('session.execution.started', { sessionID: first });
    await settle();
    assert.deepEqual(statuses(mark), ['working'], 'a successor execution hides the end before it');

    // While an end is held back a read agrees with the stream; once shown, a
    // daemon that still lists the session does not bring the work back.
    const holding = new OpenCodeServerService(database, env, { settleMs: 30_000 });
    const held: IntegratedConversationEvent[] = [];
    const releaseHolding = await holding.subscribe('process_0', (event) => held.push(event));
    try {
      daemonState.emit('session.execution.started', { sessionID: first });
      await waitFor(() => held.some((event) => event.kind === 'status' && event.status === 'working'));
      mark = events.length;
      const heldMark = held.length;
      daemonState.emit('session.execution.succeeded', { sessionID: first });
      daemonState.emit('session.inbox.cancelled', { sessionID: first, inboxID: 'msg_marker' });
      await waitFor(() => held.slice(heldMark).some((event) => event.kind === 'pending'));
      assert.equal((await read(holding)).status, undefined, 'a read during a held-back end leaves what is shown');
    } finally {
      releaseHolding();
    }
    await waitFor(() => statuses(mark).includes('idle'));
    assert.equal((await read()).status, 'idle', 'the active map lagging the reported end does not restore working');
    await service.prompt('process_0', { text: 'next', references: [], attachments: [] });
    assert.equal((await read()).status, 'working', 'an accepted prompt reads as working before its start event arrives');

    // A failure stays failed, with its detail, until the next execution.
    mark = events.length;
    daemonState.active = {};
    daemonState.emit('session.execution.started', { sessionID: first });
    daemonState.emit('session.execution.failed', { sessionID: first, error: { message: 'Model overloaded' } });
    await waitFor(() => statuses(mark).includes('error'));
    assert.equal(events.slice(mark).find((event) => event.kind === 'status' && event.status === 'error')?.detail, 'Model overloaded');
    const failed = await read();
    assert.deepEqual([failed.status, failed.status_detail], ['error', 'Model overloaded'], 'a re-read keeps the failure');
    // Native outcome rows keep it without the stream, for example after a restart.
    daemonState.rows = [
      { id: 'msg_shell_after', type: 'shell', shellID: 'sh_user', command: 'ls', time: { created: 6 } },
      { id: 'evt_idle', type: 'idle', outcome: 'failed', time: { created: 5 } },
      { id: 'msg_failed', type: 'assistant', content: [], error: { message: 'Rate limited' }, time: { created: 4 } },
      { id: 'msg_prompt', type: 'user', text: 'go', time: { created: 3 } }
    ];
    const restarted = await read(new OpenCodeServerService(database, env));
    assert.deepEqual([restarted.status, restarted.status_detail], ['error', 'Rate limited'], 'a failed outcome row is an error until new work starts');
    daemonState.rows = [{ id: 'msg_retry', type: 'user', text: 'again', time: { created: 7 } }, ...daemonState.rows];
    assert.equal((await read(new OpenCodeServerService(database, env))).status, 'idle', 'a newer prompt leaves the failure behind');
    daemonState.rows = null;

    // A background subagent that outlives its parent's turn keeps it working;
    // the last one ending settles it.
    mark = events.length;
    daemonState.emit('session.execution.started', { sessionID: first });
    daemonState.emit('session.created', { sessionID: 'ses_bg', parentID: first });
    daemonState.emit('session.execution.started', { sessionID: 'ses_bg' });
    daemonState.emit('session.execution.succeeded', { sessionID: first });
    await settle();
    assert.ok(statuses(mark).includes('working') && !statuses(mark).includes('idle'), 'a background subagent keeps its parent working');
    daemonState.active = { ses_bg: { type: 'running' } };
    const backgroundRows = [{ id: 'msg_bg', type: 'assistant', content: [{ type: 'tool', id: 'call_bg_sub', name: 'subagent', state: { status: 'completed', input: { description: 'Explore', background: true }, metadata: { sessionID: 'ses_bg', status: 'running' }, content: [] } }], time: { created: 3 } }];
    daemonState.rows = backgroundRows;
    assert.equal((await read()).status, 'working', 'the snapshot agrees');
    assert.equal((await read(new OpenCodeServerService(database, env))).status, 'working', 'a running subagent named in the transcript keeps working without the stream');
    mark = events.length;
    daemonState.active = {};
    daemonState.emit('session.execution.succeeded', { sessionID: 'ses_bg' });
    await waitFor(() => statuses(mark).includes('idle'));
    assert.equal((await read()).status, 'idle', 'the parent settles when its last subagent ends');

    // A background shell, such as a dev server, does not keep it working.
    mark = events.length;
    daemonState.shells = [{ id: 'sh_dev', status: 'running', metadata: { sessionID: first } }];
    daemonState.rows = [{ id: 'msg_sh', type: 'assistant', content: [{ type: 'tool', id: 'call_dev', name: 'shell', state: { status: 'completed', input: { command: 'npm run dev', background: true }, metadata: { shellID: 'sh_dev', sessionID: first }, content: [] } }], time: { created: 3 } }];
    daemonState.emit('session.execution.started', { sessionID: first });
    daemonState.emit('session.tool.called', { sessionID: first, assistantMessageID: 'msg_sh', id: 'call_dev', name: 'shell', input: { command: 'npm run dev', background: true } });
    daemonState.emit('session.tool.success', { sessionID: first, assistantMessageID: 'msg_sh', id: 'call_dev', content: [{ type: 'text', text: 'Command moved to the background' }], metadata: { shellID: 'sh_dev', sessionID: first } });
    const shellMark = events.length;
    daemonState.emit('shell.created', { id: 'sh_dev', metadata: { sessionID: first } });
    await waitFor(() => events.slice(shellMark).some((event) => event.kind === 'pending'));
    daemonState.emit('session.execution.succeeded', { sessionID: first });
    await waitFor(() => statuses(mark).includes('idle'));
    assert.equal((await read()).status, 'idle', 'a running background shell is not work in progress');
    const { tasks } = await read() as { tasks?: Array<{ id: string; status: string }> };
    assert.deepEqual(tasks?.map((task) => [task.id, task.status]), [['sh_dev', 'running']], 'but it is a running task');
    // A shell's start and end re-read the tasks; another session's shell does not.
    mark = events.length;
    daemonState.emit('shell.exited', { id: 'sh_other', metadata: { sessionID: 'ses_other' } });
    await settle();
    assert.ok(!events.slice(mark).some((event) => event.kind === 'pending'), 'another session\'s shell is ignored');
    daemonState.emit('shell.exited', { id: 'sh_dev', metadata: { sessionID: first } });
    await waitFor(() => events.slice(mark).some((event) => event.kind === 'pending'));
    daemonState.rows = null;
    daemonState.shells = [];

    // A daemon shutdown is not the end of the turn: it resumes on restart, so
    // only a re-read is asked for. A user's interrupt is an end.
    mark = events.length;
    daemonState.emit('session.execution.started', { sessionID: first });
    daemonState.emit('session.execution.interrupted', { sessionID: first, reason: 'shutdown' });
    await settle();
    assert.deepEqual(statuses(mark), ['working'], 'a shutdown interruption is not an end');
    assert.ok(events.slice(mark).some((event) => event.kind === 'pending'), 'a shutdown interruption re-reads the snapshot');
    mark = events.length;
    daemonState.emit('session.execution.interrupted', { sessionID: first, reason: 'user' });
    await waitFor(() => statuses(mark).includes('idle'));

    // One event that cannot be applied neither drops the rest of its chunk
    // nor ends the stream.
    mark = events.length;
    const connections = daemonState.connections;
    Object.defineProperty(service, 'applyFamilyEvent', { configurable: true, value: () => { throw new Error('bad event'); } });
    daemonState.write(daemonFrame('session.text.started', { sessionID: first, assistantMessageID: 'msg_bad', ordinal: 0 })
      + daemonFrame('session.execution.started', { sessionID: first }));
    await waitFor(() => statuses(mark).includes('working'));
    Reflect.deleteProperty(service, 'applyFamilyEvent');
    assert.equal(daemonState.connections, connections, 'the stream stays open');
    assert.ok(!events.slice(mark).some((event) => event.kind === 'reconnecting'));
  } finally {
    release();
  }

  // After a reconnect nothing has streamed yet. A read while the turn's end is
  // held back keeps what is shown rather than reporting the end early, so the
  // streamed end still announces the finished turn.
  const reconnected = new OpenCodeServerService(database, env, { settleMs: 30_000 });
  const reconnectedEvents: IntegratedConversationEvent[] = [];
  const releaseReconnected = await reconnected.subscribe('process_0', (event) => reconnectedEvents.push(event));
  try {
    daemonState.active = { [first]: { type: 'running' } };
    assert.equal((await reconnected.conversation('process_0') as { status?: string }).status, 'working');
    const reconnectedMark = reconnectedEvents.length;
    daemonState.active = {};
    daemonState.emit('session.execution.succeeded', { sessionID: first });
    daemonState.emit('session.inbox.cancelled', { sessionID: first, inboxID: 'msg_marker_reconnect' });
    await waitFor(() => reconnectedEvents.slice(reconnectedMark).some((event) => event.kind === 'pending'));
    assert.equal((await reconnected.conversation('process_0') as { status?: string }).status, undefined, 'a read during a held-back end after a reconnect keeps what is shown');
  } finally {
    releaseReconnected();
  }

  // Integrated activity writes the streamed statuses, permission included.
  daemonState.active = { [first]: { type: 'running' } };
  const observedProvider = new OpenCodeServerService(database, env, { settleMs: 50 });
  const integrated = new IntegratedAgentService(database, { opencode: observedProvider });
  const activity = (): string => (database.connection.prepare(`select activity from processes where id = 'process_0'`).get() as { activity: string }).activity;
  try {
    const connections = daemonState.connections;
    integrated.observe('process_0');
    await waitFor(() => daemonState.connections > connections && activity() === 'working');
    daemonState.permissions = [{ id: 'per_observed', sessionID: first, action: 'bash', resources: ['ls'] }];
    daemonState.emit('permission.asked', { id: 'per_observed', sessionID: first, action: 'bash', resources: ['ls'] });
    await waitFor(() => activity() === 'permission');
    // The daemon reports the answer just before it drops the request, so a
    // read can still list it; the answered request stays answered.
    daemonState.emit('permission.replied', { sessionID: first, requestID: 'per_observed', reply: 'once' });
    await waitFor(() => activity() === 'working');
    daemonState.permissions = [];
    daemonState.active = {};
    daemonState.emit('session.execution.succeeded', { sessionID: first });
    await waitFor(() => activity() === 'idle');

    // A read while subagent events wait behind a lookup keeps the streamed
    // status: the queued background agent start is still to apply.
    daemonState.active = { [first]: { type: 'running' } };
    daemonState.emit('session.execution.started', { sessionID: first });
    await waitFor(() => activity() === 'working');
    let releaseLookup: () => void = () => {};
    const lookup = new Promise<void>((resolve) => { releaseLookup = resolve; });
    const lookups = observedProvider as unknown as { descendsFrom(child: string, root: string): Promise<boolean> };
    lookups.descendsFrom = async (child) => {
      if (child === 'ses_unrelated') await lookup;
      return child === 'ses_queued_bg';
    };
    daemonState.emit('session.execution.started', { sessionID: 'ses_unrelated' });
    daemonState.emit('session.execution.started', { sessionID: 'ses_queued_bg' });
    daemonState.active = { ses_queued_bg: { type: 'running' } };
    daemonState.emit('session.execution.succeeded', { sessionID: first });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await integrated.conversation('process_0');
    assert.equal(activity(), 'working', 'a read while activity is queued does not settle the agent');
    releaseLookup();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(activity(), 'working', 'the queued background agent keeps it working');
    daemonState.active = {};
    daemonState.emit('session.execution.succeeded', { sessionID: 'ses_queued_bg' });
    await waitFor(() => activity() === 'idle');

    // A turn that ended unseen is reconciled by a read; a later read while an
    // unrelated lookup is queued does not bring back the older streamed work.
    daemonState.active = { [first]: { type: 'running' } };
    daemonState.emit('session.execution.started', { sessionID: first });
    await waitFor(() => activity() === 'working');
    daemonState.active = {};
    await integrated.conversation('process_0');
    assert.equal(activity(), 'idle', 'a read reconciles a turn that ended unseen');
    let releaseUnrelated: () => void = () => {};
    const unrelated = new Promise<void>((resolve) => { releaseUnrelated = resolve; });
    lookups.descendsFrom = async () => { await unrelated; return false; };
    daemonState.emit('session.execution.started', { sessionID: 'ses_unrelated_later' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await integrated.conversation('process_0');
    assert.equal(activity(), 'idle', 'a read while a lookup is queued keeps the reconciled state');
    releaseUnrelated();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(activity(), 'idle', 'and stays idle once the queue drains');
  } finally {
    integrated.dispose();
  }

  // A stream with no traffic, not even heartbeats, is dropped and reopened,
  // and the dropped connection is released.
  const quiet = new OpenCodeServerService(database, env, { streamIdleMs: 300 });
  const quietEvents: IntegratedConversationEvent[] = [];
  const before = daemonState.connections;
  const releaseQuiet = await quiet.subscribe('process_0', (event) => quietEvents.push(event));
  try {
    const heartbeat = setInterval(() => daemonState.write(': heartbeat\n\n'), 100);
    await new Promise((resolve) => setTimeout(resolve, 700));
    clearInterval(heartbeat);
    assert.equal(daemonState.connections, before + 1, 'heartbeats keep the stream open');
    await waitFor(() => daemonState.connections >= before + 2, 3_000);
    assert.ok(quietEvents.some((event) => event.kind === 'reconnecting'), 'a silent stream reconnects');
    await waitFor(() => daemonResponses.size === 1);
  } finally {
    releaseQuiet();
  }
  await waitFor(() => daemonResponses.size === 0);
}

// Subagent events wait on a parent lookup. A root end must not settle ahead of
// a child start that arrived first, a subagent the daemon interrupts to
// restart is not finished, and a lookup finishing after its stream was
// replaced leaves the replacement alone.
async function checkActivityOrdering(database: DatabaseService, env: NodeJS.ProcessEnv): Promise<void> {
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const service = new OpenCodeServerService(database, env, { settleMs: 30 });
  type Stream = { emit: (event: unknown) => void; runtime: { executable: string; cwd: string }; serial: Promise<void> };
  const internals = service as unknown as {
    activityState(sessionId: string): { emitters: Set<(event: IntegratedConversationEvent) => void> };
    releaseActivity(sessionId: string, state: unknown, emit: unknown): void;
    handleEvent(sessionId: string, envelope: unknown, stream: Stream): void;
    descendsFrom(child: string, root: string): Promise<boolean>;
  };
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  internals.descendsFrom = async (child) => {
    if (child === 'ses_other') await delay(150);
    if (child === 'ses_late') await held;
    return child === 'ses_kid' || child === 'ses_late';
  };
  const open = () => {
    const statuses: string[] = [];
    const emit = (event: IntegratedConversationEvent) => { if (event.kind === 'status' && event.status) statuses.push(event.status); };
    const state = internals.activityState('ses_root');
    state.emitters.add(emit);
    const stream: Stream = { emit: () => {}, runtime: { executable: 'opencode', cwd: '/tmp' }, serial: Promise.resolve() };
    const send = (type: string, data: Record<string, unknown>) => internals.handleEvent('ses_root', { type, data }, stream);
    return { statuses, send, close: () => internals.releaseActivity('ses_root', state, emit) };
  };

  const first = open();
  first.send('session.execution.started', { sessionID: 'ses_root' });
  first.send('session.execution.started', { sessionID: 'ses_other' });
  first.send('session.created', { sessionID: 'ses_kid', parentID: 'ses_root' });
  first.send('session.execution.started', { sessionID: 'ses_kid' });
  first.send('session.execution.succeeded', { sessionID: 'ses_root' });
  await delay(300);
  assert.ok(!first.statuses.includes('idle'), 'a root end waits for an earlier child start');
  first.send('session.execution.interrupted', { sessionID: 'ses_kid', reason: 'shutdown' });
  await delay(100);
  assert.ok(!first.statuses.includes('idle'), 'a subagent interrupted for a restart is not finished');

  first.send('session.execution.started', { sessionID: 'ses_late' });
  first.close();
  const second = open();
  second.send('session.execution.succeeded', { sessionID: 'ses_root' });
  release();
  await delay(100);
  assert.deepEqual([...new Set(second.statuses)], ['idle'], 'a lookup finishing after its stream closed leaves the replacement alone');
  second.close();

  // A newer turn's permission survives the older turn's end before it.
  const third = open();
  third.send('session.execution.started', { sessionID: 'ses_root' });
  third.send('session.execution.succeeded', { sessionID: 'ses_root' });
  third.send('session.execution.started', { sessionID: 'ses_root' });
  third.send('permission.asked', { id: 'per_newer', sessionID: 'ses_root', action: 'bash', resources: ['ls'] });
  await delay(100);
  assert.equal(third.statuses.at(-1), 'permission', 'an older end does not drop a newer turn\'s permission');
  third.close();

  // An end is not shown while a successor start waits behind a lookup.
  const fourth = open();
  fourth.send('session.execution.started', { sessionID: 'ses_root' });
  fourth.send('session.execution.succeeded', { sessionID: 'ses_root' });
  fourth.send('session.execution.started', { sessionID: 'ses_other' });
  fourth.send('session.execution.started', { sessionID: 'ses_root' });
  await delay(300);
  assert.ok(!fourth.statuses.includes('idle'), 'a queued successor start keeps the end from showing');
  fourth.close();
}

interface FakeDaemonState {
  connections: number; auth: string; prompts: unknown[]; messageReads: number;
  emit: (type: string, data: unknown, created?: number) => void; write: (raw: string) => void;
  // Each connection opens with a fixed burst of events unless turned off.
  burst: boolean; active: Record<string, unknown>; rows: unknown[] | null; permissions: unknown[]; shells: unknown[];
}

function checkHistory(directory: string): void {
  const filename = path.join(directory, 'beta-history.db');
  const db = new DatabaseSync(filename);
  db.exec(`
    create table session_v2 (id text primary key,directory text,title text,version text,time_created integer,time_updated integer,parent_id text,agent text,model text,metadata text,time_archived integer);
    create table session_message (id text primary key,session_id text,type text,seq integer,time_created integer,time_updated integer,data text);
    insert into session_v2 values ('ses_history','/tmp/repo','Beta history','2-beta',1000,1000,null,'build',null,null,null);
  `);
  const insert = db.prepare('insert into session_message values (?,?,?,?,?,?,?)');
  insert.run('msg_user', 'ses_history', 'user', 0, 1000, 1000, JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'hello beta' }] }));
  insert.run('msg_assistant', 'ses_history', 'assistant', 1, 2000, 2000, JSON.stringify({ type: 'assistant', content: [
    { type: 'text', text: 'beta reply' }, { type: 'reasoning', text: 'reasoning fixture' },
    { type: 'tool', id: 'call_read', name: 'read', state: { status: 'completed', input: { filePath: '/tmp/file' }, content: [{ type: 'text', text: 'file contents' }] } }
  ] }));
  const adapter = new OpenCodeHistoryAdapter();
  const first = adapter.fingerprintFile(filename);
  const parsed = adapter.parseFile(filename);
  assert.equal(parsed.conversations.length, 1);
  assert.equal(parsed.conversations[0]?.providerConversationId, 'ses_history');
  assert.deepEqual(parsed.conversations[0]?.messages.map((message) => message.role), ['user', 'assistant', 'assistant', 'tool']);
  assert.equal(parsed.conversations[0]?.messages[3]?.toolName, 'read');
  assert.equal(parsed.conversations[0]?.messages[3]?.toolStatus, 'completed');
  assert.match(parsed.conversations[0]?.messages[3]?.toolOutputSummary ?? '', /file contents/);
  db.prepare('update session_message set time_updated = 3000 where id = ?').run('msg_assistant');
  const next = adapter.fingerprintFile(filename);
  assert.deepEqual(adapter.changedProviderConversationIds(first.metadata, next.metadata), ['ses_history'], 'streamed message changes are detected without a session timestamp update');
  assert.equal(adapter.parseFile(filename, { providerConversationIds: [] }).conversations.length, 0);
  db.close();
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
