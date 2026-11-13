import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AcpProviderService } from '../app/Services/AcpProviderService';
import { AntigravityHistoryAdapter } from '../app/Services/AgentHistory/AntigravityHistoryAdapter';
import { DatabaseService } from '../app/Services/DatabaseService';
import { TurnBusyError, UncertainDeliveryError } from '../app/Services/IntegratedDelivery';
import type { IntegratedConversationEvent } from '../app/Services/IntegratedConversation';
import { TranscriptImageStore } from '../app/Services/TranscriptImageStore';
import { callIntegratedHost } from '../app/Services/IntegratedHostLauncher';
import { writeNodeCli } from './fixtures/IntegratedFakeCli';
import { IntegratedTestHosts } from './fixtures/IntegratedTestHosts';
import { removeTree } from './fixtures/TempTree';

async function main(): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-acp-'));
  const trace = path.join(directory, 'trace.jsonl');
  // Native ACP shapes captured from agy 1.5.8. No real CLI or model is used.
  const executable = writeNodeCli(path.join(directory, 'agy'), String.raw`
const fs = require('node:fs');
const out = frame => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...frame})+'\n');
const result = (id,value={}) => out({id,result:value});
let prompt = null;
const update = value => out({method:'session/update',params:{sessionId:'native-session',update:value}});
const options = [
 {id:'model',name:'Model',type:'select',currentValue:'flash',options:[{value:'flash',name:'Flash'}]},
 {id:'thought_level',name:'Thinking Level',type:'select',currentValue:'high',options:[{value:'low',name:'Low'},{value:'high',name:'High'}]},
 {id:'mode',name:'Mode',type:'select',currentValue:'default',options:[{value:'default',name:'Default'},{value:'plan',name:'Plan'}]}
];
const echo = text => update({sessionUpdate:'user_message_chunk',content:{type:'text',text}});
const say = text => update({sessionUpdate:'agent_message_chunk',content:{type:'text',text}});
const permission = () => {
 update({sessionUpdate:'tool_call',toolCallId:'edit',name:'write_file',title:'File probe.txt',status:'pending',rawInput:{Path:'probe.txt',Content:'new'}});
 out({id:41,method:'session/request_permission',params:{sessionId:'native-session',toolCall:{title:'File probe.txt',locations:[{path:'probe.txt'}],content:[{type:'diff',path:'probe.txt',oldText:'old\n',newText:'new\n'}]},options:[{optionId:'allow',kind:'allow_once',name:'Allow'},{optionId:'deny',kind:'reject_once',name:'Deny'}]}});
};
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line);fs.appendFileSync(process.env.ACP_TRACE,line+'\n');
 if(q.method==='initialize') return result(q.id,{protocolVersion:1,agentCapabilities:{loadSession:true,_meta:{antigravity:{systemPrompt:{append:true}}}}});
 if(q.method==='session/new'||q.method==='session/load') {
  if(process.env.ACP_AUTH_FAIL) return out({id:q.id,error:{code:-32000,message:'Authentication required'}});
  if(q.method==='session/load'){echo('Earlier user');say('Earlier assistant');}
  return result(q.id,{sessionId:'native-session',models:{currentModelId:'flash-high'},configOptions:options});
 }
 if(q.method==='session/set_model') {options[1].currentValue='low';update({sessionUpdate:'config_option_update',configOptions:options});return result(q.id);}
 if(q.method==='session/set_config_option') {options.find(o=>o.id===q.params.configId).currentValue=q.params.value;return result(q.id,{configOptions:options});}
 if(q.method==='session/prompt') {
  const text=q.params.prompt[0].text;prompt=q.id;
  if(text==='late') {setTimeout(()=>{echo(text);say('Late accepted');result(prompt,{stopReason:'end_turn'});prompt=null;},8300);return;}
  if(text==='failure') return out({id:q.id,error:{code:-32000,message:'Native turn failed'}});
  echo(text);
  if(text==='permission'||text==='cancel') return permission();
  update({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'Thinking'}});
  say('Hello ');say('Flash');
  update({sessionUpdate:'session_info_update',title:'Native title'});
  update({sessionUpdate:'available_commands_update',availableCommands:[{name:'compact',description:'Compact context'}]});
  update({sessionUpdate:'usage_update',used:42,size:1000});
  result(q.id,{stopReason:'end_turn',usage:{inputTokens:20,outputTokens:5}});prompt=null;return;
 }
 if(q.method==='session/cancel') {
  update({sessionUpdate:'tool_call_update',toolCallId:'edit',status:'failed'});
  if(prompt) result(prompt,{stopReason:'cancelled'});prompt=null;return;
 }
 if(q.id===41 && prompt){say(JSON.stringify(q.result));result(prompt,{stopReason:'end_turn'});prompt=null;}
});
`);
  const database = new DatabaseService(directory);
  const hosts = new IntegratedTestHosts();
  const env = { ...process.env, ACP_TRACE: trace };
  const images = new TranscriptImageStore(path.join(directory, 'images'));
  const service = () => new AcpProviderService(database, directory, process.execPath, env, undefined, hosts, images);
  const provider = service();
  let release: (() => void) | undefined;
  try {
    database.initialize();
    const now = new Date().toISOString();
    database.connection.prepare('insert into projects (id,name,path,created_at,updated_at) values (?,?,?,?,?)').run('project', 'ACP', directory, now, now);
    const input = {
      executable, cwd: directory, name: null, context: 'Private Patterm context', resumeId: null,
      model: 'flash-low', reasoning: 'low',
      mcp: { command: process.execPath, args: ['shim.js'], env: { PATTERM_MCP_IDENTITY: 'private-identity' } }
    };
    const prepared = await provider.prepare(input);
    assert.equal(prepared.resumeId, 'native-session');
    assert(!JSON.stringify(prepared.argv).includes('private-identity'));
    database.connection.prepare(`insert into processes (id,project_id,kind,name,status,cwd,argv,created_at,updated_at) values ('process','project','agent','Agy','running',?,?,?,?)`).run(directory, JSON.stringify(prepared.argv), now, now);
    database.connection.prepare(`insert into sessions (id,project_id,process_id,harness,interface_mode,mcp_identity,resume_id,started_at,session_role,resume_status,created_by_actor) values ('session','project','process','agy','integrated','identity',?,?,'orchestrator','found','user')`).run(prepared.resumeId, now);
    const frames = () => fs.readFileSync(trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const creation = frames().find((frame) => frame.method === 'session/new');
    assert.equal(creation.params._meta.antigravity.systemPrompt.append, input.context);
    assert.deepEqual(creation.params.mcpServers[0].env, [{ name: 'PATTERM_MCP_IDENTITY', value: 'private-identity' }]);
    assert.deepEqual(frames()[0].params.clientCapabilities, {}, 'unimplemented filesystem and terminal capabilities are not advertised');
    if (process.platform !== 'win32') assert.equal(fs.statSync(prepared.argv[4]!).mode & 0o777, 0o600);
    await assert.rejects(provider.prepare({ ...input, resumeId: prepared.resumeId }), /already attached/);

    const events: IntegratedConversationEvent[] = [];
    release = await provider.subscribe('process', (event) => events.push(event));
    await provider.prompt('process', { text: 'hello', references: [{ path: path.join(directory, 'a #.txt'), name: 'a #.txt', relativePath: 'a #.txt' }], attachments: [], messageId: 'hello-id' });
    let state = await waitFor(provider, (state) => state.status === 'idle');
    assert.equal(state.provider, 'agy');
    assert.equal(state.messages.data.find((row: any) => row.role === 'user').clientMessageId, 'hello-id');
    assert(state.messages.data.some((row: any) => row.kind === 'reasoning' && row.text === 'Thinking'));
    assert(state.messages.data.some((row: any) => row.text === 'Hello Flash'));
    assert.equal(state.usage.contextTokens, 42);
    assert.equal(state.usage.outputTokens, 5);
    assert(events.some((event) => event.kind === 'append' && event.delta === 'Flash'));
    assert.equal(await provider.title('process'), 'Native title');
    assert.deepEqual(await provider.nativeSettings('process'), { model: 'flash', reasoning: 'low' });
    assert.equal((await provider.controls('process')).commands[0]?.name, 'compact');
    await provider.configure('process', 'mode', 'plan');
    await assert.rejects(provider.configure('process', 'mode', 'invented'), /Unknown ACP setting value/);
    assert.equal(frames().find((frame) => frame.method === 'session/prompt').params.prompt[1].uri, pathToFileURL(path.join(directory, 'a #.txt')).href);
    const count = frames().filter((frame) => frame.method === 'session/prompt').length;
    await provider.prompt('process', { text: 'hello', references: [], attachments: [], messageId: 'hello-id' });
    assert.equal(frames().filter((frame) => frame.method === 'session/prompt').length, count, 'an acknowledged message is never resubmitted');

    // A new provider instance reconnects to the durable host; a viewer closing
    // its subscription neither stops the CLI nor loses the conversation.
    release(); release = undefined;
    assert.equal(JSON.stringify((await service().conversation('process') as any).messages), JSON.stringify(state.messages));
    await provider.prompt('process', { text: 'permission', references: [], attachments: [], messageId: 'permission-id' });
    state = await waitFor(provider, (state) => state.status === 'permission');
    assert.equal(state.permissions.data[0].always, false);
    assert.match(state.permissions.data[0].patch, /-old\n\+new/);
    await assert.rejects(provider.prompt('process', { text: 'busy', references: [], attachments: [] }), TurnBusyError);
    await assert.rejects(provider.replyPermission('process', '41', 'always'), /not offered/);
    await provider.replyPermission('process', '41', 'once');
    state = await waitFor(provider, (state) => state.status === 'idle');
    assert(state.messages.data.some((row: any) => row.text.includes('"optionId":"allow"')));
    await assert.rejects(provider.replyPermission('process', '41', 'once'), /no longer pending/);

    await provider.prompt('process', { text: 'permission', references: [], attachments: [] });
    await waitFor(provider, (state) => state.status === 'permission');
    await provider.replyPermission('process', '41', 'reject');
    state = await waitFor(provider, (state) => state.status === 'idle');
    assert(state.messages.data.some((row: any) => row.text.includes('"optionId":"deny"')));

    await provider.prompt('process', { text: 'cancel', references: [], attachments: [] });
    await waitFor(provider, (state) => state.status === 'permission');
    await provider.interrupt('process');
    state = await waitFor(provider, (state) => state.status === 'idle');
    assert.equal(state.permissions.data.length, 0);
    assert.equal(state.messages.data.find((row: any) => row.id === 'tool:edit').tool.name, 'write_file', 'partial tool updates keep the native name');
    assert.equal(state.messages.data.find((row: any) => row.id === 'tool:edit').tool.state.status, 'failed');

    await assert.rejects(provider.prompt('process', { text: 'late', references: [], attachments: [], messageId: 'late-id' }), UncertainDeliveryError);
    await waitFor(provider, (state) => state.status === 'idle');
    assert.equal(await provider.reconcile('process', 'late-id'), 'accepted', 'late native evidence resolves uncertain admission');
    await assert.rejects(provider.prompt('process', { text: 'failure', references: [], attachments: [] }), /Native turn failed/);
    assert.equal((await provider.conversation('process') as any).status, 'failed');
    await provider.stop('process');
    await hosts.waitForExit(Number(prepared.argv[3]));
    database.connection.prepare("update sessions set exited_at = ? where id = 'session'").run(now);
    const resumed = await provider.prepare({ ...input, model: 'flash', resumeId: prepared.resumeId });
    assert.equal(resumed.resumeId, prepared.resumeId);
    assert(frames().some((frame) => frame.method === 'session/load'));
    const loaded = await callIntegratedHost(resumed.argv[2]!, 'conversation', {}) as any;
    assert.deepEqual(loaded.messages.data.map((row: any) => row.text), ['Earlier user', 'Earlier assistant']);
    await provider.cleanupLaunch(input, resumed);
    await hosts.waitForExit(Number(resumed.argv[3]));

    const unauthenticated = new AcpProviderService(database, directory, process.execPath, { ...env, ACP_AUTH_FAIL: '1' }, undefined, hosts);
    await assert.rejects(unauthenticated.prepare(input), /Authentication required/);

    // Native JSONL history has the same session identity. Generated metadata
    // is not user text and sibling full logs must not create duplicate imports.
    const logDirectory = path.join(directory, 'native-history', '.system_generated', 'logs');
    fs.mkdirSync(logDirectory, { recursive: true });
    const log = path.join(logDirectory, 'transcript.jsonl');
    const nativeRows = [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: now, content: '<USER_REQUEST>\nHello\n</USER_REQUEST>\n<ADDITIONAL_METADATA>hidden</ADDITIONAL_METADATA>' },
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: now, content: 'Reply', input_tokens: 10, output_tokens: 2 },
      { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: now, tool_calls: [{ name: 'write_file', args: { Path: '"a.txt"', Content: '"new"' } }] },
      { step_index: 3, source: 'MODEL', type: 'GENERIC', created_at: now, content: 'Created file.', status: 'DONE' }
    ];
    fs.writeFileSync(log, nativeRows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    fs.copyFileSync(log, path.join(logDirectory, 'transcript_full.jsonl'));
    const adapter = new AntigravityHistoryAdapter();
    assert.deepEqual(adapter.discoverFiles(path.join(directory, 'native-history')), [log]);
    const history = adapter.parseFile(log).conversations[0]!;
    assert.equal(history.providerConversationId, 'native-history');
    assert.equal(history.messages[0]?.text, 'Hello');
    assert.equal(history.messages[2]?.kind, 'tool_call');
    assert.equal(history.messages[2]?.toolInputSummary, '{"Path":"a.txt","Content":"new"}');
    assert.equal(history.messages[3]?.kind, 'tool_result');
    assert.equal(history.usage?.[0]?.inputTokens, 10);
    assert(!JSON.stringify(history).includes('hidden'));
  } finally {
    release?.();
    await hosts.stopAll();
    database.dispose();
    await removeTree(directory);
  }
  console.log('ACP provider smoke passed');
}

async function waitFor(provider: AcpProviderService, predicate: (state: any) => boolean): Promise<any> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const state = await provider.conversation('process') as any;
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('ACP host did not reach the expected state');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
