import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
import { IntegratedAgentService } from '../app/Services/IntegratedAgentService';
import { isActivityState } from '../app/Services/Activity';
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
 {id:'mode',name:'Mode',type:'select',currentValue:'default',options:[{value:'default',name:'Default'},...(!process.env.ACP_NO_AUTO ? [{value:'auto',name:'Auto'}] : []),{value:'plan',name:'Plan'}]}
];
// ACP also allows grouped select values; launch and restore must flatten them
// just as the picker and configure path do.
options[2].options = [{name:'Execution modes',options:options[2].options}];
const echo = text => update({sessionUpdate:'user_message_chunk',content:{type:'text',text}});
const say = text => update({sessionUpdate:'agent_message_chunk',content:{type:'text',text}});
const permission = (text) => {
 const name=text==='mcp' ? 'mcp_patterm_mutate' : text==='unknown-mcp' ? 'mcp_other_mutate' : 'write_file';
 update({sessionUpdate:'tool_call',toolCallId:'edit',name,title:'File probe.txt',status:'pending',rawInput:{Path:'probe.txt',Content:'new'}});
 out({id:41,method:'session/request_permission',params:{sessionId:'native-session',toolCall:{toolCallId:'edit',name,title:text==='spoof-mcp' ? 'Run mcp_patterm_mutate' : 'File probe.txt',locations:[{path:'probe.txt'}],content:[{type:'diff',path:'probe.txt',oldText:'old\n',newText:'new\n'}]},options:[{optionId:'allow',kind:'allow_once',name:'Allow'},...(text==='always' ? [{optionId:'session',kind:'allow_always',name:'Allow for this session'}] : []),{optionId:'deny',kind:'reject_once',name:'Deny'}]}});
};
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line);fs.appendFileSync(process.env.ACP_TRACE,line+'\n');
 if(q.method==='initialize') return result(q.id,{protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{close:{}},_meta:{antigravity:{systemPrompt:{append:true}}}}});
 if(q.method==='session/close') return setTimeout(() => {
  fs.appendFileSync(process.env.ACP_TRACE,'{"closeFinished":true}\n');result(q.id);
 }, 100);
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
  if(text==='crash') {fs.writeFileSync(process.env.ACP_TRACE+'.side-effect','executed');process.exit(17);}
  echo(text);
  if(text==='no-cancel-ack') return;
  if(text==='delayed-approval') {
   result(q.id,{stopReason:'end_turn'});prompt=null;
   update({sessionUpdate:'tool_call',toolCallId:'deferred',name:'mcp_patterm_mutate',status:'pending'});return;
  }
  if(text==='overlapping-follow-up') {
   out({id:44,method:'session/request_permission',params:{sessionId:'native-session',toolCall:{toolCallId:'deferred',title:'Delayed approval'},options:[{optionId:'allow',kind:'allow_once',name:'Allow'}]}});return;
  }
  if(text==='tool-outlives-prompt'||text==='tool-never-starts') {
   const started = text==='tool-outlives-prompt';
   update({sessionUpdate:'tool_call',toolCallId:started?'outlives':'unstarted',status:started?'in_progress':'pending'});
   const ready = suffix => {
    const file = process.env.ACP_TRACE + suffix;
    const timer = setInterval(() => {
     if(!fs.existsSync(file)) return;
     clearInterval(timer);
     if(suffix==='.end-turn') {result(q.id,{stopReason:started?'end_turn':'max_tokens'});prompt=null;update({sessionUpdate:'usage_update',used:314,size:1000});}
     else update({sessionUpdate:'tool_call_update',toolCallId:'outlives',status:'completed'});
    },5);
   };
   ready('.end-turn');if(started) ready('.complete-tool');return;
  }
  if(text==='clear-diff') {
   update({sessionUpdate:'tool_call',toolCallId:'cleared',status:'in_progress',rawInput:{Path:'cleared.txt'},content:[{type:'diff',path:'cleared.txt',oldText:'old\n',newText:'new\n'}]});
   update({sessionUpdate:'tool_call',toolCallId:'retained',status:'in_progress',rawInput:{Path:'retained.txt'},content:[{type:'diff',path:'retained.txt',oldText:'old\n',newText:'new\n'}]});
   update({sessionUpdate:'tool_call_update',toolCallId:'cleared',status:'completed',content:[]});
   update({sessionUpdate:'tool_call_update',toolCallId:'retained',status:'completed',content:null});
   result(q.id,{stopReason:'end_turn'});prompt=null;return;
  }
  if(text==='post-prompt') {
   const frames = [
    {id:q.id,result:{stopReason:'end_turn'}},
    {method:'session/update',params:{sessionId:'native-session',update:{sessionUpdate:'tool_call',toolCallId:'background',name:'mcp_patterm_mutate',status:'in_progress'}}},
    {id:43,method:'session/request_permission',params:{sessionId:'native-session',toolCall:{toolCallId:'background',name:'mcp_patterm_mutate',title:'Background approval'},options:[{optionId:'allow',kind:'allow_once',name:'Allow'}]}}
   ];
   prompt=null;process.stdout.write(frames.map(frame=>JSON.stringify({jsonrpc:'2.0',...frame})+'\n').join(''));return;
  }
  if(text==='large-output') {
   update({sessionUpdate:'tool_call',toolCallId:'large',name:'run_command',status:'completed',rawOutput:{output:'界'.repeat(600000)}});
   update({sessionUpdate:'tool_call_update',toolCallId:'large',status:'completed'});
   result(q.id,{stopReason:'end_turn'});prompt=null;return;
  }
  if(text==='message-ids') {
   for(const [messageId,text] of [['a','first'],['a',' chunk'],['b','second']]) update({sessionUpdate:'agent_message_chunk',messageId,content:{type:'text',text}});
   result(q.id,{stopReason:'max_tokens'});prompt=null;return;
  }
  if(text==='failure-after-echo') return out({id:q.id,error:{code:-32000,message:'Native acknowledged turn failed'}});
   if(['permission','cancel','mcp','unknown-mcp','spoof-mcp','always'].includes(text)) return permission(text);
   if(text==='flood') {
    for(let i=0;i<450;i++) update({sessionUpdate:'tool_call',toolCallId:'flood-'+i,name:'read_file',status:'completed'});
    const file=Array.from({length:50},(_,i)=>'line '+i);
    update({sessionUpdate:'tool_call',toolCallId:'big-edit',name:'edit_file',status:'completed',content:[{type:'diff',path:'big.txt',oldText:file.join('\n')+'\n',newText:file.map((line,i)=>i===25?'changed':line).join('\n')+'\n'}]});
    result(q.id,{stopReason:'end_turn'});prompt=null;return;
   }
   if(text==='change-settings') {options[1].currentValue='high';update({sessionUpdate:'config_option_update',configOptions:options});}
   update({sessionUpdate:'tool_call',toolCallId:'read',name:'read_file',status:'in_progress'});
   update({sessionUpdate:'tool_call_update',toolCallId:'read',rawOutput:{result:'kept'}});
   update({sessionUpdate:'tool_call_update',toolCallId:'read',status:'completed'});
  update({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'Thinking'}});
  say('Hello ');say('Flash');
  update({sessionUpdate:'session_info_update',title:'Native title'});
  update({sessionUpdate:'available_commands_update',availableCommands:[{name:'compact',description:'Compact context'}]});
  update({sessionUpdate:'usage_update',used:42,size:1000});
  result(q.id,{stopReason:'end_turn',usage:{inputTokens:20,outputTokens:5}});prompt=null;return;
 }
 if(q.method==='session/cancel') {
   if(process.env.ACP_IGNORE_CANCEL) return;
   // A late request must not re-open a permission card or be auto-approved.
   out({id:42,method:'session/request_permission',params:{sessionId:'native-session',toolCall:{name:'mcp_patterm_mutate'},options:[{optionId:'allow',kind:'allow_once',name:'Allow'}]}});
  if(prompt) result(prompt,{stopReason:'cancelled'});prompt=null;return;
 }
 if(q.id===43) {
  update({sessionUpdate:'tool_call_update',toolCallId:'background',status:'completed'});
  say('Background work done');return;
 }
 if(q.id===44 && prompt){result(prompt,{stopReason:'end_turn'});prompt=null;}
 if(q.id===41 && prompt){
  update({sessionUpdate:'tool_call_update',toolCallId:'edit',status:q.result?.outcome?.optionId==='deny'?'failed':'completed'});
  say(JSON.stringify(q.result));result(prompt,{stopReason:'end_turn'});prompt=null;
 }
});
`);
  const database = new DatabaseService(directory);
  const hosts = new IntegratedTestHosts();
  const env = { ...process.env, ACP_TRACE: trace, PATTERM_ACP_BACKGROUND_QUIET_MS: '1000', PATTERM_ACP_CANCEL_TIMEOUT_MS: '250' };
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
    assert.deepEqual(creation.params.mcpServers[0].env, [{ name: 'PATTERM_MCP_IDENTITY', value: 'private-identity' }, { name: 'PATTERM_MCP_COMPACT', value: '1' }], 'agy gets the compact Patterm catalogue');
    assert.deepEqual(frames()[0].params.clientCapabilities, {}, 'unimplemented filesystem and terminal capabilities are not advertised');
    if (process.platform !== 'win32') assert.equal(fs.statSync(prepared.argv[4]!).mode & 0o777, 0o600);
    await assert.rejects(provider.prepare({ ...input, resumeId: prepared.resumeId }), /already attached/);
    const selector = async (id: string) => (await provider.controls('process')).selectors.find((option) => option.id === id);
    assert.equal((await selector('mode'))?.value, 'auto', 'fresh sessions start in native Auto mode');
    assert.equal((await selector('patterm_mcp'))?.value, 'allow', 'MCP trust is explicit and visible');

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
    assert.deepEqual(state.messages.data.find((row: any) => row.id === 'tool:read').tool.state.output, { result: 'kept' }, 'status-only updates retain native output');
    assert(events.some((event) => event.kind === 'append' && event.delta === 'Flash'));
    assert.equal(await provider.title('process'), 'Native title');
    assert.deepEqual(await provider.nativeSettings('process'), { model: 'flash', reasoning: 'low' });
    assert.equal((await provider.controls('process')).commands[0]?.name, 'compact');
    await assert.rejects(provider.configure('process', 'mode', 'invented'), /Unknown ACP setting value/);
    assert.equal(frames().find((frame) => frame.method === 'session/prompt').params.prompt[1].uri, pathToFileURL(path.join(directory, 'a #.txt')).href);
    const count = frames().filter((frame) => frame.method === 'session/prompt').length;
    await provider.prompt('process', { text: 'hello', references: [], attachments: [], messageId: 'hello-id' });
    assert.equal(frames().filter((frame) => frame.method === 'session/prompt').length, count, 'an acknowledged message is never resubmitted');
    await provider.prompt('process', { text: 'pdf-attachment', references: [], attachments: [{ path: path.join(directory, 'a #.pdf'), name: 'a #.pdf', mime: 'application/pdf', size: 3, data: Buffer.from('pdf').toString('base64') }] });
    await waitFor(provider, (snapshot) => snapshot.status === 'idle');
    assert.deepEqual(frames().filter((frame) => frame.method === 'session/prompt').at(-1).params.prompt[1], { type: 'resource_link', uri: pathToFileURL(path.join(directory, 'a #.pdf')).href, name: 'a #.pdf', mimeType: 'application/pdf' }, 'PDFs use native file reading, not silently ignored binary blobs');

    const ask = (text: string) => provider.prompt('process', { text, references: [], attachments: [] });
    await ask('post-prompt');
    state = await waitFor(provider, (snapshot) => snapshot.messages.data.some((row: any) => row.id === 'tool:background') && snapshot.status !== 'starting');
    assert.equal(state.status, 'permission', 'a background approval after the prompt response still reaches the user');
    assert.equal(state.permissions.data[0]?.action, 'Background approval');
    assert(!frames().some((frame) => frame.id === 43), 'a background MCP permission is not auto-approved or cancelled');
    await assert.rejects(ask('follow-up'), TurnBusyError);
    await provider.replyPermission('process', '43', 'once');
    state = await waitFor(provider, (snapshot) => snapshot.messages.data.some((row: any) => row.text === 'Background work done'));
    assert.equal(state.status, 'working', 'background output keeps the session active');
    await assert.rejects(ask('follow-up'), TurnBusyError);
    await waitFor(provider, (snapshot) => snapshot.status === 'idle');
    await ask('delayed-approval');
    await waitFor(provider, (snapshot) => snapshot.status === 'idle' && snapshot.messages.data.some((row: any) => row.id === 'tool:deferred'));
    await ask('overlapping-follow-up');
    state = await waitFor(provider, (snapshot) => snapshot.status === 'permission');
    assert.equal(state.permissions.data[0]?.id, '44', 'background permissions remain manual during a later foreground prompt');
    assert(!frames().some((frame) => frame.id === 44));
    await provider.replyPermission('process', '44', 'reject');
    await waitFor(provider, (snapshot) => snapshot.status === 'idle');
    const queue = new IntegratedAgentService(database, { agy: provider });
    try {
      queue.observe('process');
      await ask('tool-outlives-prompt');
      assert.equal((await queue.prompt('process', { text: 'after-outliving-tool', messageId: 'held-after-tool' }) as any).delivery, 'queued');
      fs.writeFileSync(trace + '.end-turn', '');
      await waitFor(provider, (snapshot) => snapshot.usage.contextTokens === 314);
      assert.equal((await provider.conversation('process') as any).status, 'working');
      assert(!frames().some((frame) => frame.method === 'session/prompt' && frame.params.prompt[0].text === 'after-outliving-tool'));
      fs.writeFileSync(trace + '.complete-tool', '');
      await waitFor(provider, (snapshot) => snapshot.status === 'idle' && snapshot.messages.data.some((row: any) => row.clientMessageId === 'held-after-tool'));
      fs.unlinkSync(trace + '.end-turn');
      await ask('tool-never-starts');
      assert.equal((await queue.prompt('process', { text: 'after-unstarted-tool', messageId: 'held-after-unstarted' }) as any).delivery, 'queued');
      fs.writeFileSync(trace + '.end-turn', '');
      state = await waitFor(provider, (snapshot) => snapshot.status === 'idle' && snapshot.messages.data.some((row: any) => row.clientMessageId === 'held-after-unstarted'));
      assert.equal(state.messages.data.find((row: any) => row.id === 'tool:unstarted').tool.state.status, 'failed');
    } finally { queue.dispose(); }
    await ask('clear-diff');
    state = await waitFor(provider, (snapshot) => snapshot.status === 'idle');
    const cleared = state.messages.data.find((row: any) => row.id === 'tool:cleared');
    assert.equal(cleared.tool.input.patch, undefined);
    assert.equal(cleared.text, '');
    assert.match(state.messages.data.find((row: any) => row.id === 'tool:retained').tool.input.patch, /-old\n\+new/);
    await ask('message-ids');
    state = await waitFor(provider, (snapshot) => snapshot.status === 'idle');
    assert.deepEqual(state.messages.data.filter((row: any) => /^first|^second/.test(row.text)).map((row: any) => row.text), ['first chunk', 'second']);
    assert(state.messages.data.some((row: any) => row.kind === 'notice' && /token limit/.test(row.text)));
    await ask('large-output');
    state = await waitFor(provider, (snapshot) => snapshot.status === 'idle');
    const large = state.messages.data.find((row: any) => row.id === 'tool:large');
    assert.match(JSON.stringify(large.tool.state.output), /truncated/i);
    assert(Buffer.byteLength(JSON.stringify(state.messages.data)) <= 1024 * 1024);
    await ask('mcp');
    await waitFor(provider, (snapshot) => snapshot.status === 'idle');
    assert(frames().some((frame) => frame.id === 41 && frame.result?.outcome?.optionId === 'allow'), 'Auto approves native MCP write requests without a card');
    for (const text of ['unknown-mcp', 'spoof-mcp']) {
      await ask(text);
      await waitFor(provider, (snapshot) => snapshot.status === 'permission');
      await provider.replyPermission('process', '41', 'reject');
      await waitFor(provider, (snapshot) => snapshot.status === 'idle');
    }
    await provider.configure('process', 'patterm_mcp', 'ask');
    await ask('mcp');
    await waitFor(provider, (snapshot) => snapshot.status === 'permission');
    await provider.replyPermission('process', '41', 'reject');
    await waitFor(provider, (snapshot) => snapshot.status === 'idle');
    await provider.configure('process', 'patterm_mcp', 'allow');
    await provider.configure('process', 'mode', 'plan');
    await ask('mcp');
    await waitFor(provider, (snapshot) => snapshot.status === 'permission');
    await provider.replyPermission('process', '41', 'reject');
    await waitFor(provider, (snapshot) => snapshot.status === 'idle');
    await provider.configure('process', 'mode', 'auto');

    // A new provider instance reconnects to the durable host; a viewer closing
    // its subscription neither stops the CLI nor loses the conversation.
    release(); release = undefined;
    state = await provider.conversation('process');
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
    assert.equal(state.messages.data.find((row: any) => row.id === 'tool:edit').tool.state.error, 'Response stopped');
    // The turn-end frame and the fake CLI recording the cancellation reply
    // travel in opposite directions. Idle alone does not prove that second
    // process has consumed its stdin yet.
    await waitFor(provider, () => frames().some((frame) => frame.id === 42 && frame.result?.outcome?.outcome === 'cancelled'));

    await ask('always');
    state = await waitFor(provider, (snapshot) => snapshot.status === 'permission');
    assert.equal(state.permissions.data[0].alwaysLabel, 'Allow for this session', 'the native approval scope is not relabelled as permanent');
    await provider.replyPermission('process', '41', 'always');
    await waitFor(provider, (snapshot) => snapshot.status === 'idle');

    // A deterministic filesystem failure exercises both local policy commit
    // and native controls changed during a successful turn. Neither may kill
    // the CLI or enable approvals behind a stale Ask picker.
    await provider.configure('process', 'patterm_mcp', 'ask');
    const settingsDirectory = path.join(directory, 'acp', 'settings');
    fs.renameSync(settingsDirectory, settingsDirectory + '.saved');
    fs.writeFileSync(settingsDirectory, 'not a directory');
    try {
      await assert.rejects(provider.configure('process', 'patterm_mcp', 'allow'), /policy was not changed/);
      assert.equal((await selector('patterm_mcp'))?.value, 'ask');
      await ask('mcp');
      await waitFor(provider, (snapshot) => snapshot.status === 'permission');
      await provider.replyPermission('process', '41', 'reject');
      await waitFor(provider, (snapshot) => snapshot.status === 'idle');
      await ask('change-settings');
      state = await waitFor(provider, (snapshot) => snapshot.status === 'idle');
      assert(state.messages.data.some((row: any) => row.id === 'acp-settings-save' && row.level === 'warning'));
      await ask('healthy-after-save-failure');
      await waitFor(provider, (snapshot) => snapshot.status === 'idle');
    } finally {
      fs.rmSync(settingsDirectory);
      fs.renameSync(settingsDirectory + '.saved', settingsDirectory);
    }

    await assert.rejects(provider.prompt('process', { text: 'late', references: [], attachments: [], messageId: 'late-id' }), UncertainDeliveryError);
    await waitFor(provider, (state) => state.status === 'idle');
    assert.equal(await provider.reconcile('process', 'late-id'), 'accepted', 'late native evidence resolves uncertain admission');
    await assert.rejects(provider.prompt('process', { text: 'failure', references: [], attachments: [] }), /Native turn failed/);
    assert.equal((await provider.conversation('process') as any).status, 'error');
    await ask('hello-after-error');
    await waitFor(provider, (snapshot) => snapshot.status === 'idle');
    await provider.configure('process', 'thought_level', 'low');
    await provider.configure('process', 'mode', 'plan');
    await provider.configure('process', 'patterm_mcp', 'ask');
    await ask('change-settings');
    await waitFor(provider, (snapshot) => snapshot.status === 'idle');
    assert.equal((database.connection.prepare("select reasoning from sessions where id = 'session'").get() as any).reasoning, 'low', 'native updates can be newer than launch/recovery fallback columns');

    // A long session's snapshot is the newest page; older rows page back in
    // order, and file edits keep only their changed hunks.
    await ask('flood');
    const flooded = await waitFor(provider, (snapshot) => snapshot.status === 'idle' && snapshot.messages.data.some((row: any) => row.id === 'tool:big-edit'));
    assert(flooded.messages.data.length <= 200, 'the snapshot is bounded');
    assert.equal(flooded.history_truncated, true);
    const edit = flooded.messages.data.find((row: any) => row.id === 'tool:big-edit');
    assert.equal(edit.text, 'big.txt', 'the full file text is not kept in the row');
    assert.equal(edit.tool.input.patch, '--- big.txt\n+++ big.txt\n@@ -23,7 +23,7 @@\n line 22\n line 23\n line 24\n-line 25\n+changed\n line 26\n line 27\n line 28');
    let rows: any[] = flooded.messages.data;
    let cursor: string | null = flooded.history_cursor.next;
    while (cursor) {
      const page = await provider.olderMessages('process', cursor) as any;
      assert(page.messages.data.length > 0 && page.messages.data.length <= 200);
      rows = [...page.messages.data, ...rows];
      cursor = page.cursor;
    }
    const floods = rows.filter((row) => row.id.startsWith('tool:flood-')).map((row) => row.id);
    assert.deepEqual(floods, Array.from({ length: 450 }, (_, i) => `tool:flood-${i}`), 'paging back returns every row once, in order');
    assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
    await assert.rejects(provider.olderMessages('process', `${randomUUID()}:5`), /no longer valid/, 'a cursor from another host is refused');
    const shutdownProvider = new AcpProviderService(database, directory, process.execPath, env, undefined, {
      launch: (input) => hosts.launch(input),
      stopAll: async () => assert(frames().some((frame) => frame.closeFinished), 'the final host sweep follows native session close')
    }, images);
    await shutdownProvider.stopAll();
    await hosts.waitForExit(Number(prepared.argv[3]));
    assert(frames().some((frame) => frame.method === 'session/close'), 'Stop gives the native session a chance to clean up');
    database.connection.prepare("update sessions set exited_at = ? where id = 'session'").run(now);
    const resumed = await provider.prepare({ ...input, model: null, reasoning: null, resumeId: prepared.resumeId });
    assert.equal(resumed.resumeId, prepared.resumeId);
    assert(frames().some((frame) => frame.method === 'session/load'));
    const loaded = await callIntegratedHost(resumed.argv[2]!, 'conversation', {}) as any;
    assert.deepEqual(loaded.messages.data.map((row: any) => row.text), ['Earlier user', 'Earlier assistant']);
    assert.equal(loaded.configOptions.find((option: any) => option.id === 'model').currentValue, 'flash');
    assert.equal(loaded.configOptions.find((option: any) => option.id === 'thought_level').currentValue, 'high');
    assert.equal(loaded.configOptions.find((option: any) => option.id === 'mode').currentValue, 'plan');
    assert.equal(loaded.configOptions.find((option: any) => option.id === 'patterm_mcp').currentValue, 'ask');
    await provider.cleanupLaunch(input, resumed);
    await hosts.waitForExit(Number(resumed.argv[3]));
    const recovery = await provider.prepare({ ...input, model: 'flash-low', reasoning: 'low', resumeId: prepared.resumeId, restoreSavedSettings: true });
    const recoveredSettings = await callIntegratedHost(recovery.argv[2]!, 'conversation', {}) as any;
    assert.equal(recoveredSettings.configOptions.find((option: any) => option.id === 'thought_level').currentValue, 'high', 'stopped-host recovery fallbacks must not undo newer saved native controls');
    await provider.cleanupLaunch(input, recovery);
    await hosts.waitForExit(Number(recovery.argv[3]));
    const override = await provider.prepare({ ...input, model: 'flash-low', reasoning: null, resumeId: prepared.resumeId });
    const overridden = await callIntegratedHost(override.argv[2]!, 'conversation', {}) as any;
    assert.equal(overridden.configOptions.find((option: any) => option.id === 'thought_level').currentValue, 'low', 'saved High thinking does not undo an explicit low-thinking model override');
    await provider.cleanupLaunch(input, override);
    await hosts.waitForExit(Number(override.argv[3]));

    const stuckProvider = new AcpProviderService(database, directory, process.execPath, { ...env, ACP_IGNORE_CANCEL: '1' }, undefined, hosts, images);
    const stuck = await stuckProvider.prepare(input);
    database.connection.prepare("update processes set argv = ? where id = 'process'").run(JSON.stringify(stuck.argv));
    database.connection.prepare("update sessions set exited_at = null where id = 'session'").run();
    await stuckProvider.prompt('process', { text: 'no-cancel-ack', references: [], attachments: [] });
    await stuckProvider.interrupt('process');
    const stalled = await waitFor(stuckProvider, (snapshot) => snapshot.status === 'error');
    assert.match(stalled.status_detail, /did not confirm cancellation/i);
    await assert.rejects(stuckProvider.prompt('process', { text: 'do-not-dispatch', references: [], attachments: [] }), /did not confirm cancellation/i);
    await stuckProvider.stop('process');
    await hosts.waitForExit(Number(stuck.argv[3]));

    // Check the real orchestration boundary, not just the provider's error
    // class: an executed-but-unacknowledged prompt must keep its reservation.
    const crashed = await provider.prepare(input);
    database.connection.prepare("update processes set argv = ?, activity = 'idle' where id = 'process'").run(JSON.stringify(crashed.argv));
    database.connection.prepare("update sessions set exited_at = null where id = 'session'").run();
    const integrated = new IntegratedAgentService(database, { agy: provider });
    try {
      integrated.observe('process');
      const outcome = await integrated.prompt('process', { text: 'crash', messageId: 'crash-id' }) as any;
      assert.equal(outcome.delivery, 'uncertain');
      assert.equal(fs.readFileSync(trace + '.side-effect', 'utf8'), 'executed');
      const reservation = database.connection.prepare('select state from integrated_submissions where message_id = ?').get('crash-id') as { state: string };
      assert.equal(reservation.state, 'uncertain');
      await waitFor(provider, (state) => state.status === 'error' && (database.connection.prepare("select activity from processes where id = 'process'").get() as any).activity === 'error');
      await integrated.conversation('process');
      const activity = (database.connection.prepare("select activity from processes where id = 'process'").get() as { activity: string }).activity;
      assert.equal(activity, 'error');
      assert(isActivityState(activity));
      await assert.rejects(provider.prompt('process', { text: 'do-not-replay', references: [], attachments: [] }), /ACP agent exited/);
    } finally {
      integrated.dispose();
      await provider.stop('process');
      await hosts.waitForExit(Number(crashed.argv[3]));
      database.connection.prepare("update sessions set exited_at = ? where id = 'session'").run(now);
    }

    const acknowledgedFailure = await provider.prepare(input);
    database.connection.prepare("update processes set argv = ?, activity = 'idle' where id = 'process'").run(JSON.stringify(acknowledgedFailure.argv));
    database.connection.prepare("update sessions set exited_at = null where id = 'session'").run();
    const failedTurn = new IntegratedAgentService(database, { agy: provider });
    try {
      failedTurn.observe('process');
      await failedTurn.prompt('process', { text: 'failure-after-echo', messageId: 'acknowledged-failure' });
      await waitFor(provider, (state) => state.status === 'error' && (database.connection.prepare("select activity from processes where id = 'process'").get() as any).activity === 'error');
      await failedTurn.conversation('process');
      assert.equal((database.connection.prepare("select activity from processes where id = 'process'").get() as any).activity, 'error');
      await failedTurn.prompt('process', { text: 'hello-after-acknowledged-error', messageId: 'recovery' });
      await waitFor(provider, (snapshot) => snapshot.status === 'idle');
    } finally {
      failedTurn.dispose();
      await provider.stop('process');
      await hosts.waitForExit(Number(acknowledgedFailure.argv[3]));
      database.connection.prepare("update sessions set exited_at = ? where id = 'session'").run(now);
    }

    const unauthenticated = new AcpProviderService(database, directory, process.execPath, { ...env, ACP_AUTH_FAIL: '1' }, undefined, hosts);
    await assert.rejects(unauthenticated.prepare(input), /Authentication required/);
    const withoutAuto = new AcpProviderService(database, directory, process.execPath, { ...env, ACP_NO_AUTO: '1' }, undefined, hosts);
    const fallback = await withoutAuto.prepare(input);
    const fallbackState = await callIntegratedHost(fallback.argv[2]!, 'conversation', {}) as any;
    assert.equal(fallbackState.configOptions.find((option: any) => option.id === 'mode').currentValue, 'default');
    assert.match(fallbackState.messages.data[0].text, /does not offer auto mode/);
    await withoutAuto.cleanupLaunch(input, fallback);
    await hosts.waitForExit(Number(fallback.argv[3]));

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
