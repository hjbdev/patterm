import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AcpProviderService } from '../app/Services/AcpProviderService';
import { AntigravitySubagentTracker } from '../app/Runtime/AntigravitySubagents';
import { antigravityTranscriptPath, readAntigravityTaskOutput } from '../app/Services/AntigravityTaskOutput';
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
  // Native ACP shapes captured from agy. No real CLI or model is used.
  const executable = writeNodeCli(path.join(directory, 'agy'), String.raw`
const fs = require('node:fs');
const out = frame => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...frame})+'\n');
const result = (id,value={}) => out({id,result:value});
let prompt = null;
let stopAcrossPromptEnd = false;
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
   if(text==='no-live-echo') {
    say('Working before the prompt response');
    update({sessionUpdate:'tool_call',toolCallId:'no-echo-read',name:'read_file',status:'completed'});
    const timer=setInterval(()=>{
     if(!fs.existsSync(process.env.ACP_TRACE+'.no-echo-done')) return;
     clearInterval(timer);result(q.id,{stopReason:'end_turn'});prompt=null;
    },5);
    return;
   }
  if(text==='reject-after-background-update') {
   say('Unrelated background output');
   update({sessionUpdate:'tool_call_update',toolCallId:'deferred',status:'completed'});
   out({id:q.id,error:{code:-32000,message:'Native rejected without accepting'}});prompt=null;return;
  }
  if(text==='crash') {fs.writeFileSync(process.env.ACP_TRACE+'.side-effect','executed');process.exit(17);}
   echo(text);
   if(text==='pdf-attachment') {
    const file = require('node:url').fileURLToPath(q.params.prompt[1].uri);
    say(fs.readFileSync(file,'utf8'));
    const timer = setInterval(() => {
     if(!fs.existsSync(process.env.ACP_TRACE+'.pdf-done')) return;
     clearInterval(timer);result(q.id,{stopReason:'end_turn'});prompt=null;
    },5);
    return;
   }
   if(text==='stop-background'||text==='stop-across-prompt-end') {
    update({sessionUpdate:'tool_call',toolCallId:'stopping-tool',status:'in_progress'});
    stopAcrossPromptEnd = text==='stop-across-prompt-end';
    if(stopAcrossPromptEnd) return;
    result(q.id,{stopReason:'end_turn'});prompt=null;return;
   }
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
      if(suffix==='.end-turn') {
       if(started) update({sessionUpdate:'tool_call_update',toolCallId:'outlives',status:'pending'});
       result(q.id,{stopReason:started?'end_turn':'max_tokens'});prompt=null;update({sessionUpdate:'usage_update',used:314,size:1000});
      }
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
    {method:'session/update',params:{sessionId:'native-session',update:{sessionUpdate:'tool_call',toolCallId:'background',name:'run_command',status:'in_progress'}}},
    {id:43,method:'session/request_permission',params:{sessionId:'native-session',toolCall:{toolCallId:'background',name:'run_command',title:'Background approval'},options:[{optionId:'allow',kind:'allow_once',name:'Allow'}]}}
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
  if(text==='mcp-before-tool-call') {
   out({id:45,method:'session/request_permission',params:{sessionId:'native-session',toolCall:{toolCallId:'early-mcp',name:'mcp_extra_one_mutate',title:'Run mcp_extra_one_mutate'},options:[{optionId:'allow',kind:'allow_once',name:'Allow'}]}});return;
  }
  if(text==='invoke-subagents') {
   update({sessionUpdate:'tool_call',toolCallId:'sub-direct',name:'invoke_subagent',status:'in_progress',rawInput:{Role:'Direct Researcher',TypeName:'research',Model:'flash_lite',Prompt:'Check package version'}});
   update({sessionUpdate:'tool_call_update',toolCallId:'sub-direct',status:'completed',rawOutput:{output:'Created the following subagent:\n{"conversationId":"sub-direct-1"}'}});
   update({sessionUpdate:'tool_call',toolCallId:'sub-log',name:'invoke_subagent',status:'completed',rawInput:{Role:'Log Researcher',TypeName:'self',Prompt:'Inspect transcript'}});
   say('Spawned two subagents.');
   result(q.id,{stopReason:'end_turn'});prompt=null;return;
  }
  if(text==='message-subagent') {
   update({sessionUpdate:'tool_call',toolCallId:'msg-sub',name:'send_message',status:'completed',rawInput:{Recipient:'sub-direct-1',Message:'Follow up'}});
   result(q.id,{stopReason:'end_turn'});prompt=null;return;
  }
  if(text==='kill-subagent') {
   update({sessionUpdate:'tool_call',toolCallId:'kill-sub',name:'manage_subagents',status:'completed',rawInput:{Action:'kill',ConversationIds:['sub-direct-1']}});
   result(q.id,{stopReason:'end_turn'});prompt=null;return;
  }
  if(text==='failure-after-echo') return out({id:q.id,error:{code:-32000,message:'Native acknowledged turn failed'}});
   if(text==='read-permission') {
    out({id:41,method:'session/request_permission',params:{sessionId:'native-session',toolCall:{toolCallId:'read',kind:'read',title:'Read file',rawInput:{Path:'probe.txt'}},options:[{optionId:'allow',kind:'allow_once',name:'Allow'}]}});
    return;
   }
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
    if(stopAcrossPromptEnd) {
     update({sessionUpdate:'tool_call_update',toolCallId:'stopping-tool',status:'pending'});
     result(prompt,{stopReason:'end_turn'});prompt=null;stopAcrossPromptEnd=false;
     update({sessionUpdate:'usage_update',used:2718,size:5000});
     return;
    }
    if(process.env.ACP_IGNORE_CANCEL) return;
    if(!prompt) {
     update({sessionUpdate:'tool_call_update',toolCallId:'stopping-tool',status:'pending'});
     const timer=setInterval(()=>{
      if(!fs.existsSync(process.env.ACP_TRACE+'.cancel-tool-done')) return;
      clearInterval(timer);
      update({sessionUpdate:'tool_call_update',toolCallId:'stopping-tool',status:'in_progress'});
      update({sessionUpdate:'tool_call_update',toolCallId:'stopping-tool',status:'failed'});
     },5);
     return;
    }
   // A late request must not re-open a permission card or be auto-approved.
   out({id:42,method:'session/request_permission',params:{sessionId:'native-session',toolCall:{name:'mcp_patterm_mutate'},options:[{optionId:'allow',kind:'allow_once',name:'Allow'}]}});
  if(prompt) result(prompt,{stopReason:'cancelled'});prompt=null;return;
 }
 if(q.id===43) {
  update({sessionUpdate:'tool_call_update',toolCallId:'background',status:'completed'});
  say('Background work done');return;
 }
 if(q.id===44 && prompt){result(prompt,{stopReason:'end_turn'});prompt=null;}
 if(q.id===45 && prompt){result(prompt,{stopReason:'end_turn'});prompt=null;}
 if(q.id===41 && prompt){
  update({sessionUpdate:'tool_call_update',toolCallId:'edit',status:q.result?.outcome?.optionId==='deny'?'failed':'completed'});
  say(JSON.stringify(q.result));result(prompt,{stopReason:'end_turn'});prompt=null;
 }
});
`);
  const database = new DatabaseService(directory);
  const hosts = new IntegratedTestHosts();
  const env = { ...process.env, HOME: directory, USERPROFILE: directory, ACP_TRACE: trace, PATTERM_ACP_BACKGROUND_QUIET_MS: '1000', PATTERM_ACP_CANCEL_TIMEOUT_MS: '700', PATTERM_ACP_SUBAGENT_POLL_MS: '40' };
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
    const prepared = await provider.prepare({
      ...input,
      mcpServers: [{ id: 'extra', name: 'Extra-One', transport: 'stdio', command: process.execPath, args: ['extra.js'], env: {} }]
    });
    assert.equal(prepared.resumeId, 'native-session');
    assert(!JSON.stringify(prepared.argv).includes('private-identity'));
    database.connection.prepare(`insert into processes (id,project_id,kind,name,status,cwd,argv,created_at,updated_at) values ('process','project','agent','Agy','running',?,?,?,?)`).run(directory, JSON.stringify(prepared.argv), now, now);
    database.connection.prepare(`insert into sessions (id,project_id,process_id,harness,interface_mode,mcp_identity,resume_id,started_at,session_role,resume_status,created_by_actor) values ('session','project','process','agy','integrated','identity',?,?,'orchestrator','found','user')`).run(prepared.resumeId, now);
    const frames = () => fs.readFileSync(trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const creation = frames().find((frame) => frame.method === 'session/new');
    assert.equal(creation.params._meta.antigravity.systemPrompt.append, input.context);
    assert.deepEqual(creation.params.mcpServers.map((server: any) => server.name).sort(), ['Extra-One', 'patterm'], 'all configured servers are delivered');
    assert.deepEqual(creation.params.mcpServers.find((server: any) => server.name === 'patterm').env, [{ name: 'PATTERM_MCP_IDENTITY', value: 'private-identity' }, { name: 'PATTERM_MCP_COMPACT', value: '1' }], 'agy gets the compact Patterm catalogue');
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
    assert(state.messages.data.some((row: any) => row.kind === 'notice' && row.text.includes('may omit MCP tools')));
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
    const pdf = { text: 'pdf-attachment', references: [], messageId: 'pdf-id', attachments: [{ path: path.join(directory, 'a #.pdf'), name: 'a #.pdf', mime: 'application/pdf', size: 11 }] };
    await assert.rejects(provider.prompt('process', pdf), /cannot read.*Attach the PDF again/);
    assert.equal(frames().filter((frame) => frame.method === 'session/prompt').length, count, 'a missing PDF is rejected before dispatch');
    fs.writeFileSync(pdf.attachments[0]!.path, 'staged-file');
    const pdfSend = provider.prompt('process', pdf);
    try {
      await waitFor(provider, (snapshot) => snapshot.messages.data.some((row: any) => row.text === 'staged-file'));
      assert.equal(await provider.reconcile('process', 'pdf-id'), 'unknown', 'text echo and output cannot confirm an attachment send');
    } finally {
      fs.writeFileSync(trace + '.pdf-done', '');
      await pdfSend;
    }
    assert.equal(await provider.reconcile('process', 'pdf-id'), 'accepted');
    state = await waitFor(provider, (snapshot) => snapshot.status === 'idle');
    {
      const rows = state.messages.data as Array<{ clientMessageId?: string; text?: string }>;
      const promptIndex = rows.findIndex((row) => row.clientMessageId === 'pdf-id');
      const replyIndex = rows.findIndex((row) => row.text === 'staged-file');
      assert(promptIndex >= 0 && replyIndex > promptIndex, 'a late-admitted attachment prompt stays before the response it caused');
    }
    assert.deepEqual(frames().filter((frame) => frame.method === 'session/prompt').at(-1).params.prompt[1], { type: 'resource_link', uri: pathToFileURL(path.join(directory, 'a #.pdf')).href, name: 'a #.pdf', mimeType: 'application/pdf' }, 'PDFs use native file reading, not silently ignored binary blobs');

    const ask = (text: string) => provider.prompt('process', { text, references: [], attachments: [] });
    await ask('post-prompt');
    state = await waitFor(provider, (snapshot) => snapshot.messages.data.some((row: any) => row.id === 'tool:background') && snapshot.status !== 'starting');
    assert.equal(state.status, 'permission', 'a background approval after the prompt response still reaches the user');
    assert.equal(state.permissions.data[0]?.action, 'Background approval');
    assert(!frames().some((frame) => frame.id === 43), 'a background non-MCP permission is not auto-approved or cancelled');
    await assert.rejects(ask('follow-up'), TurnBusyError);
    await provider.replyPermission('process', '43', 'once');
    state = await waitFor(provider, (snapshot) => snapshot.messages.data.some((row: any) => row.text === 'Background work done'));
    assert.equal(state.status, 'working', 'background output keeps the session active');
    assert.equal(state.status_detail, 'Recent background activity');
    await assert.rejects(ask('follow-up'), TurnBusyError);
    await waitFor(provider, (snapshot) => snapshot.status === 'idle');
    await ask('stop-background');
    await waitFor(provider, (snapshot) => snapshot.status_detail === 'Background tools running…');
    await provider.interrupt('process');
    state = await waitFor(provider, (snapshot) => snapshot.messages.data.some((row: any) => row.id === 'tool:stopping-tool' && row.tool.state.status === 'pending'));
    assert.equal(state.status_detail, 'Stopping…', 'a pending update cannot acknowledge Stop');
    await assert.rejects(ask('not-during-stop'), TurnBusyError);
    fs.writeFileSync(trace + '.cancel-tool-done', '');
    await waitFor(provider, (snapshot) => snapshot.status === 'idle');
    assert(events.some((event) => event.kind === 'status' && event.detail === 'Background tools running…'), 'background status reaches live subscribers');
    await ask('delayed-approval');
    await waitFor(provider, (snapshot) => snapshot.status === 'idle' && snapshot.messages.data.some((row: any) => row.id === 'tool:deferred'));
    await ask('overlapping-follow-up');
    state = await waitFor(provider, (snapshot) => snapshot.status === 'idle' && frames().some((frame) => frame.id === 44));
    assert.deepEqual(frames().find((frame) => frame.id === 44)?.result, { outcome: { outcome: 'selected', optionId: 'allow' } }, 'Allow MCP tools covers work agy does after a prompt ends');
    assert.equal(state.permissions.data.length, 0);
    const queue = new IntegratedAgentService(database, { agy: provider });
    try {
      queue.observe('process');
      await ask('tool-outlives-prompt');
      assert.equal((await queue.prompt('process', { text: 'after-outliving-tool', messageId: 'held-after-tool' }) as any).delivery, 'queued');
      fs.writeFileSync(trace + '.end-turn', '');
      await waitFor(provider, (snapshot) => snapshot.usage.contextTokens === 314);
      state = await provider.conversation('process');
      assert.equal(state.status_detail, 'Background tools running…');
      assert.equal(state.messages.data.find((row: any) => row.id === 'tool:outlives').tool.state.status, 'pending', 're-announcing a known running tool as pending does not abandon it');
      assert(!frames().some((frame) => frame.method === 'session/prompt' && frame.params.prompt[0].text === 'after-outliving-tool'));
      fs.writeFileSync(trace + '.complete-tool', '');
      await waitFor(provider, (snapshot) => snapshot.status === 'idle' && snapshot.messages.data.some((row: any) => row.clientMessageId === 'held-after-tool'));
      fs.unlinkSync(trace + '.end-turn');
      await ask('tool-never-starts');
      assert.equal((await queue.prompt('process', { text: 'after-unstarted-tool', messageId: 'held-after-unstarted' }) as any).delivery, 'queued');
      fs.writeFileSync(trace + '.end-turn', '');
      state = await waitFor(provider, (snapshot) => snapshot.status === 'idle' && snapshot.messages.data.some((row: any) => row.clientMessageId === 'held-after-unstarted'));
      assert.equal(state.messages.data.find((row: any) => row.id === 'tool:unstarted').tool.state.status, 'failed');
      fs.unlinkSync(trace + '.end-turn');
      await ask('tool-never-starts');
      const rejected = { text: 'reject-after-background-update', messageId: 'held-rejected' };
      assert.equal((await queue.prompt('process', rejected) as any).delivery, 'queued');
      fs.writeFileSync(trace + '.end-turn', '');
      await waitFor(provider, () => Boolean(database.connection.prepare("select 1 from integrated_held_prompts where message_id = 'held-rejected' and error is not null").get()));
      assert.equal(await provider.reconcile('process', 'held-rejected'), 'unknown');
      assert.equal(frames().filter((frame) => frame.method === 'session/prompt' && frame.params.prompt[0].text === rejected.text).length, 1);
      await queue.updateQueued('process', 'held-rejected', 'cancel');
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
    await ask('mcp-before-tool-call');
    await waitFor(provider, (snapshot) => snapshot.status === 'idle' && frames().some((frame) => frame.id === 45));
    assert.deepEqual(frames().find((frame) => frame.id === 45)?.result, { outcome: { outcome: 'selected', optionId: 'allow' } }, 'Auto approves MCP requests arriving before tool_call and with normalised server names');
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

    await ask('read-permission');
    state = await waitFor(provider, (snapshot) => snapshot.status === 'permission');
    assert.equal(state.permissions.data[0].tool_kind, 'read');
    assert.equal(state.permissions.data[0].once, true);
    assert.deepEqual(state.permissions.data[0].resources, ['probe.txt']);
    await provider.replyPermission('process', state.permissions.data[0].id, 'once');
    await waitFor(provider, (snapshot) => snapshot.status === 'idle');

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

    // agy 1.5.12 records the input in its transcript but does not echo it
    // over ACP. Keep the RPC open until delivery is verified.
    const nativeLog = path.join(directory, '.gemini', 'antigravity-cli', 'brain', prepared.resumeId!, '.system_generated', 'logs', 'transcript.jsonl');
    fs.mkdirSync(path.dirname(nativeLog), { recursive: true });
    const inputRow = (step: number, created_at = new Date().toISOString()) => JSON.stringify({ step_index: step, created_at, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '<USER_REQUEST>\nno-live-echo\n</USER_REQUEST>\n' });
    fs.writeFileSync(nativeLog, inputRow(0) + '\n');
    const noEcho = provider.prompt('process', { text: 'no-live-echo', references: [], attachments: [], messageId: 'logged-id' });
    void noEcho.catch(() => {});
    await waitFor(provider, (snapshot) => snapshot.messages.data.some((row: any) => row.id === 'tool:no-echo-read'));
    assert.equal(await provider.reconcile('process', 'logged-id'), 'unknown', 'old identical text and live assistant activity are not delivery evidence');
    fs.appendFileSync(nativeLog, inputRow(1, '2024-01-01T00:00:00Z') + '\n' + inputRow(2) + '\n');
    await noEcho;
    assert.equal(await provider.reconcile('process', 'logged-id'), 'accepted');
    state = await provider.conversation('process');
    assert.equal(state.status, 'working', 'delivery does not finish the turn');
    assert.equal(state.messages.data.filter((row: any) => row.clientMessageId === 'logged-id').length, 1);
    {
      const rows = state.messages.data as Array<{ id?: string; clientMessageId?: string; text?: string }>;
      const promptIndex = rows.findIndex((row) => row.clientMessageId === 'logged-id');
      const replyIndex = rows.findIndex((row) => row.text === 'Working before the prompt response');
      const toolIndex = rows.findIndex((row) => row.id === 'tool:no-echo-read');
      assert(promptIndex >= 0 && replyIndex > promptIndex && toolIndex > promptIndex, 'a prompt confirmed from its native receipt stays before assistant output that streamed first');
    }
    fs.writeFileSync(trace + '.no-echo-done', '');
    await waitFor(provider, (snapshot) => snapshot.status === 'idle');

    // Antigravity native subagents: discovered from ACP output or parent
    // transcript.jsonl, tailed for nested child rows, surfaced in snapshot
    // tasks, and readable through taskOutput with session ownership checks.
    const subDirectLog = path.join(directory, '.gemini', 'antigravity-cli', 'brain', 'sub-direct-1', '.system_generated', 'logs', 'transcript.jsonl');
    const subLogLog = path.join(directory, '.gemini', 'antigravity-cli', 'brain', 'sub-log-2', '.system_generated', 'logs', 'transcript.jsonl');
    fs.mkdirSync(path.dirname(subDirectLog), { recursive: true });
    fs.mkdirSync(path.dirname(subLogLog), { recursive: true });
    fs.writeFileSync(subDirectLog, [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: now, content: '<USER_REQUEST>\nCheck package version\n</USER_REQUEST>\n' },
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: now, thinking: 'Reading package.json', tool_calls: [{ name: 'read_file', args: { Path: '"package.json"' } }] },
      { step_index: 2, source: 'MODEL', type: 'GENERIC', created_at: now, content: 'Created At: 2026-11-20T19:00:00+01:00\nCompleted At: 2026-11-20T19:00:01+01:00\n{"version":"0.5.0"}', status: 'DONE' }
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    fs.writeFileSync(subLogLog, [
      { step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: now, content: 'Transcript looks clean.' }
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    fs.appendFileSync(nativeLog, [
      { step_index: 10, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: now, tool_calls: [
        { name: 'invoke_subagent', args: { Role: '"Direct Researcher"', TypeName: '"research"', Prompt: '"Check package version"' } },
        { name: 'invoke_subagent', args: { Role: '"Log Researcher"', TypeName: '"self"', Prompt: '"Inspect transcript"' } }
      ] },
      { step_index: 11, source: 'MODEL', type: 'GENERIC', created_at: now, content: 'Created the following subagent:\n{"conversationId":"sub-direct-1"}', status: 'DONE' },
      { step_index: 12, source: 'MODEL', type: 'GENERIC', created_at: now, content: 'Created the following subagent:\n{"conversationId":"sub-log-2"}', status: 'DONE' }
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    await ask('invoke-subagents');
    state = await waitFor(provider, (snapshot) =>
      snapshot.status === 'idle'
      && (snapshot.tasks ?? []).some((task: any) => task.id === 'sub-direct-1')
      && (snapshot.tasks ?? []).some((task: any) => task.id === 'sub-log-2')
      && snapshot.messages.data.some((row: any) => row.parentId === 'tool:sub-direct' && row.kind === 'tool')
      && snapshot.messages.data.some((row: any) => row.parentId === 'tool:sub-log' && row.text === 'Transcript looks clean.')
    );
    const directTask = state.tasks.find((task: any) => task.id === 'sub-direct-1');
    assert.equal(directTask.label, 'Direct Researcher');
    assert.equal(directTask.kind, 'research');
    assert.equal(directTask.status, 'running');
    assert.equal(directTask.stoppable, false);
    const nestedRead = state.messages.data.find((row: any) => row.parentId === 'tool:sub-direct' && row.kind === 'tool');
    assert.equal(nestedRead.tool.name, 'read_file');
    assert.equal(nestedRead.text, '{"version":"0.5.0"}');
    assert.equal(nestedRead.tool.state.status, 'completed');

    // A parent SYSTEM_MESSAGE from the subagent marks it completed; send_message
    // re-opens it to running; manage_subagents kill marks it stopped.
    fs.appendFileSync(nativeLog, JSON.stringify({
      step_index: 13, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', created_at: now,
      content: '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-20T19:00:02Z sender=sub-direct-1 priority=MESSAGE_PRIORITY_HIGH content=Version is 0.5.0\n</SYSTEM_MESSAGE>'
    }) + '\n');
    state = await waitFor(provider, (snapshot) => snapshot.tasks.find((task: any) => task.id === 'sub-direct-1')?.status === 'completed');
    assert.equal(state.tasks.find((task: any) => task.id === 'sub-direct-1').detail, 'Version is 0.5.0');
    await ask('message-subagent');
    state = await waitFor(provider, (snapshot) => snapshot.status === 'idle' && snapshot.tasks.find((task: any) => task.id === 'sub-direct-1')?.status === 'running');
    await ask('kill-subagent');
    state = await waitFor(provider, (snapshot) => snapshot.status === 'idle' && snapshot.tasks.find((task: any) => task.id === 'sub-direct-1')?.status === 'stopped');

    const subOutput = await provider.taskOutput('process', 'sub-direct-1');
    assert.equal(subOutput.format, 'transcript');
    assert(subOutput.format === 'transcript' && subOutput.archived_messages.length >= 3);
    assert.equal((await provider.taskOutput('process', 'sub-direct-1', subOutput.format === 'transcript' ? subOutput.version : null)).format, 'unchanged');
    await assert.rejects(provider.taskOutput('process', 'other-session-subagent'), /does not belong/);

    // A file that appears after dispatch can contain historical input.
    fs.unlinkSync(nativeLog);
    fs.unlinkSync(trace + '.no-echo-done');
    const replayed = provider.prompt('process', { text: 'no-live-echo', references: [], attachments: [], messageId: 'replayed-log-id' });
    void replayed.catch(() => {});
    await waitFor(provider, () => frames().filter((frame) => frame.method === 'session/prompt' && frame.params.prompt[0].text === 'no-live-echo').length === 2);
    fs.writeFileSync(nativeLog, inputRow(1, '2024-01-01T00:00:00Z') + '\n');
    await assert.rejects(replayed, UncertainDeliveryError, 'a historical row in a newly created file does not confirm delivery');
    fs.writeFileSync(trace + '.no-echo-done', '');
    await waitFor(provider, (snapshot) => snapshot.status === 'idle');

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
    await stuckProvider.prompt('process', { text: 'stop-across-prompt-end', references: [], attachments: [] });
    await stuckProvider.interrupt('process');
    const stopping = await waitFor(stuckProvider, (snapshot) => snapshot.usage.contextTokens === 2718);
    assert.equal(stopping.status_detail, 'Stopping…', 'the natural end of the prompt does not acknowledge cancellation of a still-running tool');
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
    let releaseFailedTurn: (() => void) | undefined;
    try {
      failedTurn.observe('process');
      releaseFailedTurn = await failedTurn.subscribeConversation('process', () => {});
      await failedTurn.prompt('process', { text: 'failure-after-echo', messageId: 'acknowledged-failure' });
      await waitFor(provider, (state) => state.status === 'error' && (database.connection.prepare("select activity from processes where id = 'process'").get() as any).activity === 'error');
      await failedTurn.conversation('process');
      assert.equal((database.connection.prepare("select activity from processes where id = 'process'").get() as any).activity, 'error');
      await failedTurn.prompt('process', { text: 'hello-after-acknowledged-error', messageId: 'recovery' });
      await waitFor(provider, (snapshot) => snapshot.status === 'idle');
    } finally {
      releaseFailedTurn?.();
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
      { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: now, tool_calls: [{ name: 'write_file', args: { Path: '"a.txt"', Content: '"new"' } }, { name: 'read_file', args: { Path: '"b.txt"' } }] },
      { step_index: 3, source: 'MODEL', type: 'GENERIC', created_at: now, content: 'Created file.', status: 'DONE' },
      { step_index: 4, source: 'MODEL', type: 'GENERIC', created_at: now, content: 'Read b.txt.', status: 'DONE' },
      { step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: now, thinking: 'Internal reasoning', content: 'Done.' }
    ];
    fs.writeFileSync(log, nativeRows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    fs.copyFileSync(log, path.join(logDirectory, 'transcript_full.jsonl'));
    const adapter = new AntigravityHistoryAdapter();
    assert.equal(adapter.parserVersion, 'agy-jsonl-v2');
    assert.deepEqual(adapter.discoverFiles(path.join(directory, 'native-history')), [log]);
    const history = adapter.parseFile(log).conversations[0]!;
    assert.equal(history.providerConversationId, 'native-history');
    assert.equal(history.messages[0]?.text, 'Hello');
    assert.equal(history.messages[2]?.kind, 'tool_call');
    assert.equal(history.messages[2]?.toolInputSummary, '{"Path":"a.txt","Content":"new"}');
    assert.equal(history.messages[3]?.toolName, 'read_file');
    assert.equal(history.messages[4]?.kind, 'tool_result');
    assert.equal(history.messages[4]?.toolName, 'write_file');
    assert.equal(history.messages[4]?.metadata?.callId, history.messages[2]?.metadata?.callId);
    assert.equal(history.messages[5]?.kind, 'tool_result');
    assert.equal(history.messages[5]?.toolName, 'read_file');
    assert.equal(history.messages[5]?.metadata?.callId, history.messages[3]?.metadata?.callId);
    assert.equal(history.messages[6]?.metadata?.type, 'reasoning');
    assert.equal(history.messages[6]?.text, 'Internal reasoning');
    assert.equal(history.usage?.[0]?.inputTokens, 10);
    assert(!JSON.stringify(history).includes('hidden'));

    // Edge cases for subagent pairing, mid-turn progress updates, multi-chunk
    // resume, oversized JSONL records, and drawer page boundaries.
    const trackerHome = path.join(directory, 'tracker-edge-cases');
    const trackerEnv = { HOME: trackerHome };
    const appendLog = (id: string, ...rows: unknown[]) => {
      const target = antigravityTranscriptPath(id, trackerEnv)!;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.appendFileSync(target, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    };
    const modelRow = (step_index: number, fields: Record<string, unknown>) => ({ step_index, source: 'MODEL', type: 'PLANNER_RESPONSE', ...fields });
    const invokeCall = (role: string) => ({ name: 'invoke_subagent', args: { Role: JSON.stringify(role) } });
    const invokeResult = (step_index: number, id: string) => ({ step_index, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: `Created the following subagent:\n${JSON.stringify({ conversationId: id })}` });
    const edgeTrackers: AntigravitySubagentTracker[] = [];
    try {
      // Direct ACP link must clear pending unlinked invoke so the next log-first child keeps its own row.
      const linkRows = new Map<string, any>();
      const linkTracker = new AntigravitySubagentTracker({ sessionId: 'edge-parent-a', hostEnv: trackerEnv, pollMs: 25, onMessage: (row) => linkRows.set(row.id, row), onTasksChanged: () => {} });
      edgeTrackers.push(linkTracker);
      appendLog('edge-child-a', modelRow(0, { content: 'Alpha output' }));
      appendLog('edge-child-b', modelRow(0, { content: 'Beta output' }));
      linkTracker.observeToolCall('tool:alpha', 'invoke_subagent', { Role: 'Alpha' }, '', null);
      linkTracker.observeToolCall('tool:alpha', 'invoke_subagent', { Role: 'Alpha' }, '', { conversationId: 'edge-child-a' });
      appendLog('edge-parent-a', modelRow(0, { tool_calls: [invokeCall('Alpha'), invokeCall('Beta')] }), invokeResult(1, 'edge-child-a'), invokeResult(2, 'edge-child-b'));
      linkTracker.syncNow();
      linkTracker.observeToolCall('tool:beta', 'invoke_subagent', { Role: 'Beta' }, '', null);
      assert.equal([...linkRows.values()].find((row) => row.text === 'Alpha output')?.parentId, 'tool:alpha');
      assert.equal([...linkRows.values()].find((row) => row.text === 'Beta output')?.parentId, 'tool:beta');

      // A mid-turn send_message progress update must not mark the child done or stop tailing.
      const progressRows = new Map<string, any>();
      const progressTracker = new AntigravitySubagentTracker({ sessionId: 'edge-parent-b', hostEnv: trackerEnv, pollMs: 25, onMessage: (row) => progressRows.set(row.id, row), onTasksChanged: () => {} });
      edgeTrackers.push(progressTracker);
      appendLog('edge-working-child', modelRow(0, { tool_calls: [{ name: 'send_message', args: {} }] }));
      progressTracker.observeToolCall('tool:worker', 'invoke_subagent', { Role: 'Worker' }, '', { conversationId: 'edge-working-child' });
      appendLog('edge-parent-b', { step_index: 0, type: 'SYSTEM_MESSAGE', source: 'SYSTEM', content: '<SYSTEM_MESSAGE>\n[Message] sender=edge-working-child content=Still working\n</SYSTEM_MESSAGE>' });
      progressTracker.syncNow();
      appendLog('edge-working-child', modelRow(1, { content: 'More work after update' }));
      progressTracker.syncNow();
      assert.equal(progressTracker.tasks()[0]?.status, 'running');
      assert.equal(progressRows.has('sub:edge-working-child:1:text'), true);

      // Resumed transcripts larger than 1 MiB drain past the first chunk automatically.
      const resumeTracker = new AntigravitySubagentTracker({ sessionId: 'edge-resumed-parent', hostEnv: trackerEnv, pollMs: 25, onMessage: () => {}, onTasksChanged: () => {} });
      edgeTrackers.push(resumeTracker);
      appendLog('edge-resumed-parent', modelRow(0, { thinking: 'a'.repeat(550_000) }), modelRow(1, { thinking: 'b'.repeat(550_000) }), modelRow(2, { tool_calls: [invokeCall('Resumed')] }), invokeResult(3, 'edge-resumed-child'));
      resumeTracker.syncNow(true);
      assert.deepEqual(resumeTracker.tasks().map((task) => task.id), ['edge-resumed-child']);

      // A single JSONL record larger than 1 MiB still completes its tool call and advances past it.
      const largeRows = new Map<string, any>();
      const largeTracker = new AntigravitySubagentTracker({ sessionId: 'edge-parent-d', hostEnv: trackerEnv, pollMs: 25, onMessage: (row) => largeRows.set(row.id, row), onTasksChanged: () => {} });
      edgeTrackers.push(largeTracker);
      appendLog('edge-large-child', modelRow(0, { tool_calls: [{ name: 'read_file', args: {} }] }));
      largeTracker.observeToolCall('tool:large', 'invoke_subagent', {}, '', { conversationId: 'edge-large-child' });
      appendLog('edge-large-child', { step_index: 1, type: 'GENERIC', source: 'MODEL', status: 'DONE', content: 'x'.repeat(1024 * 1024) }, modelRow(2, { content: 'Later row' }));
      largeTracker.syncNow();
      assert.equal(largeRows.get('sub:edge-large-child:0:tool:0')?.tool?.state?.status, 'completed');
      assert.equal(largeRows.has('sub:edge-large-child:2:text'), true);

      // Same-role parallel children with distinct prompts must never cross-link.
      const sameRoleRows = new Map<string, any>();
      const sameRoleTracker = new AntigravitySubagentTracker({ sessionId: 'edge-same-role', hostEnv: trackerEnv, pollMs: 25, onMessage: (row) => sameRoleRows.set(row.id, row), onTasksChanged: () => {} });
      edgeTrackers.push(sameRoleTracker);
      appendLog('edge-sr-alpha', modelRow(0, { content: 'Alpha reply' }));
      appendLog('edge-sr-beta', modelRow(0, { content: 'Beta reply' }));
      appendLog(
        'edge-same-role',
        modelRow(0, { tool_calls: [
          { name: 'invoke_subagent', args: { Role: '"Reviewer"', Prompt: '"Review alpha"' } },
          { name: 'invoke_subagent', args: { Role: '"Reviewer"', Prompt: '"Review beta"' } }
        ] }),
        invokeResult(1, 'edge-sr-alpha')
      );
      sameRoleTracker.syncNow();
      sameRoleTracker.observeToolCall('tool:sr-beta', 'invoke_subagent', { Role: 'Reviewer', Prompt: 'Review beta' }, '', null);
      sameRoleTracker.observeToolCall('tool:sr-beta', 'invoke_subagent', { Role: 'Reviewer', Prompt: 'Review beta' }, '', { conversationId: 'edge-sr-beta' });
      sameRoleTracker.observeToolCall('tool:sr-alpha', 'invoke_subagent', { Role: 'Reviewer', Prompt: 'Review alpha' }, '', { conversationId: 'edge-sr-alpha' });
      appendLog('edge-same-role', invokeResult(2, 'edge-sr-beta'));
      sameRoleTracker.syncNow();
      assert.equal([...sameRoleRows.values()].find((row) => row.text === 'Alpha reply')?.parentId, 'tool:sr-alpha');
      assert.equal([...sameRoleRows.values()].find((row) => row.text === 'Beta reply')?.parentId, 'tool:sr-beta');

      // Coalesced send_message + subsequent short tool before poll must stay running and stream later replies.
      const coalescedRows = new Map<string, any>();
      const coalescedTracker = new AntigravitySubagentTracker({ sessionId: 'edge-coalesced', hostEnv: trackerEnv, pollMs: 25, onMessage: (row) => coalescedRows.set(row.id, row), onTasksChanged: () => {} });
      edgeTrackers.push(coalescedTracker);
      appendLog(
        'edge-coalesced-child',
        modelRow(0, { tool_calls: [{ name: 'send_message', args: {} }] }),
        { step_index: 1, type: 'GENERIC', source: 'MODEL', status: 'DONE', content: 'Message sent' },
        modelRow(2, { tool_calls: [{ name: 'read_file', args: {} }] }),
        { step_index: 3, type: 'GENERIC', source: 'MODEL', status: 'DONE', content: 'File read' }
      );
      coalescedTracker.observeToolCall('tool:coalesced', 'invoke_subagent', {}, '', { conversationId: 'edge-coalesced-child' });
      appendLog('edge-coalesced', { step_index: 0, type: 'SYSTEM_MESSAGE', source: 'SYSTEM', content: '<SYSTEM_MESSAGE>\n[Message] sender=edge-coalesced-child content=Still inspecting\n</SYSTEM_MESSAGE>' });
      coalescedTracker.syncNow();
      appendLog('edge-coalesced-child', modelRow(4, { content: 'Final reply' }));
      await new Promise((resolve) => setTimeout(resolve, 125));
      assert.equal(coalescedTracker.tasks()[0]?.status, 'running');
      assert.equal(coalescedRows.has('sub:edge-coalesced-child:4:text'), true);

      // Drawer pagination keeps a tool_call and its tool_result in the same page.
      appendLog(
        'edge-drawer-child',
        modelRow(0, { status: 'DONE', tool_calls: [{ name: 'read_file', args: { Path: '"probe.txt"' } }] }),
        { step_index: 1, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'Probe result' },
        ...Array.from({ length: 199 }, (_, index) => modelRow(index + 2, { content: `Child reply ${index}` }))
      );
      const drawerPage = readAntigravityTaskOutput('edge-drawer-child', trackerEnv);
      assert.equal(drawerPage.format, 'transcript');
      if (drawerPage.format === 'transcript') {
        assert.equal(drawerPage.cursor, null);
        assert.equal(drawerPage.archived_messages.length, 201);
      }
    } finally {
      edgeTrackers.forEach((tracker) => tracker.stop());
    }
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
