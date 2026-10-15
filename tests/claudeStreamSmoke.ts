import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { CloseProcessAction } from '../app/Actions/CloseProcessAction';
import { DatabaseService } from '../app/Services/DatabaseService';
import { ClaudeStreamService } from '../app/Services/ClaudeStreamService';
import { TranscriptImageStore } from '../app/Services/TranscriptImageStore';
import { IntegratedAgentService } from '../app/Services/IntegratedAgentService';
import { integratedHostListening } from '../app/Services/IntegratedHostLauncher';
import type { IntegratedConversationEvent } from '../app/Services/IntegratedConversation';
import type { TerminalService } from '../app/Services/TerminalService';
import { normaliseMessages } from '../resources/js/lib/integratedConversation';
import { ipcPath } from '../app/Platform/Ipc';
import { writeNodeCli } from './fixtures/IntegratedFakeCli';

async function main(): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-claude-stream-'));
  const executable = writeNodeCli(path.join(directory, 'claude'), `if (process.env.ARGV_FILE) require('node:fs').writeFileSync(process.env.ARGV_FILE, JSON.stringify(process.argv.slice(2)));
// ACTIVITY scripts native turn shapes recorded from Claude Code 2.1.299. Like
// the real CLI, session states are reported only when the host asks for them,
// and command_lifecycle frames only in that mode here so the fallback is tested.
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const reportsState = process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS === '1';
const state = (value) => { if (reportsState) out({type:'system',subtype:'session_state_changed',state:value}); };
const lifecycle = (uuid, value) => { if (reportsState) out({type:'command_lifecycle',command_uuid:uuid,state:value}); };
const level = (tasks) => out({type:'system',subtype:'background_tasks_changed',tasks});
const say = (id, text, parent) => out({type:'assistant',parent_tool_use_id:parent || null,message:{id,content:[{type:'text',text}]}});
const begin = (uuid) => { globalThis.turn = true; state('running'); lifecycle(uuid,'queued'); lifecycle(uuid,'started'); out({type:'system',subtype:'init'}); out({type:'stream_event',event:{type:'message_start',message:{id:'msg_' + uuid}}}); };
const end = (uuid, extra) => { globalThis.turn = false; out({type:'result',is_error:false,subtype:'success',...(uuid ? {user_message_uuid:uuid} : {}),...extra}); if (uuid) lifecycle(uuid,'completed'); };
// A turn Claude starts by itself when a background task finishes. Its session
// reports running again only if it had gone idle.
const wake = (text, fromIdle, hold) => {
  globalThis.turn = true;
  if (fromIdle) state('running');
  out({type:'system',subtype:'init'});
  out({type:'stream_event',event:{type:'message_start',message:{id:'msg_wake_' + text}}});
  say('msg_wake_' + text, text);
  if (!hold) { end(null); state('idle'); }
};
if (process.env.ENV_FILE) require('node:fs').writeFileSync(process.env.ENV_FILE, JSON.stringify({sessionState:process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS ?? null}));
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    const frame = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
    if (process.env.ACTIVITY && event.type === 'control_request' && event.request && event.request.subtype === 'interrupt') {
      // An interrupt ends a running turn with error_during_execution; with
      // nothing running there is no result, only another idle report.
      if (globalThis.turn) { globalThis.turn = false; frame({type:'result',is_error:true,subtype:'error_during_execution'}); }
      state('idle');
      continue;
    }
    if (process.env.ACTIVITY && event.type === 'control_response') {
      const answered = event.response.request_id;
      if (answered === 'main_perm') {
        state('running');
        frame({type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'toolu_write',content:'Written'}]}});
        for (const uuid of globalThis.queued || []) lifecycle(uuid, 'started');
        say('msg_after_permission', 'after permission');
        for (const uuid of globalThis.queued || []) lifecycle(uuid, 'completed');
        globalThis.queued = [];
        end(globalThis.first);
        state('idle');
      } else if (answered === 'sub_perm') {
        state('running');
        frame({type:'user',parent_tool_use_id:'toolu_agent',message:{role:'user',content:[{type:'tool_result',tool_use_id:'toolu_sub_bash',content:'ok'}]}});
        setTimeout(() => {
          frame({type:'system',subtype:'task_notification',task_id:'agent_ask',status:'completed',output_file:'/tmp/out',summary:'done'});
          level([]);
          wake('finished after permission', false);
        }, 40);
      }
      continue;
    }
    if (process.env.ACTIVITY && event.type === 'user') {
      const uuid = event.uuid;
      const text = event.message.content[0].text;
      if (text === 'wake') {
        begin(uuid); say('msg_started', 'started'); end(uuid); state('idle');
        setTimeout(() => wake('woken', true), 60);
      } else if (text === 'wake and hold') {
        begin(uuid); say('msg_started_hold', 'started'); end(uuid); state('idle');
        setTimeout(() => wake('held', true, true), 60);
      } else if (text === 'wake before stream') {
        begin(uuid); end(uuid); state('idle');
        setTimeout(() => {
          globalThis.turn = true;
          state('running');
          lifecycle('native-autonomous-command', 'started');
          frame({type:'system',subtype:'notification',uuid:'autonomous_started',text:'Autonomous command started'});
        }, 60);
      } else if (text === 'background only') {
        begin(uuid);
        level([{task_id:'agent_held',task_type:'local_agent'}]);
        end(uuid);
        frame({type:'system',subtype:'notification',uuid:'background_only',text:'Only background activity remains'});
      } else if (text === 'wake tool') {
        begin(uuid); end(uuid); state('idle');
        setTimeout(() => {
          globalThis.turn = true;
          // A tool-only response without partial or session-state events.
          frame({type:'assistant',message:{id:'msg_woken_bash',content:[{type:'tool_use',id:'toolu_woken_bash',name:'Bash',input:{command:'sleep 60'}}]}});
        }, 60);
      } else if (text === 'agent') {
        // A background agent outlives the turn; the session stays running
        // until the turn it wakes has ended.
        begin(uuid);
        level([{task_id:'agent_1',task_type:'local_agent',subagent_type:'general-purpose',description:'Explore'}]);
        frame({type:'system',subtype:'task_started',task_id:'agent_1',task_type:'local_agent',description:'Explore',is_backgrounded:true});
        say('msg_launched', 'launched'); end(uuid);
        setTimeout(() => {
          say('msg_sub_work', 'sub work', 'toolu_agent');
          setTimeout(() => {
            frame({type:'system',subtype:'task_notification',task_id:'agent_1',status:'completed',output_file:'/tmp/out',summary:'done'});
            level([]);
            wake('finished', false);
          }, 40);
        }, 40);
      } else if (text === 'bash before result') {
        begin(uuid);
        // A session-level idle report must not end an unfinished turn.
        // Retire the command too, so the prompt map cannot mask the bug.
        frame({type:'assistant',message:{id:'msg_bash',content:[{type:'tool_use',id:'toolu_bash',name:'Bash',input:{command:'sleep 60'}}]}});
        lifecycle(uuid, 'completed');
        state('idle');
      } else if (text === 'finish bash') {
        lifecycle(uuid, 'completed');
        frame({type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'toolu_bash',content:'done'}]}});
        // Check the model's next step too, after Bash itself has completed.
        say('msg_after_bash', 'continuing');
      } else if (text === 'finish turn') {
        end(uuid); state('idle');
      } else if (text === 'shell') {
        begin(uuid);
        level([{task_id:'shell_1',task_type:'local_bash',description:'npm run dev'}]);
        frame({type:'system',subtype:'task_started',task_id:'shell_1',task_type:'local_bash',description:'npm run dev',is_backgrounded:true});
        say('msg_serving', 'serving'); end(uuid); state('idle');
      } else if (text === 'ask') {
        globalThis.first = uuid;
        begin(uuid);
        frame({type:'assistant',message:{id:'msg_write',content:[{type:'tool_use',id:'toolu_write',name:'Write',input:{file_path:'/tmp/a.txt',content:'hi'}}]}});
        state('requires_action');
        frame({type:'control_request',request_id:'main_perm',request:{subtype:'can_use_tool',tool_name:'Write',tool_use_id:'toolu_write',input:{file_path:'/tmp/a.txt',content:'hi'}}});
      } else if (text === 'extra') {
        // A prompt sent while a request waits is queued behind it.
        globalThis.queued = [...(globalThis.queued || []), uuid];
        lifecycle(uuid, 'queued');
      } else if (text === 'agent ask') {
        begin(uuid);
        frame({type:'assistant',message:{id:'msg_agent',content:[{type:'tool_use',id:'toolu_agent',name:'Agent',input:{run_in_background:true}}]}});
        level([{task_id:'agent_ask',task_type:'local_agent',subagent_type:'general-purpose',description:'Write'}]);
        frame({type:'system',subtype:'task_started',task_id:'agent_ask',task_type:'local_agent',description:'Write',is_backgrounded:true});
        frame({type:'assistant',parent_tool_use_id:'toolu_agent',message:{id:'msg_sub_bash',content:[{type:'tool_use',id:'toolu_sub_bash',name:'Bash',input:{command:'npm test'}}]}});
        state('requires_action');
        frame({type:'control_request',request_id:'sub_perm',request:{subtype:'can_use_tool',tool_name:'Bash',tool_use_id:'toolu_sub_bash',agent_id:'agent_ask',input:{command:'npm test'}}});
        say('msg_agent_launched', 'launched'); end(uuid);
      } else if (text === 'fail') {
        begin(uuid);
        globalThis.turn = false;
        frame({type:'result',is_error:true,subtype:'error_during_execution',result:'Network failure',user_message_uuid:uuid});
        lifecycle(uuid, 'cancelled'); state('idle');
      } else if (text === 'refused') {
        lifecycle(uuid, 'refused');
      } else if (text === 'crash') {
        // The CLI dies while a background agent it started is running.
        begin(uuid);
        frame({type:'system',subtype:'task_started',task_id:'agent_crash',task_type:'local_agent',description:'Explore',is_backgrounded:true});
        say('msg_crash', 'launched');
        setTimeout(() => process.exit(1), 20);
      } else if (text === 'after crash') {
        begin(uuid); say('msg_after_crash', 'resumed'); end(uuid); state('idle');
      }
      continue;
    }
    if (event.type === 'control_request' && event.request && event.request.subtype === 'initialize') {
      frame({type:'control_response',response:{subtype:'success',request_id:event.request_id,response:{current_permission_mode:'auto',commands:[
        {name:'compact',description:'Clear conversation history but keep a summary',argumentHint:''},
        {name:'grill-me',description:'Interview the user (user)',argumentHint:''},
        {name:'__remote-workflow',description:'',argumentHint:''}
      ],models:[
        {value:'default',displayName:'Default (recommended)',description:'Opus 5.5 · Best for everyday, complex tasks',supportsAutoMode:true,supportedEffortLevels:['low','medium','high','xhigh','max']},
        {value:'sonnet',displayName:'Sonnet 5',supportsAutoMode:true,supportedEffortLevels:['low','medium','high']},
        {value:'haiku',displayName:'Haiku 4.5'}
      ]}}});
      continue;
    }
    if (event.type === 'control_request' && event.request && event.request.subtype === 'apply_flag_settings') {
      globalThis.effort = event.request.settings.effortLevel;
      continue;
    }
    if (event.type === 'control_request' && event.request && event.request.subtype === 'get_settings') {
      const launch = process.argv.includes('--effort') ? process.argv[process.argv.indexOf('--effort') + 1] : null;
      const effort = globalThis.effort === undefined ? launch : globalThis.effort;
      frame({type:'control_response',response:{subtype:'success',request_id:event.request_id,response:{applied:{effort:effort || 'medium'}}}});
      continue;
    }
    if (event.type === 'control_request' && event.request && event.request.subtype === 'generate_session_title') {
      globalThis.title = globalThis.title || (event.request.persist ? 'Title for ' + event.request.description : null);
      frame({type:'control_response',response:{subtype:'success',request_id:event.request_id,response:{title:event.request.description.startsWith('/rename ') ? (globalThis.title = event.request.description.slice(8)) : globalThis.title}}});
      continue;
    }
    if (event.type === 'control_request' && event.request && event.request.subtype === 'set_permission_mode') {
      frame({type:'system',subtype:'status',permissionMode:event.request.mode === 'manual' ? 'default' : event.request.mode});
      continue;
    }
    if (event.type === 'control_request' && event.request && event.request.subtype === 'stop_task') {
      frame({type:'system',subtype:'task_notification',task_id:event.request.task_id,status:'stopped',output_file:'/tmp/out',summary:'Stopped by user'});
      continue;
    }
    if (event.type === 'control_request' && event.request && event.request.subtype === 'interrupt') {
      if (process.env.INTERRUPT_TURN) frame({type:'result',is_error:true,subtype:'error_during_execution'});
      continue;
    }
    if (event.type === 'user' && process.env.NOTICES) {
      process.stderr.write('Warning: deprecated setting\\n');
      frame({type:'system',subtype:'api_retry',attempt:1,max_retries:10,retry_delay_ms:1200,error_status:529,error:'server_error',uuid:'r1'});
      frame({type:'system',subtype:'api_retry',attempt:2,max_retries:10,retry_delay_ms:2400,error_status:529,error:'server_error',uuid:'r2'});
      frame({type:'system',subtype:'status',status:'compacting',uuid:'s1'});
      frame({type:'system',subtype:'compact_boundary',compact_metadata:{trigger:'auto',pre_tokens:180000,post_tokens:22000},uuid:'c1'});
      frame({type:'system',subtype:'local_command_output',content:'Total cost: $0.12',uuid:'l1'});
      frame({type:'tool_progress',tool_use_id:'x',tool_name:'Bash',elapsed_time_seconds:3});
      frame({type:'tool_progress',tool_use_id:'x',tool_name:'Bash',elapsed_time_seconds:4});
      frame({type:'assistant',user_message_uuid:event.uuid,message:{id:'msg_notice',content:[{type:'text',text:'Done'}]}});
      frame({type:'control_request',request_id:'late',request:{subtype:'can_use_tool',tool_name:'Bash',tool_use_id:'tl',input:{command:'ls'}}});
      frame({type:'control_request',request_id:'bg',request:{subtype:'can_use_tool',tool_name:'Bash',tool_use_id:'tb',agent_id:'agent_bg',input:{command:'npm test'}}});
      frame({type:'result',is_error:false,subtype:'success'});
      frame({type:'control_cancel_request',request_id:'late'});
      continue;
    }
    if (event.type === 'user' && process.env.SUBAGENTS) {
      // The main agent and a subagent stream at the same time; each keeps its
      // own blocks, and the subagent's rows carry the Task tool id.
      frame({type:'assistant',user_message_uuid:event.uuid,parent_tool_use_id:null,message:{id:'msg_main',usage:{input_tokens:1200,cache_read_input_tokens:30000,cache_creation_input_tokens:800,output_tokens:50},content:[{type:'tool_use',id:'toolu_task',name:'Task',input:{description:'Explore',subagent_type:'Explore',prompt:'Look around'}}]}});
      frame({type:'rate_limit_event',rate_limit_info:{status:'allowed_warning',rateLimitType:'five_hour',utilization:0.82,resetsAt:1790000000}});
      frame({type:'rate_limit_event',rate_limit_info:{status:'allowed',rateLimitType:'five_hour',resetsAt:1790000000,unifiedWindows:{five_hour:{utilization:0.82,resetsAt:1790000000},seven_day:{utilization:0.27,resetsAt:1790500000}}}});
      frame({type:'system',subtype:'task_started',task_id:'task_bg',description:'npm test --watch',task_type:'local_bash'});
      frame({type:'system',subtype:'task_progress',task_id:'task_bg',description:'npm test --watch',usage:{total_tokens:0,tool_uses:0,duration_ms:5},summary:'12 passing'});
      frame({type:'system',subtype:'task_started',task_id:'task_fg',description:'pnpm run check',task_type:'local_bash',is_backgrounded:false});
      frame({type:'system',subtype:'task_notification',task_id:'task_fg',status:'completed',summary:'done'});
      frame({type:'system',subtype:'task_started',task_id:'task_ambient',description:'Watch',task_type:'monitor_ws',ambient:true});
      frame({type:'system',subtype:'task_started',task_id:'task_moved',description:'pnpm run build',task_type:'local_bash',is_backgrounded:false});
      frame({type:'system',subtype:'task_updated',task_id:'task_moved',patch:{is_backgrounded:true}});
      frame({type:'system',subtype:'task_started',task_id:'task_wf',description:'Review',workflow_name:'review-changes',task_type:'workflow'});
      frame({type:'system',subtype:'task_updated',task_id:'task_wf',patch:{status:'completed'}});
      frame({type:'user',parent_tool_use_id:'toolu_task',uuid:'child-prompt',message:{role:'user',content:[{type:'text',text:'Look around'}]}});
      frame({type:'stream_event',parent_tool_use_id:null,event:{type:'message_start',message:{id:'msg_main2'}}});
      frame({type:'stream_event',parent_tool_use_id:null,event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}});
      frame({type:'stream_event',parent_tool_use_id:'toolu_task',event:{type:'message_start',message:{id:'msg_child'}}});
      frame({type:'stream_event',parent_tool_use_id:'toolu_task',event:{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'toolu_child_read',name:'Read',input:{}}}});
      frame({type:'stream_event',parent_tool_use_id:null,event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Main text'}}});
      frame({type:'stream_event',parent_tool_use_id:'toolu_task',event:{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"file_path":"/tmp/c.ts"}'}}});
      frame({type:'stream_event',parent_tool_use_id:'toolu_task',event:{type:'content_block_stop',index:0}});
      frame({type:'assistant',parent_tool_use_id:'toolu_task',message:{id:'msg_child',usage:{input_tokens:999999},content:[{type:'tool_use',id:'toolu_child_read',name:'Read',input:{file_path:'/tmp/c.ts'}}]}});
      frame({type:'user',parent_tool_use_id:'toolu_task',message:{role:'user',content:[{type:'tool_result',tool_use_id:'toolu_child_read',content:'child file'}]}});
      frame({type:'stream_event',parent_tool_use_id:null,event:{type:'content_block_stop',index:0}});
      frame({type:'assistant',parent_tool_use_id:null,message:{id:'msg_main2',content:[{type:'text',text:'Main text'}]}});
      frame({type:'result',is_error:false,subtype:'success',total_cost_usd:0.42,modelUsage:{'claude-test':{inputTokens:1000,outputTokens:300,cacheReadInputTokens:30000,cacheCreationInputTokens:800,webSearchRequests:0,costUSD:0.42,contextWindow:200000,maxOutputTokens:32000}}});
      continue;
    }
    if (event.type === 'user' && process.env.TRIM_SUBAGENTS) {
      // A long main thread trims an old Task row; a busy subagent must not
      // evict the main thread, and the old Task's rows go with it.
      const tool = (id, parent) => frame({type:'assistant',parent_tool_use_id:parent,message:{id:'msg_'+id,content:[{type:'tool_use',id,name:parent ? 'Read' : 'Task',input:{}}]}});
      tool('toolu_old', null);
      for (let i = 0; i < 2; i++) tool('toolu_old_child_' + i, 'toolu_old');
      for (let i = 0; i < 401; i++) frame({type:'assistant',parent_tool_use_id:null,message:{id:'msg_main_' + i,content:[{type:'text',text:'main ' + i}]}});
      tool('toolu_new', null);
      for (let i = 0; i < 399; i++) tool('toolu_new_child_' + i, 'toolu_new');
      frame({type:'result',is_error:false,subtype:'success'});
      continue;
    }
    if (event.type === 'user' && process.env.CONTROL_REQUESTS) {
      frame({type:'assistant',user_message_uuid:event.uuid,message:{id:'control_start',content:[{type:'text',text:'Asking'}]}});
      frame({type:'control_request',request_id:'elicit_1',request:{subtype:'elicitation',mcp_server_name:'linear',message:'Pick a team',requested_schema:{type:'object',required:['team'],properties:{team:{type:'string',enum:['eng','ops'],enumNames:['Engineering','Operations']}}}}});
      frame({type:'control_request',request_id:'dialog_1',request:{subtype:'request_user_dialog',dialog_kind:'future_dialog',payload:{}}});
      frame({type:'control_request',request_id:'hook_1',request:{subtype:'hook_callback',callback_id:'cb',input:{}}});
      frame({type:'control_request',request_id:'perm_sub',request:{subtype:'can_use_tool',tool_name:'Bash',tool_use_id:'t1',agent_id:'agent_a',input:{command:'ls'}}});
      frame({type:'control_request',request_id:'perm_cancel',request:{subtype:'can_use_tool',tool_name:'Write',tool_use_id:'t2',input:{file_path:'/tmp/x'}}});
      frame({type:'control_request',request_id:'plan_1',request:{subtype:'can_use_tool',tool_name:'ExitPlanMode',tool_use_id:'t3',input:{plan:'# Plan\\n1. Do it'}}});
      frame({type:'control_request',request_id:'edit_1',request:{subtype:'can_use_tool',tool_name:'Edit',tool_use_id:'t4',title:'Allow Edit to change a.ts?',description:'Edits a.ts',decision_reason:'Outside acceptEdits scope',input:{file_path:'/tmp/a.ts',old_string:'old',new_string:'new'}}});
      frame({type:'control_cancel_request',request_id:'perm_cancel'});
      continue;
    }
    if (event.type === 'user' && process.env.INTERRUPT_TURN) {
      // The turn stalls inside a tool until the host interrupts it.
      frame({type:'assistant',user_message_uuid:event.uuid,message:{id:'msg_stall',content:[{type:'tool_use',id:'toolu_stall',name:'Bash',input:{command:'sleep 60'}}]}});
      continue;
    }
    if (event.type === 'user') {
      const reply = () => {
        process.stdout.write(JSON.stringify({type:'assistant',user_message_uuid:event.uuid,message:{id:'prompt_echo',content:[{type:'text',text:JSON.stringify({content:event.message && event.message.content,uuid:event.uuid})}]}}) + '\\n');
        process.stdout.write(JSON.stringify({type:'assistant',user_message_uuid:event.uuid,message:{id:'assistant_test',content:[{type:'text',text:'Native Claude reply'}]}}) + '\\n');
        if (process.env.STREAM_FRAMES) {
          // Partial text with no completion frame: the partial row must stand on its own.
          frame({type:'stream_event',event:{type:'message_start',message:{id:'msg_partial'}}});
          frame({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}});
          frame({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Still '}}});
          frame({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'partial'}}});
          // Streamed prose, reasoning, and tool input reconciled by the final frame.
          frame({type:'stream_event',event:{type:'message_start',message:{id:'msg_stream'}}});
          frame({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}});
          frame({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Partial '}}});
          frame({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'prose'}}});
          frame({type:'stream_event',event:{type:'content_block_start',index:1,content_block:{type:'thinking',thinking:''}}});
          frame({type:'stream_event',event:{type:'content_block_delta',index:1,delta:{type:'thinking_delta',thinking:'Thinking about '}}});
          frame({type:'stream_event',event:{type:'content_block_delta',index:1,delta:{type:'thinking_delta',thinking:'the answer'}}});
          frame({type:'stream_event',event:{type:'content_block_start',index:2,content_block:{type:'tool_use',id:'toolu_stream',name:'Bash',input:{}}}});
          frame({type:'stream_event',event:{type:'content_block_delta',index:2,delta:{type:'input_json_delta',partial_json:'{"command":"echo '}}});
          frame({type:'stream_event',event:{type:'content_block_delta',index:2,delta:{type:'input_json_delta',partial_json:'streamed"}'}}});
          frame({type:'stream_event',event:{type:'content_block_stop',index:2}});
          frame({type:'assistant',user_message_uuid:event.uuid,message:{id:'msg_stream',content:[
            {type:'text',text:'Partial prose'},
            {type:'thinking',thinking:'Thinking about the answer'},
            {type:'tool_use',id:'toolu_stream',name:'Bash',input:{command:'echo streamed'}}
          ]}});
          frame({type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'toolu_stream',content:[{type:'text',text:'streamed output'}]}]},tool_use_result:{type:'text',text:'streamed output'}});
          // A failing tool keeps its error state.
          frame({type:'assistant',message:{id:'msg_fail',content:[{type:'tool_use',id:'toolu_fail',name:'Bash',input:{command:'false'}}]}});
          frame({type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'toolu_fail',is_error:true,content:[{type:'text',text:'boom'}]}]}});
          // The structured tool_use_result wins over the raw content blocks.
          frame({type:'assistant',message:{id:'msg_struct',content:[{type:'tool_use',id:'toolu_struct',name:'Read',input:{file_path:'/tmp/a.ts'}}]}});
          frame({type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'toolu_struct',content:[{type:'text',text:'raw content'}]}]},tool_use_result:{type:'text',text:'structured output'}});
          // A Read of an image returns an image block and a structured twin
          // that both carry the base64 bytes.
          frame({type:'assistant',message:{id:'msg_image',content:[{type:'tool_use',id:'toolu_image',name:'Read',input:{file_path:'/tmp/shot.png'}}]}});
          frame({type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'toolu_image',content:[{type:'image',source:{type:'base64',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',media_type:'image/png'}}]}]},tool_use_result:{type:'image',file:{base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',type:'image/png',originalSize:70,dimensions:{originalWidth:1,originalHeight:1,displayWidth:1,displayHeight:1}}}});
          // Installed 2.1.266 shape: one assistant frame per content_block_stop,
          // carrying the native message id and a single content block. The
          // internal apiBlockIndex is not on the wire.
          frame({type:'stream_event',event:{type:'message_start',message:{id:'msg_native'}}});
          frame({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}}});
          frame({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'Step '}}});
          frame({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'one'}}});
          frame({type:'stream_event',event:{type:'content_block_stop',index:0}});
          frame({type:'assistant',message:{id:'msg_native',content:[{type:'thinking',thinking:'Step one'}]}});
          frame({type:'stream_event',event:{type:'content_block_start',index:1,content_block:{type:'text',text:''}}});
          frame({type:'stream_event',event:{type:'content_block_delta',index:1,delta:{type:'text_delta',text:'Partial '}}});
          frame({type:'stream_event',event:{type:'content_block_delta',index:1,delta:{type:'text_delta',text:'text'}}});
          frame({type:'stream_event',event:{type:'content_block_stop',index:1}});
          frame({type:'assistant',message:{id:'msg_native',content:[{type:'text',text:'Partial text'}]}});
          frame({type:'stream_event',event:{type:'content_block_start',index:2,content_block:{type:'text',text:''}}});
          frame({type:'stream_event',event:{type:'content_block_delta',index:2,delta:{type:'text_delta',text:'Second text'}}});
          frame({type:'stream_event',event:{type:'content_block_stop',index:2}});
          frame({type:'assistant',message:{id:'msg_native',content:[{type:'text',text:'Second text'}]}});
          frame({type:'stream_event',event:{type:'content_block_start',index:3,content_block:{type:'tool_use',id:'toolu_native_edit',name:'Edit',input:{}}}});
          frame({type:'stream_event',event:{type:'content_block_delta',index:3,delta:{type:'input_json_delta',partial_json:'{"file_path":"/tmp/a.ts","old_string":"old",'}}});
          frame({type:'stream_event',event:{type:'content_block_delta',index:3,delta:{type:'input_json_delta',partial_json:'"new_string":"new"}'}}});
          frame({type:'stream_event',event:{type:'content_block_stop',index:3}});
          frame({type:'assistant',message:{id:'msg_native',content:[{type:'tool_use',id:'toolu_native_edit',name:'Edit',input:{file_path:'/tmp/a.ts',old_string:'old',new_string:'new'}}]}});
          frame({type:'stream_event',event:{type:'content_block_start',index:4,content_block:{type:'tool_use',id:'toolu_native_read',name:'Read',input:{}}}});
          frame({type:'stream_event',event:{type:'content_block_delta',index:4,delta:{type:'input_json_delta',partial_json:'{"file_path":"/tmp/b.ts"}'}}});
          frame({type:'stream_event',event:{type:'content_block_stop',index:4}});
          frame({type:'assistant',message:{id:'msg_native',content:[{type:'tool_use',id:'toolu_native_read',name:'Read',input:{file_path:'/tmp/b.ts'}}]}});
          frame({type:'stream_event',event:{type:'message_stop'}});
          frame({type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'toolu_native_edit',content:[{type:'text',text:'Applied edit'}]}]},tool_use_result:{filePath:'/tmp/a.ts',oldString:'old',newString:'new',originalFile:'old',structuredPatch:[{oldStart:1,oldLines:1,newStart:1,newLines:1,lines:['-old','+new']}]}});
          frame({type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'toolu_native_read',content:[{type:'text',text:'file contents'}]}]},tool_use_result:{type:'text',text:'file contents'}});
          // A result ends the turn after all of its model and tool frames.
          if (process.env.ERROR_RESULT) frame({type:'result',is_error:true,subtype:'error_during_execution',result:'credential expired'});
          else frame({type:'result',is_error:false,subtype:'success'});
        }
        if (!process.env.ERROR_RESULT) {
        process.stdout.write(JSON.stringify({type:'control_request',request_id:'permission_test',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'echo test'}}}) + '\\n');
        process.stdout.write(JSON.stringify({type:'control_request',request_id:'question_test',request:{subtype:'can_use_tool',tool_name:'AskUserQuestion',input:{questions:[
          {question:'Which colour?',header:'Colour',multiSelect:true,options:[{label:'Red',description:'Warm'},{label:'Blue',description:'Cool'}]},
          {question:'Anything else?',header:'Other',multiSelect:false,options:[]}
        ]}}}) + '\\n');
        }
        if (process.env.EXIT_AFTER_PROMPT) setTimeout(() => process.exit(1), 30);
      };
      if (process.env.DELAY_ACK) setTimeout(reply, 200); else reply();
    }
    if (event.type === 'control_response' && (process.env.CONTROL_REQUESTS || process.env.NOTICES)) {
      frame({type:'assistant',message:{id:'resp_' + event.response.request_id,content:[{type:'text',text:JSON.stringify(event.response)}]}});
    }
    if (event.type === 'control_response') {
      const updatedInput = event.response && event.response.response && event.response.response.updatedInput;
      if (updatedInput && updatedInput.answers) {
        process.stdout.write(JSON.stringify({type:'assistant',message:{id:'answers_echo',content:[{type:'text',text:JSON.stringify(updatedInput.answers)}]}}) + '\\n');
      }
    }
  }
});
`);

  const database = new DatabaseService(directory);
  try {
    database.initialize();
    const now = new Date().toISOString();
    database.connection.prepare('insert into projects (id,name,path,created_at,updated_at) values (?,?,?,?,?)').run('project_test', 'Test', directory, now, now);
    const runtimeDirectory = path.join(directory, 'runtime');
    const argvPath = path.join(directory, 'claude-argv.json');
    process.env.ARGV_FILE = argvPath;
    process.env.STREAM_FRAMES = '1';
    const images = new TranscriptImageStore(path.join(directory, 'transcript-images'));
    const service = new ClaudeStreamService(database, runtimeDirectory, process.execPath, process.env, undefined, undefined, images);
    const prepared = await service.prepare({
      executable,
      cwd: directory,
      name: 'Claude',
      context: 'Project context',
      mcp: { command: process.execPath, args: ['shim.js'], env: { PATTERM_MCP_SOCKET: '/tmp/mcp.sock', PATTERM_MCP_IDENTITY: 'identity_test' } },
      resumeId: null,
      model: 'sonnet', reasoning: 'high'
    });
    assert.match(prepared.resumeId, /^[0-9a-f-]{36}$/);
    database.connection.prepare(`insert into processes (id,project_id,kind,name,status,cwd,argv,created_at,updated_at) values ('process_test','project_test','agent','Claude','running',?,?,?,?)`)
      .run(directory, JSON.stringify(prepared.argv), now, now);
    database.connection.prepare(`insert into sessions (id,project_id,process_id,harness,interface_mode,mcp_identity,resume_id,started_at,session_role,resume_status,created_by_actor) values ('session_test','project_test','process_test','claude','integrated','identity_test',?,?, 'orchestrator','found','user')`)
      .run(prepared.resumeId, now);

    const events: IntegratedConversationEvent[] = [];
    const release = await service.subscribe('process_test', (event) => events.push(event));

    await service.prompt('process_test', { text: 'Hello', references: [], attachments: [] });
    // The reply ends with the question request; a fresh CLI can take a while to start.
    const first = JSON.stringify(await waitForConversation(service, 'process_test', /question_test/));
    assert.match(first, /Native Claude reply/);
    // The host asks Claude Code for its persisted title once, then serves it
    // until a slash command such as /rename could change it.
    assert.equal(await service.title('process_test', 'Hello'), 'Title for Hello');
    assert.equal(await service.title('process_test', 'Something else'), 'Title for Hello');
    assert.equal(await service.title('process_test', '/rename Renamed'), 'Renamed');
    assert.match(first, /permission_test/);
    assert.match(first, /question_test/);
    const permissionRequest = (JSON.parse(first).permissions as { data: Array<{ id: string; always?: boolean }> }).data.find((item) => item.id === 'permission_test')!;
    assert.equal(permissionRequest.always, false, 'a Claude request without permission suggestions cannot promise persistence');

    // Native partial frames stream prose, reasoning, and tool input; the final
    // assistant frame reconciles them without duplicate completed rows.
    const streamedRows = (JSON.parse(first).messages as { data: Array<Record<string, unknown>> }).data;
    assert.equal(JSON.parse(first).streaming, true, 'the Claude snapshot advertises streaming');
    assert.ok(Number(JSON.parse(first).revision) > 0, 'the snapshot carries its event boundary');

    // The real child argv must satisfy the installed CLI contract: --print with
    // --output-format=stream-json requires --verbose.
    const spawnedArgv = JSON.parse(fs.readFileSync(argvPath, 'utf8')) as string[];
    assert.ok(spawnedArgv.includes('-p'), 'the native CLI runs in print mode');
    assert.deepEqual(spawnedArgv.slice(spawnedArgv.indexOf('--output-format'), spawnedArgv.indexOf('--output-format') + 2), ['--output-format', 'stream-json']);
    assert.ok(spawnedArgv.includes('--verbose'), 'stream-json with --print requires --verbose');
    assert.deepEqual(spawnedArgv.slice(spawnedArgv.indexOf('--model'), spawnedArgv.indexOf('--model') + 2), ['--model', 'sonnet']);
    assert.deepEqual(spawnedArgv.slice(spawnedArgv.indexOf('--permission-mode'), spawnedArgv.indexOf('--permission-mode') + 2), ['--permission-mode', 'auto'], 'integrated sessions start in auto mode');
    assert.deepEqual(spawnedArgv.slice(spawnedArgv.indexOf('--effort'), spawnedArgv.indexOf('--effort') + 2), ['--effort', 'high']);
    assert.ok(!spawnedArgv.includes('--strict-mcp-config'), 'user and project MCP servers load alongside Patterm, as in terminal mode');
    assert.equal(streamedRows.find((message) => message.id === 'msg_partial_0')?.text, 'Still partial', 'partial text is readable without a completion frame');
    assert.equal(streamedRows.filter((message) => message.id === 'msg_stream_0').length, 1, 'the completed assistant row replaces the streamed row');
    assert.equal(streamedRows.find((message) => message.id === 'msg_stream_0')?.text, 'Partial prose');
    const reasoning = streamedRows.find((message) => message.id === 'msg_stream_1')!;
    assert.equal(reasoning.kind, 'reasoning');
    assert.equal(reasoning.text, 'Thinking about the answer');
    const streamTool = streamedRows.find((message) => message.id === 'toolu_stream')!;
    assert.equal(streamTool.kind, 'tool');
    assert.deepEqual((streamTool.tool as { input?: unknown }).input, { command: 'echo streamed' });
    assert.equal(streamTool.text, 'streamed output');
    assert.equal((streamTool.tool as { state?: { status?: string } }).state?.status, 'completed');
    const failedTool = streamedRows.find((message) => message.id === 'toolu_fail')!;
    assert.equal((failedTool.tool as { state?: { status?: string } }).state?.status, 'error');
    assert.equal(failedTool.text, 'boom');
    assert.equal(streamedRows.find((message) => message.id === 'toolu_struct')?.text, 'structured output', 'the structured tool_use_result wins');
    assert.equal(streamedRows.filter((message) => String(message.id).startsWith('user_')).length, 1, 'tool results do not add duplicate user rows');
    const imageTool = streamedRows.find((message) => message.id === 'toolu_image')!;
    const readImage = (imageTool.tool as { images?: Array<Record<string, unknown>>; result?: unknown }).images?.[0];
    assert.equal(imageTool.text, '', 'an image result is not shown as JSON output');
    assert.equal((imageTool.tool as { result?: unknown }).result, undefined, 'the structured image twin is not kept');
    assert.deepEqual({ ...readImage, sha256: undefined }, { type: 'image', sha256: undefined, mime: 'image/png', size: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64').length, width: 1, height: 1 });
    assert.deepEqual(images.read(String(readImage?.sha256)), { mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' }, 'the read image is stored by hash');
    assert.ok(!first.includes('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), 'image bytes never travel in the conversation snapshot');
    assert.equal(normaliseMessages(JSON.parse(first).messages).find((message) => message.id === 'toolu_image')?.tool?.images?.[0]?.sha256, readImage?.sha256, 'the renderer keeps the stored image reference');

    // Installed native shape: one assistant frame per content_block_stop, the
    // native message id retained, no apiBlockIndex on the wire, and later
    // blocks never overwriting earlier ones.
    assert.equal(streamedRows.find((message) => message.id === 'msg_native_0')?.kind, 'reasoning');
    assert.equal(streamedRows.find((message) => message.id === 'msg_native_0')?.text, 'Step one');
    assert.equal(streamedRows.find((message) => message.id === 'msg_native_1')?.kind, 'text');
    assert.equal(streamedRows.find((message) => message.id === 'msg_native_1')?.text, 'Partial text');
    assert.equal(streamedRows.find((message) => message.id === 'msg_native_2')?.text, 'Second text', 'a later text block does not overwrite the earlier one');
    assert.ok(events.some((event) => event.kind === 'append' && event.id === 'msg_native_1' && event.delta === 'Partial '), 'partial text streams before its per-block assistant frame');
    assert.ok(events.some((event) => event.kind === 'append' && event.id === 'msg_native_2'), 'a later block keeps its own partial stream');
    const nativeEdit = streamedRows.find((message) => message.id === 'toolu_native_edit')!;
    assert.equal(nativeEdit.kind, 'tool');
    assert.deepEqual((nativeEdit.tool as { input?: unknown }).input, { file_path: '/tmp/a.ts', old_string: 'old', new_string: 'new' });
    assert.equal((nativeEdit.tool as { state?: { status?: string } }).state?.status, 'completed');
    assert.equal((nativeEdit.tool as { result?: { filePath?: string } }).result?.filePath, '/tmp/a.ts', 'the structured tool_use_result is preserved');
    assert.ok(!JSON.stringify(nativeEdit).includes('originalFile'), 'the whole pre-edit file never reaches the transcript');
    const projectedEdit = normaliseMessages({ data: [nativeEdit] })[0]?.tool;
    assert.equal(projectedEdit?.target, '/tmp/a.ts');
    assert.equal(projectedEdit?.files?.[0]?.patch, '@@ -1,1 +1,1 @@\n-old\n+new', 'the native structuredPatch becomes a real patch');
    assert.deepEqual(projectedEdit?.changes, { additions: 1, deletions: 1 });
    assert.equal(streamedRows.find((message) => message.id === 'toolu_native_read')?.text, 'file contents');

    // Host times: every row is stamped when first seen, and finished rows when
    // the block stops, the final frame lands, or the tool result arrives.
    const stamped = (id: string) => streamedRows.find((message) => message.id === id) as { created_at?: string; completed_at?: string } | undefined;
    for (const id of ['msg_native_0', 'msg_native_1', 'msg_stream_0', 'msg_stream_1', 'toolu_stream', 'toolu_fail', 'toolu_native_read']) {
      const row = stamped(id);
      assert.ok(row?.created_at && row.completed_at && Date.parse(row.completed_at) >= Date.parse(row.created_at), `${id} has a start and a finish`);
    }
    const userRow = streamedRows.find((message) => String(message.id).startsWith('user_')) as { created_at?: string; completed_at?: string } | undefined;
    assert.ok(userRow?.created_at && userRow.completed_at, 'a prompt row is finished when sent');
    assert.ok(events.some((event) => event.kind === 'replace' && event.message?.id === 'msg_native_0' && typeof (event.message as { completed_at?: unknown }).completed_at === 'string'),
      'a stopped block publishes its finish time');
    assert.ok(events.some((event) => event.kind === 'replace' && event.message?.id === 'toolu_native_edit' && !(event.message as { completed_at?: unknown }).completed_at),
      'a tool whose input stopped is not finished before its result');
    const projectedTimes = normaliseMessages({ data: [stamped('msg_native_0')] })[0];
    assert.equal(projectedTimes?.createdAt, stamped('msg_native_0')?.created_at, 'snake times project to createdAt');
    assert.equal(projectedTimes?.completedAt, stamped('msg_native_0')?.completed_at);

    // Targeted events: appends for text and reasoning, replaces for tool input
    // and results, a pending boundary, and monotonic revisions.
    assert.equal(events[0]?.kind, 'pending', 'the subscription starts with a fresh snapshot boundary');
    assert.ok(events.some((event) => event.kind === 'append' && event.id === 'msg_partial_0' && event.delta === 'Still '), 'partial prose streams as appends');
    assert.ok(events.some((event) => event.kind === 'append' && event.id === 'msg_stream_1'), 'reasoning streams as appends');
    assert.ok(events.some((event) => event.kind === 'replace' && event.message?.id === 'toolu_stream' && typeof event.message.tool?.input === 'string'), 'partial tool input is published');
    assert.ok(events.some((event) => event.kind === 'replace' && event.message?.id === 'toolu_stream' && event.message.text === 'streamed output'), 'the tool result is published');
    assert.ok(events.filter((event) => event.kind === 'pending').length > 1, 'request states publish a snapshot refresh');
    const revisions = events.map((event) => event.revision);
    assert.deepEqual(revisions, [...revisions].sort((left, right) => left - right), 'event revisions are monotonic');

    // A reconnected subscription hands the client a new boundary; late events
    // stay newer than the snapshot revision.
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const late: IntegratedConversationEvent[] = [];
    const releaseLate = await service.subscribe('process_test', (event) => late.push(event));
    await waitFor(() => late.some((event) => event.kind === 'pending'));
    assert.equal(late[0]?.kind, 'pending', 'a reconnected subscription gets a fresh boundary');
    const boundary = (await service.conversation('process_test') as { revision: number }).revision;
    await service.prompt('process_test', { text: 'late events', references: [], attachments: [] });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(late.some((event) => event.revision > boundary && (event.kind === 'append' || event.kind === 'replace')), 'late events stay newer than the snapshot boundary');
    releaseLate();
    const pending = await waitForConversation(service, 'process_test', /"id":"question_test"/);
    const questionRequest = (pending.questions as { data: Array<{ id: string; questions: Array<Record<string, unknown>> }> }).data[0]!;
    assert.deepEqual(
      questionRequest.questions.map((question) => [question.id, question.multiple, question.custom, question.header]),
      [['Which colour?', true, true, 'Colour'], ['Anything else?', false, true, 'Other']],
      'Claude multiSelect maps to multiple and always allows a typed answer'
    );
    assert.deepEqual(questionRequest.questions[0]?.options, [{ label: 'Red', description: 'Warm' }, { label: 'Blue', description: 'Cool' }]);
    await assert.rejects(service.replyQuestion('process_test', 'question_test', [['Red']]), /Provide one answer for every question/);
    await service.replyQuestion('process_test', 'question_test', [['Red', 'Blue'], ['anything']]);
    const answered = await waitForConversation(service, 'process_test', /answers_echo_0/);
    const echo = (answered.messages as { data: Array<{ id: string; text: string }> }).data.find((message) => message.id === 'answers_echo_0')!;
    assert.deepEqual(JSON.parse(echo.text), { 'Which colour?': 'Red, Blue', 'Anything else?': 'anything' }, 'Claude answers are keyed by question text');
    await service.replyPermission('process_test', 'permission_test', 'once');
    assert.deepEqual((await service.controls('process_test')).selectors.map((selector) => selector.id), ['model', 'effort', 'mode']);
    assert.equal((await service.controls('process_test')).selectors.find((selector) => selector.id === 'model')?.value, 'sonnet', 'composer reflects the native launch model');
    const initial = await service.controls('process_test');
    assert.deepEqual(initial.selectors[0]?.options, [
      { value: 'default', label: 'Default (Opus 5.5)' }, { value: 'sonnet', label: 'Sonnet 5' }, { value: 'haiku', label: 'Haiku 4.5' }
    ], 'model options come from the native initialize reply');
    assert.deepEqual(initial.commands, [
      { name: 'compact', description: 'Clear conversation history but keep a summary' }, { name: 'grill-me', description: 'Interview the user (user)' }
    ], 'slash commands come from the native initialize reply, without internal entries');
    assert.equal(initial.selectors[1]?.value, 'high', 'the composer shows the launch effort');
    assert.deepEqual(initial.selectors[1]?.options.map((option) => option.value), ['default', 'low', 'medium', 'high'], 'effort levels come from the selected model');
    assert.equal(initial.selectors[2]?.value, 'auto', 'the composer shows the native permission mode');
    assert.ok(initial.selectors[2]?.options.some((option) => option.value === 'auto'));
    const nativeSnapshot = await service.conversation('process_test') as Record<string, unknown>;
    assert.equal(nativeSnapshot.models, undefined, 'snapshots leave the model list to the controls');
    assert.equal(nativeSnapshot.commands, undefined, 'snapshots leave the command list to the controls');
    assert.equal(nativeSnapshot.model, 'sonnet', 'snapshots still report the current settings');
    assert.match(String(initial.revision), /^[\w-]{16}$/);
    assert.equal(nativeSnapshot.controls_revision, initial.revision, 'a snapshot reports the revision of the controls it matches');
    const restartedService = new ClaudeStreamService(database, runtimeDirectory, process.execPath, process.env);
    assert.notEqual((await restartedService.conversation('process_test') as Record<string, unknown>).controls_revision, initial.revision,
      'the same host state from a restarted service has a new revision, so clients read its controls again');
    await assert.rejects(service.configure('process_test', 'model', 'gpt-5'), /Unknown Claude setting/);
    await assert.rejects(service.configure('process_test', 'effort', 'max'), /Unknown Claude setting/, 'a level the model lacks is rejected');
    await service.configure('process_test', 'model', 'sonnet');
    await service.configure('process_test', 'effort', 'low');
    await service.configure('process_test', 'mode', 'plan');
    const configured = await service.controls('process_test');
    assert.deepEqual(configured.selectors.map((selector) => selector.value), ['sonnet', 'low', 'plan']);
    assert.notEqual(configured.revision, initial.revision, 'changed settings change the revision');
    await service.configure('process_test', 'effort', 'default');
    let reset = await service.controls('process_test');
    for (let attempt = 0; attempt < 50 && reset.selectors[1]?.options[0]?.label !== 'Default (Medium)'; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      reset = await service.controls('process_test');
    }
    assert.equal(reset.selectors[1]?.value, 'default', 'Default returns effort to Claude Code');
    assert.equal(reset.selectors[1]?.options[0]?.label, 'Default (Medium)', 'Default shows the level Claude Code resolved');
    await service.configure('process_test', 'model', 'haiku');
    assert.deepEqual((await service.controls('process_test')).selectors.map((selector) => selector.id), ['model', 'mode'], 'a model without effort levels has no effort control');
    await service.command('process_test', 'compact', '');

    // Structured input: @ references with quoting, image blocks with validated
    // bytes, and the client uuid for native deduplication.
    const imageBytes = Buffer.from('89504e470d0a1a0a', 'hex');
    const imageFile = path.join(directory, 'pixel.png');
    fs.writeFileSync(imageFile, imageBytes);
    const spacedDirectory = path.join(directory, 'src dir');
    fs.mkdirSync(spacedDirectory, { recursive: true });
    const spacedFile = path.join(spacedDirectory, 'my file.ts');
    fs.writeFileSync(spacedFile, 'export const spaced = true;');
    const plainFile = path.join(directory, 'src.ts');
    fs.writeFileSync(plainFile, 'export const plain = true;');
    const otherFile = path.join(directory, 'src.tsx');
    fs.writeFileSync(otherFile, 'export const other = true;');
    const clientMessageId = '22222222-2222-2222-2222-222222222222';
    await service.prompt('process_test', {
      text: 'See @src.ts',
      references: [
        { path: plainFile, name: 'src.ts', relativePath: 'src.ts' },
        { path: otherFile, name: 'src.tsx', relativePath: 'src.tsx' },
        { path: spacedFile, name: 'my file.ts', relativePath: 'src dir/my file.ts' }
      ],
      attachments: [{ path: imageFile, name: 'pixel.png', mime: 'image/png', size: imageBytes.length, data: imageBytes.toString('base64') }],
      messageId: clientMessageId
    });
    // The local user row shows the references at once; wait for the native echo.
    const echoed = await waitForConversation(service, 'process_test', /\\"uuid\\":\\"22222222-2222-2222-2222-222222222222\\"/);
    const echoRows = (echoed.messages as { data: Array<{ id: string; text: string; attachments?: Array<{ name: string; type?: string; detail?: string; mime?: string }> }> }).data;
    const submittedUser = echoRows.find((message) => message.id === `user_${clientMessageId}`)!;
    assert.deepEqual(submittedUser.attachments, [
      { name: 'src.ts', detail: '@src.ts', type: 'reference' },
      { name: 'src.tsx', detail: '@src.tsx', type: 'reference' },
      { name: 'my file.ts', detail: '@src dir/my file.ts', type: 'reference' },
      { name: 'pixel.png', mime: 'image/png', type: 'image', sha256: createHash('sha256').update(imageBytes).digest('hex') }
    ], 'the transcript keeps safe reference and image chips without server paths or base64 bytes; images are shown by stored hash');
    // Every prompt emits an echo; the structured one is the newest.
    const promptEcho = echoRows.filter((message) => message.id.startsWith('prompt_echo')).at(-1)!;
    const submitted = JSON.parse(promptEcho.text) as { content: Array<Record<string, unknown>>; uuid: string };
    assert.equal(submitted.uuid, clientMessageId);
    assert.deepEqual(submitted.content[0], { type: 'text', text: 'See @src.ts @src.tsx @"src dir/my file.ts"' }, 'only missing references are appended, with quoting and no substring suppression');
    assert.equal(submitted.content[1]?.type, 'image');
    const source = submitted.content[1]?.source as { type: string; media_type: string; data: string };
    assert.equal(source.media_type, 'image/png');
    assert.equal(source.data, imageBytes.toString('base64'));
    // PDFs and text files become native document blocks.
    const documentId = '33333333-3333-3333-3333-333333333333';
    await service.prompt('process_test', {
      text: 'attach',
      references: [],
      attachments: [
        { path: path.join(directory, 'doc.pdf'), name: 'doc.pdf', mime: 'application/pdf', size: 4, data: Buffer.from('%PDF').toString('base64') },
        { path: path.join(directory, 'notes.md'), name: 'notes.md', mime: 'text/markdown', size: 5, data: Buffer.from('# Hi\n').toString('base64') }
      ],
      messageId: documentId
    });
    const documentRows = (await waitForConversation(service, 'process_test', /JVBERg/)).messages as { data: Array<{ id: string; text: string; attachments?: unknown }> };
    assert.deepEqual(documentRows.data.find((message) => message.id === `user_${documentId}`)?.attachments, [
      { name: 'doc.pdf', mime: 'application/pdf', type: 'file' },
      { name: 'notes.md', mime: 'text/markdown', type: 'file' }
    ], 'file chips carry no paths or bytes');
    const documentEcho = JSON.parse(documentRows.data.filter((message) => message.id.startsWith('prompt_echo')).at(-1)!.text) as { content: unknown[] };
    assert.deepEqual(documentEcho.content.slice(1), [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from('%PDF').toString('base64') }, title: 'doc.pdf' },
      { type: 'document', source: { type: 'text', media_type: 'text/plain', data: '# Hi\n' }, title: 'notes.md' }
    ]);

    // A retry with the same uuid adds no second local transcript row, and the
    // native ack makes delivery reconcilable.
    await service.prompt('process_test', { text: 'repeat', references: [], attachments: [], messageId: clientMessageId });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const afterRetry = (await service.conversation('process_test') as { messages: { data: Array<{ id: string }> } }).messages.data;
    assert.equal(afterRetry.filter((message) => message.id === `user_${clientMessageId}`).length, 1, 'repeated uuid keeps one local row');
    assert.equal(await service.reconcile('process_test', clientMessageId), 'accepted');

    // A delayed native acknowledgement stays unknown until a replay frame lands.
    const delayedService = new ClaudeStreamService(database, runtimeDirectory, process.execPath, { ...process.env, DELAY_ACK: '1' });
    const delayedPrepared = await delayedService.prepare({
      executable, cwd: directory, name: 'Claude delayed', context: 'Project context',
      mcp: { command: process.execPath, args: ['shim.js'], env: { PATTERM_MCP_SOCKET: '/tmp/mcp.sock', PATTERM_MCP_IDENTITY: 'identity_test' } },
      resumeId: null
    });
    database.connection.prepare(`insert into processes (id,project_id,kind,name,status,cwd,argv,created_at,updated_at) values ('process_delayed','project_test','agent','Claude delayed','running',?,?,?,?)`)
      .run(directory, JSON.stringify(delayedPrepared.argv), now, now);
    database.connection.prepare(`insert into sessions (id,project_id,process_id,harness,interface_mode,mcp_identity,resume_id,started_at,session_role,resume_status,created_by_actor) values ('session_delayed','project_test','process_delayed','claude','integrated','identity_delayed',?,?, 'orchestrator','found','user')`)
      .run(delayedPrepared.resumeId, now);
    const delayedId = '88888888-8888-8888-8888-888888888888';
    await delayedService.prompt('process_delayed', { text: 'delayed ack', references: [], attachments: [], messageId: delayedId });
    assert.equal(await delayedService.reconcile('process_delayed', delayedId), 'unknown', 'a local write is not native acceptance');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await delayedService.reconcile('process_delayed', delayedId), 'accepted');
    await delayedService.stop('process_delayed');

    // Only answerable control requests become prompts. Elicitations become
    // forms, unknown dialogs are cancelled, unhandled subtypes get a protocol
    // error, subagent permissions are labelled, and a withdrawn request goes.
    const controlService = new ClaudeStreamService(database, runtimeDirectory, process.execPath, { ...process.env, STREAM_FRAMES: '', CONTROL_REQUESTS: '1' });
    const controlPrepared = await controlService.prepare({
      executable, cwd: directory, name: 'Claude control', context: 'Project context',
      mcp: { command: process.execPath, args: ['shim.js'], env: { PATTERM_MCP_SOCKET: '/tmp/mcp.sock', PATTERM_MCP_IDENTITY: 'identity_control' } },
      resumeId: null
    });
    database.connection.prepare(`insert into processes (id,project_id,kind,name,status,cwd,argv,created_at,updated_at) values ('process_control','project_test','agent','Claude control','running',?,?,?,?)`)
      .run(directory, JSON.stringify(controlPrepared.argv), now, now);
    database.connection.prepare(`insert into sessions (id,project_id,process_id,harness,interface_mode,mcp_identity,resume_id,started_at,session_role,resume_status,created_by_actor) values ('session_control','project_test','process_control','claude','integrated','identity_control',?,?, 'orchestrator','found','user')`)
      .run(controlPrepared.resumeId, now);
    await controlService.prompt('process_control', { text: 'ask', references: [], attachments: [] });
    const controlled = await waitForConversation(controlService, 'process_control', /resp_hook_1/) as {
      status: string; permissions: { data: Array<{ id: string; action: string }> }; forms: { data: Array<{ id: string; title: string; detail: string; declinable: boolean; fields: Array<{ key: string; options: unknown[] }> }> }; messages: { data: Array<{ id: string; text: string }> }
    };
    assert.deepEqual(controlled.permissions.data.map((item) => [item.id, item.action]), [['perm_sub', 'Subagent: Bash'], ['plan_1', 'Approve the plan?'], ['edit_1', 'Allow Edit to change a.ts?']], 'a withdrawn request is removed and a subagent request is labelled');
    const [subPermission, planPermission, editPermission] = controlled.permissions.data as unknown as Array<Record<string, unknown>>;
    assert.equal(subPermission?.command, 'ls', 'a Bash request shows its command');
    assert.deepEqual(subPermission?.resources, [], 'raw JSON is not shown when the command is');
    assert.equal(planPermission?.plan, '# Plan\n1. Do it');
    assert.deepEqual([planPermission?.once_label, planPermission?.always_label, planPermission?.reject_label], ['Yes, approve edits manually', 'Yes, auto-accept edits', 'No, keep planning'], 'plan approval offers the native choices');
    assert.equal(editPermission?.detail, 'Edits a.ts\nOutside acceptEdits scope');
    assert.equal(editPermission?.patch, '+++ /tmp/a.ts\n@@\n-old\n+new', 'an edit request previews its change');
    await controlService.replyPermission('process_control', 'plan_1', 'always');
    await controlService.replyPermission('process_control', 'edit_1', 'reject', 'Use the helper instead');
    const decided = await waitForConversation(controlService, 'process_control', /resp_edit_1/) as typeof controlled & { mode: string };
    const decision = (id: string) => JSON.parse(decided.messages.data.find((row) => row.id === `resp_${id}_0`)!.text).response as Record<string, unknown>;
    assert.deepEqual(decision('plan_1').updatedPermissions, [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }], 'auto-accept switches the session to accept edits');
    assert.equal(decided.mode, 'acceptEdits');
    assert.deepEqual(decision('edit_1'), { behavior: 'deny', message: 'Use the helper instead', interrupt: false }, 'deny feedback reaches the agent');
    assert.equal(controlled.forms.data[0]?.id, 'elicit_1');
    assert.equal(controlled.forms.data[0]?.detail, 'Requested by the linear MCP server');
    assert.deepEqual(controlled.forms.data[0]?.fields[0]?.options, [{ value: 'eng', label: 'Engineering' }, { value: 'ops', label: 'Operations' }]);
    const controlResponse = (id: string) => JSON.parse(controlled.messages.data.find((row) => row.id === `resp_${id}_0`)?.text ?? 'null') as Record<string, unknown> | null;
    assert.deepEqual(controlResponse('dialog_1'), { subtype: 'success', request_id: 'dialog_1', response: { behavior: 'cancelled' } }, 'an unknown dialog is cancelled');
    assert.equal(controlResponse('hook_1')?.subtype, 'error', 'an unhandled subtype gets a protocol error');
    await controlService.replyForm('process_control', 'elicit_1', { team: 'ops' });
    const elicited = await waitForConversation(controlService, 'process_control', /resp_elicit_1/) as typeof controlled;
    assert.deepEqual(JSON.parse(elicited.messages.data.find((row) => row.id === 'resp_elicit_1_0')!.text).response, { action: 'accept', content: { team: 'ops' } });
    assert.equal(elicited.forms.data.length, 0);
    await controlService.stop('process_control');

    // Harness state becomes notice rows: one row per retry run that settles as
    // recovered, one per compaction, stderr as a warning, and command output.
    const noticeService = new ClaudeStreamService(database, runtimeDirectory, process.execPath, { ...process.env, STREAM_FRAMES: '', NOTICES: '1' });
    const noticePrepared = await noticeService.prepare({
      executable, cwd: directory, name: 'Claude notices', context: 'Project context',
      mcp: { command: process.execPath, args: ['shim.js'], env: { PATTERM_MCP_SOCKET: '/tmp/mcp.sock', PATTERM_MCP_IDENTITY: 'identity_notices' } },
      resumeId: null
    });
    database.connection.prepare(`insert into processes (id,project_id,kind,name,status,cwd,argv,created_at,updated_at) values ('process_notices','project_test','agent','Claude notices','running',?,?,?,?)`)
      .run(directory, JSON.stringify(noticePrepared.argv), now, now);
    database.connection.prepare(`insert into sessions (id,project_id,process_id,harness,interface_mode,mcp_identity,resume_id,started_at,session_role,resume_status,created_by_actor) values ('session_notices','project_test','process_notices','claude','integrated','identity_notices',?,?, 'orchestrator','found','user')`)
      .run(noticePrepared.resumeId, now);
    await noticeService.prompt('process_notices', { text: 'notice me', references: [], attachments: [] });
    const noticed = await waitForConversation(noticeService, 'process_notices', /Recovered after/) as { messages: { data: Array<{ kind: string; level?: string; text: string }> } };
    const notices = noticed.messages.data.filter((row) => row.kind === 'notice').map((row) => [row.level, row.text]);
    assert.ok(notices.some(([, text]) => text === 'Recovered after 2 retries'), 'a retry run is one row that settles as recovered');
    assert.ok(notices.some(([, text]) => text === 'Conversation compacted automatically from 180k tokens to 22k'), 'compaction is one row');
    assert.ok(noticed.messages.data.some((row) => row.kind === 'text' && row.text === 'Total cost: $0.12'), 'local command output is shown');
    await waitForConversation(noticeService, 'process_notices', /deprecated setting/);
    const warned = await noticeService.conversation('process_notices') as { messages: { data: Array<{ kind: string; level?: string; text: string }> } };
    assert.ok(warned.messages.data.some((row) => row.kind === 'notice' && row.level === 'warning' && row.text === 'Warning: deprecated setting'), 'stderr is a warning notice, not assistant prose');
    const settled = await waitForConversation(noticeService, 'process_notices', /resp_late/) as unknown as { status: string; permissions: { data: Array<{ id: string }> }; messages: { data: Array<{ id: string; text: string }> } };
    assert.deepEqual(JSON.parse(settled.messages.data.find((row) => row.id === 'resp_late_0')!.text).response, { behavior: 'deny', message: 'The turn ended before this was answered', interrupt: false }, 'an unanswered main-agent prompt gets an explicit reply when the turn ends');
    assert.deepEqual(settled.permissions.data.map((item) => item.id), ['bg'], 'a background subagent keeps its prompt after the main turn ends');
    assert.equal(settled.status, 'permission', 'a waiting subagent needs a person; the late cancel did not revive the turn');
    await noticeService.replyPermission('process_notices', 'bg', 'once');
    const answeredBackground = await noticeService.conversation('process_notices') as { status: string };
    assert.equal(answeredBackground.status, 'idle', 'answering between turns returns to idle, not working');
    assert.deepEqual((warned as unknown as { diagnostics: { unhandled: Record<string, number> } }).diagnostics.unhandled.tool_progress, 2, 'unprojected native types are counted');
    const logged: Array<{ event: string; data: unknown }> = [];
    const noticeIntegrated = new IntegratedAgentService(database, { claude: noticeService });
    noticeIntegrated.setDebugLog({ write: (_source, event, data) => logged.push({ event, data }) });
    await noticeIntegrated.conversation('process_notices');
    await noticeIntegrated.conversation('process_notices');
    assert.equal(logged.filter((entry) => (entry.data as { type?: string }).type === 'tool_progress').length, 1, 'each unhandled type is logged once per agent');
    await noticeService.stop('process_notices');

    // Subagent rows have their own budget, and rows under a trimmed Task row
    // are dropped rather than shown in the main thread.
    const trimService = new ClaudeStreamService(database, runtimeDirectory, process.execPath, { ...process.env, STREAM_FRAMES: '', TRIM_SUBAGENTS: '1' });
    const trimPrepared = await trimService.prepare({
      executable, cwd: directory, name: 'Claude trim', context: 'Project context',
      mcp: { command: process.execPath, args: ['shim.js'], env: { PATTERM_MCP_SOCKET: '/tmp/mcp.sock', PATTERM_MCP_IDENTITY: 'identity_trim' } },
      resumeId: null
    });
    database.connection.prepare(`insert into processes (id,project_id,kind,name,status,cwd,argv,created_at,updated_at) values ('process_trim','project_test','agent','Claude trim','running',?,?,?,?)`)
      .run(directory, JSON.stringify(trimPrepared.argv), now, now);
    database.connection.prepare(`insert into sessions (id,project_id,process_id,harness,interface_mode,mcp_identity,resume_id,started_at,session_role,resume_status,created_by_actor) values ('session_trim','project_test','process_trim','claude','integrated','identity_trim',?,?, 'orchestrator','found','user')`)
      .run(trimPrepared.resumeId, now);
    await trimService.prompt('process_trim', { text: 'delegate', references: [], attachments: [] });
    const trimView = await waitForConversation(trimService, 'process_trim', /"status":"idle"/) as { messages: { data: Array<{ id: string; parentId?: string }> } };
    const trimmed = new Set(trimView.messages.data.map((row) => row.id));
    assert.ok(!trimmed.has('toolu_old') && !trimmed.has('toolu_old_child_0') && !trimmed.has('toolu_old_child_1'), 'rows under a trimmed Task row are dropped');
    assert.ok(trimmed.has('msg_main_2_0') && !trimmed.has('msg_main_1_0'), 'subagent rows do not evict the main thread');
    assert.ok(trimmed.has('toolu_new') && trimmed.has('toolu_new_child_0'), 'a live subagent keeps its rows');
    await trimService.stop('process_trim');

    // Subagent rows carry the Task tool id, and concurrent streams keep their
    // own blocks.
    const subagentService = new ClaudeStreamService(database, runtimeDirectory, process.execPath, { ...process.env, STREAM_FRAMES: '', SUBAGENTS: '1' });
    const subagentPrepared = await subagentService.prepare({
      executable, cwd: directory, name: 'Claude subagent', context: 'Project context',
      mcp: { command: process.execPath, args: ['shim.js'], env: { PATTERM_MCP_SOCKET: '/tmp/mcp.sock', PATTERM_MCP_IDENTITY: 'identity_subagent' } },
      resumeId: null
    });
    database.connection.prepare(`insert into processes (id,project_id,kind,name,status,cwd,argv,created_at,updated_at) values ('process_subagent','project_test','agent','Claude subagent','running',?,?,?,?)`)
      .run(directory, JSON.stringify(subagentPrepared.argv), now, now);
    database.connection.prepare(`insert into sessions (id,project_id,process_id,harness,interface_mode,mcp_identity,resume_id,started_at,session_role,resume_status,created_by_actor) values ('session_subagent','project_test','process_subagent','claude','integrated','identity_subagent',?,?, 'orchestrator','found','user')`)
      .run(subagentPrepared.resumeId, now);
    await subagentService.prompt('process_subagent', { text: 'delegate', references: [], attachments: [] });
    const nestedView = await waitForConversation(subagentService, 'process_subagent', /"status":"idle"/) as { messages: { data: Array<{ id: string; parentId?: string; text: string; tool?: { input?: unknown; state?: { status?: string } } }> } };
    const byId = new Map(nestedView.messages.data.map((row) => [row.id, row]));
    assert.equal(byId.get('toolu_task')?.parentId, undefined, 'the Task row belongs to the main transcript');
    assert.equal(byId.get('toolu_child_read')?.parentId, 'toolu_task', 'a subagent tool row nests under its Task');
    assert.deepEqual(byId.get('toolu_child_read')?.tool?.input, { file_path: '/tmp/c.ts' });
    assert.equal(byId.get('toolu_child_read')?.text, 'child file');
    assert.equal(byId.get('subagent_child-prompt')?.parentId, 'toolu_task', 'the subagent prompt nests under its Task');
    assert.equal(byId.get('msg_main2_0')?.text, 'Main text', 'the main stream keeps its blocks while a subagent streams');
    assert.equal(byId.get('msg_main2_0')?.parentId, undefined);
    assert.deepEqual((nestedView as unknown as { tasks: unknown }).tasks, [
      { id: 'task_bg', label: 'npm test --watch', status: 'running', stoppable: true, kind: 'local_bash', detail: '12 passing' },
      { id: 'task_moved', label: 'pnpm run build', status: 'running', stoppable: true, kind: 'local_bash' },
      { id: 'task_wf', label: 'review-changes', status: 'completed', stoppable: false, kind: 'workflow' }
    ], 'background shells and workflows are tasks; foreground and ambient ones are not');
    await subagentService.stopTask('process_subagent', 'task_bg');
    const stoppedView = await waitForConversation(subagentService, 'process_subagent', /Stopped by user/) as { tasks: Array<{ id: string; status: string; stoppable: boolean }> };
    assert.deepEqual(stoppedView.tasks.map((task) => [task.id, task.status, task.stoppable]), [['task_moved', 'running', true], ['task_wf', 'completed', false], ['task_bg', 'stopped', false]], 'Stop sends the native stop_task');
    await assert.rejects(subagentService.stopTask('process_subagent', 'unknown'), /no longer known/);
    const { lastModelActivityAt: claudeActivity, limits: claudeLimits, ...claudeUsage } = (nestedView as unknown as { usage: Record<string, unknown> & { limits: Array<Record<string, unknown>> } }).usage;
    assert.ok(claudeLimits.every(({ observedAt }) => Date.now() - Date.parse(String(observedAt)) < 60_000), 'each quota window is dated when Claude reported it');
    assert.ok(Date.now() - Date.parse(String(claudeActivity)) < 60_000, 'a main-agent message_start stamps the latest model activity');
    assert.deepEqual({ ...claudeUsage, limits: claudeLimits.map(({ observedAt: _, ...limit }) => limit) }, {
      contextTokens: 32_000, costUsd: 0.42, inputTokens: 31_800, outputTokens: 300, contextWindow: 200_000,
      limits: [{ label: '5h limit', usedPercent: 82, resetsAt: new Date(1790000000 * 1000).toISOString() }, { label: 'Weekly limit', usedPercent: 27, resetsAt: new Date(1790500000 * 1000).toISOString() }]
    }, 'context comes from the main agent, not a subagent; totals and quota are reported');
    await subagentService.stop('process_subagent');

    // A failed native turn reports an error status and keeps its message.
    const errorService = new ClaudeStreamService(database, runtimeDirectory, process.execPath, { ...process.env, STREAM_FRAMES: '1', ERROR_RESULT: '1' });
    const errorPrepared = await errorService.prepare({
      executable, cwd: directory, name: 'Claude error', context: 'Project context',
      mcp: { command: process.execPath, args: ['shim.js'], env: { PATTERM_MCP_SOCKET: '/tmp/mcp.sock', PATTERM_MCP_IDENTITY: 'identity_error' } },
      resumeId: null
    });
    database.connection.prepare(`insert into processes (id,project_id,kind,name,status,cwd,argv,created_at,updated_at) values ('process_error','project_test','agent','Claude error','running',?,?,?,?)`)
      .run(directory, JSON.stringify(errorPrepared.argv), now, now);
    database.connection.prepare(`insert into sessions (id,project_id,process_id,harness,interface_mode,mcp_identity,resume_id,started_at,session_role,resume_status,created_by_actor) values ('session_error','project_test','process_error','claude','integrated','identity_error',?,?, 'orchestrator','found','user')`)
      .run(errorPrepared.resumeId, now);
    await errorService.prompt('process_error', { text: 'fail', references: [], attachments: [] });
    const errored = await waitForConversation(errorService, 'process_error', /credential expired/);
    assert.equal(errored.status, 'error', 'a failed native turn reports error');
    await errorService.stop('process_error');

    // An interrupted turn settles as idle, with no error row, and its running
    // tool is no longer shown as in progress.
    const interruptService = new ClaudeStreamService(database, runtimeDirectory, process.execPath, { ...process.env, INTERRUPT_TURN: '1' });
    const interruptPrepared = await interruptService.prepare({
      executable, cwd: directory, name: 'Claude interrupt', context: 'Project context',
      mcp: { command: process.execPath, args: ['shim.js'], env: { PATTERM_MCP_SOCKET: '/tmp/mcp.sock', PATTERM_MCP_IDENTITY: 'identity_interrupt' } },
      resumeId: null
    });
    database.connection.prepare(`insert into processes (id,project_id,kind,name,status,cwd,argv,created_at,updated_at) values ('process_interrupt','project_test','agent','Claude interrupt','running',?,?,?,?)`)
      .run(directory, JSON.stringify(interruptPrepared.argv), now, now);
    database.connection.prepare(`insert into sessions (id,project_id,process_id,harness,interface_mode,mcp_identity,resume_id,started_at,session_role,resume_status,created_by_actor) values ('session_interrupt','project_test','process_interrupt','claude','integrated','identity_interrupt',?,?, 'orchestrator','found','user')`)
      .run(interruptPrepared.resumeId, now);
    await interruptService.prompt('process_interrupt', { text: 'stall', references: [], attachments: [] });
    await waitForConversation(interruptService, 'process_interrupt', /toolu_stall/);
    await interruptService.interrupt('process_interrupt');
    let interruptedState: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 100; attempt++) {
      interruptedState = await interruptService.conversation('process_interrupt') as Record<string, unknown>;
      if (interruptedState.status === 'idle') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(interruptedState.status, 'idle', 'an interrupted turn settles as idle');
    const interruptedText = JSON.stringify(interruptedState);
    assert.doesNotMatch(interruptedText, /error_during_execution/, 'an interrupted turn adds no error row');
    assert.doesNotMatch(interruptedText, /"status":"running"/, 'an interrupted turn leaves no running tool');
    await interruptService.stop('process_interrupt');

    // Activity follows Claude's own reports. The host asks for session state,
    // so a turn Claude starts by itself shows as working; a fake CLI told not
    // to report it exercises the fallback.
    const { CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: _inherited, ...baseEnv } = process.env;
    const envPath = path.join(directory, 'claude-env.json');
    const launchActivity = async (name: string, legacy: boolean) => {
      const activityService = new ClaudeStreamService(database, runtimeDirectory, process.execPath, {
        ...baseEnv, STREAM_FRAMES: '', ACTIVITY: '1', ENV_FILE: envPath, ...(legacy ? { CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '0' } : {})
      });
      const launched = await activityService.prepare({
        executable, cwd: directory, name, context: 'Project context',
        mcp: { command: process.execPath, args: ['shim.js'], env: { PATTERM_MCP_SOCKET: '/tmp/mcp.sock', PATTERM_MCP_IDENTITY: `identity_activity_${name}` } },
        resumeId: null
      });
      const processId = `process_activity_${name}`;
      database.connection.prepare(`insert into processes (id,project_id,kind,name,status,cwd,argv,created_at,updated_at) values (?,'project_test','agent',?,'running',?,?,?,?)`)
        .run(processId, name, directory, JSON.stringify(launched.argv), now, now);
      database.connection.prepare(`insert into sessions (id,project_id,process_id,harness,interface_mode,mcp_identity,resume_id,started_at,session_role,resume_status,created_by_actor) values (?,'project_test',?,'claude','integrated',?,?,?, 'orchestrator','found','user')`)
        .run(`session_activity_${name}`, processId, `identity_activity_${name}`, launched.resumeId, now);
      const activityEvents: IntegratedConversationEvent[] = [];
      const releaseActivity = await activityService.subscribe(processId, (event) => activityEvents.push(event));
      const statuses = () => activityEvents.flatMap((event) => event.kind === 'status' ? [event.status] : []);
      // Event positions, to order a transcript row against status changes.
      const published = (id: string) => activityEvents.findIndex((event) => event.kind === 'replace' && event.message?.id === id);
      const statusAt = (nth: number) => activityEvents.map((event, index) => event.kind === 'status' ? index : -1).filter((index) => index >= 0)[nth] ?? -1;
      // Patterm's own observation, which persists the streamed status.
      const observeActivity = async () => {
        const observing = new IntegratedAgentService(database, { claude: activityService });
        const changes: string[] = [];
        observing.onActivityChange((change) => changes.push(change.activity));
        observing.observe(processId);
        await new Promise((resolve) => setTimeout(resolve, 100));
        return {
          changes,
          activity: () => (database.connection.prepare('select activity from processes where id = ?').get(processId) as { activity: string }).activity,
          dispose: () => observing.dispose()
        };
      };
      return {
        processId, statuses, published, statusAt, observeActivity,
        prompt: (text: string) => activityService.prompt(processId, { text, references: [], attachments: [] }),
        snapshot: async () => await activityService.conversation(processId) as { status?: string; tasks: Array<{ id: string; status: string }>; messages: { data: Array<{ id: string; text: string; kind: string }> } },
        until: (count: number) => waitFor(() => statuses().length >= count, 5_000),
        interrupt: () => activityService.interrupt(processId),
        reply: (requestId: string) => activityService.replyPermission(processId, requestId, 'once'),
        close: async () => { releaseActivity(); await activityService.stop(processId); }
      };
    };

    for (const legacy of [false, true]) {
      const mode = legacy ? 'without session state' : 'with session state';
      const suffix = legacy ? 'legacy' : 'native';

      if (!legacy) {
        const bash = await launchActivity('bash', legacy);
        const bashActivity = await bash.observeActivity();
        await bash.prompt('bash before result');
        await waitFor(() => bash.published('toolu_bash') >= 0, 5_000);
        assert.equal((await bash.snapshot()).status, 'working', 'Bash stays working until the turn result, despite a session idle report');
        await bash.prompt('finish bash');
        await waitFor(() => bash.published('msg_after_bash_0') >= 0, 5_000);
        assert.equal((await bash.snapshot()).status, 'working', 'finishing Bash does not finish the turn');
        await bash.prompt('finish turn');
        await waitFor(() => bash.statuses().at(-1) === 'idle', 5_000);
        await waitFor(() => bashActivity.activity() === 'idle');
        assert.deepEqual(bash.statuses(), ['working', 'idle'], 'no transient idle during the turn');
        assert.deepEqual(bashActivity.changes, ['working', 'idle'], 'persisted activity stays working through Bash');
        bashActivity.dispose();
        await bash.close();

        // Internally queued commands have UUIDs outside the prompt map and
        // can wait for a response before their first message_start.
        const early = await launchActivity('early_interrupt', legacy);
        await early.prompt('wake before stream');
        await waitFor(() => early.published('notification_autonomous_started') >= 0, 5_000);
        assert.equal((await early.snapshot()).status, 'working');
        await early.interrupt();
        await early.until(4);
        const earlyStopped = await early.snapshot();
        assert.equal(earlyStopped.status, 'idle', 'interrupting an autonomous command before streaming settles as idle');
        assert.ok(!earlyStopped.messages.data.some((row) => row.kind === 'notice' && /error_during_execution/.test(row.text)), 'early interruption adds no false failure');
        await early.close();

        const backgroundOnly = await launchActivity('background_interrupt', legacy);
        await backgroundOnly.prompt('background only');
        await waitFor(() => backgroundOnly.published('notification_background_only') >= 0, 5_000);
        assert.equal((await backgroundOnly.snapshot()).status, 'working');
        await backgroundOnly.interrupt();
        await backgroundOnly.until(2);
        await backgroundOnly.prompt('fail');
        await waitFor(() => backgroundOnly.statuses().at(-1) === 'error', 5_000);
        assert.match(JSON.stringify(await backgroundOnly.snapshot()), /Network failure/, 'interrupting background-only activity does not hide a later main-turn failure');
        await backgroundOnly.close();
      }

      // A turn Claude starts by itself, such as one woken by a finished
      // background shell, is working until its result, including without
      // session-state events.
      const woken = await launchActivity(`wake_${suffix}`, legacy);
      await woken.prompt('wake');
      await woken.until(4);
      assert.deepEqual(woken.statuses(), ['working', 'idle', 'working', 'idle'], 'a self-started turn shows as working');
      const wokenReply = woken.published('msg_wake_woken_0');
      assert.ok(wokenReply > woken.statusAt(2) && wokenReply < woken.statusAt(3), 'the woken turn replies while working');
      assert.equal((await woken.snapshot()).status, 'idle');
      await woken.close();

      // Interrupting a turn Claude started by itself settles it as idle,
      // not as a failure; an interrupt with nothing running leaves a later
      // failure reported as one.
      const held = await launchActivity(`interrupt_${suffix}`, legacy);
      await held.prompt('wake and hold');
      await waitFor(() => held.published('msg_wake_held_0') >= 0, 5_000);
      assert.equal((await held.snapshot()).status, 'working', 'a held self-started turn is working');
      await held.interrupt();
      await waitFor(() => held.statuses().at(-1) === 'idle', 5_000);
      const stoppedTurn = await held.snapshot();
      assert.equal(stoppedTurn.status, 'idle', 'an interrupted self-started turn settles as idle');
      assert.ok(!stoppedTurn.messages.data.some((row) => row.kind === 'notice' && /error_during_execution/.test(row.text)), 'an interrupted self-started turn adds no error row');
      await held.interrupt();
      await new Promise((resolve) => setTimeout(resolve, 40));
      await held.prompt('fail');
      await waitFor(() => held.statuses().at(-1) === 'error', 5_000);
      assert.equal((await held.snapshot()).status, 'error', 'an interrupt with nothing running does not hide a later failure');
      await held.close();

      const toolOnly = await launchActivity(`tool_only_${suffix}`, legacy);
      await toolOnly.prompt('wake tool');
      await waitFor(() => toolOnly.published('toolu_woken_bash') >= 0, 5_000);
      assert.equal((await toolOnly.snapshot()).status, 'working', `a self-started Bash call without partial events is working ${mode}`);
      await toolOnly.interrupt();
      await toolOnly.until(4);
      assert.deepEqual(toolOnly.statuses(), ['working', 'idle', 'working', 'idle'], 'a tool-only turn ends on its result');
      await toolOnly.close();

      // A background agent outliving the turn keeps the agent working until
      // it finishes. With session state there is no idle at all, through the
      // turn the agent's finish wakes; the fallback counts the native level of
      // background agents.
      const agent = await launchActivity(`agent_${suffix}`, legacy);
      const agentActivity = await agent.observeActivity();
      await agent.prompt('agent');
      await waitFor(() => agent.published('msg_wake_finished_0') >= 0 && agent.statuses().at(-1) === 'idle', 5_000);
      assert.deepEqual(JSON.parse(fs.readFileSync(envPath, 'utf8')), { sessionState: legacy ? '0' : '1' }, 'the host asks Claude for its session state unless told not to');
      if (!legacy) assert.deepEqual(agent.statuses(), ['working', 'idle'], 'a background agent keeps the agent working through its turn\'s result');
      assert.ok(agent.statusAt(1) > agent.published('msg_sub_work_0'), `the agent stays working while its background agent works ${mode}`);
      await waitFor(() => agentActivity.activity() === 'idle');
      if (!legacy) assert.deepEqual(agentActivity.changes, ['working', 'idle'], 'persisted activity follows without an idle in between');
      agentActivity.dispose();
      await agent.close();

      // A CLI that exits takes its background agents with it, so they do not
      // keep the agent working once the next process runs.
      const crashed = await launchActivity(`crash_${suffix}`, legacy);
      await crashed.prompt('crash');
      await waitFor(() => crashed.statuses().at(-1) === 'error', 5_000);
      await crashed.prompt('after crash');
      await waitFor(() => crashed.statuses().at(-1) === 'idle', 5_000);
      const recovered = await crashed.snapshot();
      assert.equal(recovered.status, 'idle', `a dead CLI's background agent does not keep its successor working ${mode}`);
      assert.deepEqual(recovered.tasks.map((task) => [task.id, task.status]), [['agent_crash', 'stopped']], 'its background agent shows as stopped');
      await crashed.close();

      // A background shell such as a dev server does not keep it working.
      const shell = await launchActivity(`shell_${suffix}`, legacy);
      await shell.prompt('shell');
      await shell.until(2);
      assert.deepEqual(shell.statuses(), ['working', 'idle'], `a background shell does not keep the agent working ${mode}`);
      const served = await shell.snapshot();
      assert.equal(served.status, 'idle');
      assert.deepEqual(served.tasks.map((task) => [task.id, task.status]), [['shell_1', 'running']], 'the shell is still shown as running');
      await shell.close();

      // A prompt sent while a request waits keeps the agent waiting on it;
      // answering it resumes the turn, which then takes the prompt.
      const ask = await launchActivity(`ask_${suffix}`, legacy);
      await ask.prompt('ask');
      await ask.until(2);
      assert.deepEqual(ask.statuses(), ['working', 'permission'], 'permission streams as its own status');
      await ask.prompt('extra');
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal((await ask.snapshot()).status, 'permission', `a prompt during a permission request keeps permission ${mode}`);
      assert.deepEqual(ask.statuses(), ['working', 'permission']);
      await ask.reply('main_perm');
      await ask.until(4);
      assert.deepEqual(ask.statuses(), ['working', 'permission', 'working', 'idle'], `answering resumes the turn ${mode}`);
      await ask.close();

      // A background agent's request pending when the main turn ends goes
      // straight to permission, with no idle in between, and answering it
      // resumes the background agent.
      const agentAsk = await launchActivity(`agent_ask_${suffix}`, legacy);
      const askActivity = await agentAsk.observeActivity();
      await agentAsk.prompt('agent ask');
      await waitFor(() => agentAsk.published('msg_agent_launched_0') >= 0, 5_000);
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.deepEqual(agentAsk.statuses(), ['working', 'permission'], `a turn ending with a background agent's request pending stays on permission ${mode}`);
      assert.equal((await agentAsk.snapshot()).status, 'permission');
      assert.equal(askActivity.activity(), 'permission', `persisted activity ends the turn on permission ${mode}`);
      assert.deepEqual(askActivity.changes, ['working', 'permission'], 'persisted activity never passes through idle');
      askActivity.dispose();
      if (legacy) {
        // Without session state an interrupt has no turn to stop here, so it
        // must not mark a later failure as an interruption.
        await agentAsk.interrupt();
      }
      await agentAsk.reply('sub_perm');
      await waitFor(() => agentAsk.published('msg_wake_finished after permission_0') >= 0 && agentAsk.statuses().at(-1) === 'idle', 5_000);
      assert.deepEqual(agentAsk.statuses().slice(0, 3), ['working', 'permission', 'working'], `answering resumes the background agent ${mode}`);
      if (legacy) {
        await agentAsk.prompt('fail');
        await waitFor(() => agentAsk.statuses().at(-1) === 'error', 5_000);
        assert.match(JSON.stringify(await agentAsk.snapshot()), /Network failure/, 'a stale interrupt does not swallow a later failure');
      }
      await agentAsk.close();
    }

    // A prompt Claude refuses never starts a turn, so it does not leave the
    // agent working.
    const refused = await launchActivity('refused', false);
    await refused.prompt('refused');
    await refused.until(2);
    assert.deepEqual(refused.statuses(), ['working', 'idle'], 'a refused prompt returns to idle');
    await refused.close();

    // A missing executable fails the launch without crashing the host.
    const missingService = new ClaudeStreamService(database, runtimeDirectory, process.execPath);
    await assert.rejects(
      missingService.prepare({
        executable: path.join(directory, 'does-not-exist-claude'),
        cwd: directory,
        name: 'Missing Claude',
        context: 'Project context',
        mcp: { command: process.execPath, args: ['shim.js'], env: { PATTERM_MCP_SOCKET: '/tmp/mcp.sock', PATTERM_MCP_IDENTITY: 'identity_missing' } },
        resumeId: null
      }),
      /could not start/
    );

    // A native CLI that exits before close must still be cleaned up: the
    // graceful interrupt fails, the stop path runs, and the real close action
    // marks the process closed.
    const dyingService = new ClaudeStreamService(database, runtimeDirectory, process.execPath, { ...process.env, EXIT_AFTER_PROMPT: '1' });
    const dyingPrepared = await dyingService.prepare({
      executable, cwd: directory, name: 'Claude dying', context: 'Project context',
      mcp: { command: process.execPath, args: ['shim.js'], env: { PATTERM_MCP_SOCKET: '/tmp/mcp.sock', PATTERM_MCP_IDENTITY: 'identity_dying' } },
      resumeId: null
    });
    database.connection.prepare(`insert into processes (id,project_id,kind,name,status,cwd,argv,created_at,updated_at) values ('process_dying','project_test','agent','Claude dying','running',?,?,?,?)`)
      .run(directory, JSON.stringify(dyingPrepared.argv), now, now);
    database.connection.prepare(`insert into sessions (id,project_id,process_id,harness,interface_mode,mcp_identity,resume_id,started_at,session_role,resume_status,created_by_actor) values ('session_dying','project_test','process_dying','claude','integrated','identity_dying',?,?, 'orchestrator','found','user')`)
      .run(dyingPrepared.resumeId, now);
    await dyingService.prompt('process_dying', { text: 'die', references: [], attachments: [] });
    let dyingState: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 100; attempt++) {
      dyingState = await dyingService.conversation('process_dying') as Record<string, unknown>;
      if (dyingState.status === 'error') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(dyingState.status, 'error', 'an exited native CLI surfaces a failed turn');
    const terminal = { request: async () => ({ status: 'stopped' }) } as unknown as TerminalService;
    const dyingAgent = new IntegratedAgentService(database, { claude: dyingService });
    await new CloseProcessAction(database, terminal, undefined, dyingAgent).execute('process_dying');
    const dyingRow = database.connection.prepare(`select status, exited_at from processes where id = 'process_dying'`).get() as { status: string; exited_at: string | null };
    assert.equal(dyingRow.status, 'closed', 'the close action cleans up a dead native CLI');
    assert.ok(dyingRow.exited_at, 'the close action records the exit time');

    // A live host that refuses to stop must not be reported as stopped.
    const refusing = { stop: async () => { throw new Error('host refused to stop'); } };
    await assert.rejects(
      new CloseProcessAction(database, terminal, undefined, refusing).execute('process_test'),
      /host refused to stop/,
      'an unstoppable live host surfaces the failure'
    );
    assert.equal((database.connection.prepare(`select status from processes where id = 'process_test'`).get() as { status: string }).status, 'running', 'an unstoppable live host is not marked closed');

    // A host from an older generation has no `controls` method; the composer
    // still reads its settings from the full conversation reply.
    const legacySocket = path.join(directory, 'legacy.sock');
    const legacyMethods: string[] = [];
    const legacyHost = net.createServer((socket) => {
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        const request = JSON.parse(chunk.trim()) as { id: string; method: string };
        legacyMethods.push(request.method);
        socket.write(`${JSON.stringify(request.method === 'conversation'
          ? { id: request.id, result: { status: 'idle', model: 'sonnet', mode: 'manual', models: [{ value: 'sonnet', displayName: 'Sonnet 5', supportedEffortLevels: ['low'] }], commands: [{ name: 'compact' }] } }
          : { id: request.id, error: `Unknown Claude host method: ${request.method}` })}\n`);
      });
    });
    await new Promise<void>((resolve) => legacyHost.listen(ipcPath(legacySocket), resolve));
    try {
      database.connection.prepare(`insert into processes (id,project_id,kind,name,status,cwd,argv,created_at,updated_at) values ('process_legacy','project_test','agent','Claude','running',?,?,?,?)`)
        .run(directory, JSON.stringify([executable, 'claude-host', legacySocket, '', '']), now, now);
      database.connection.prepare(`insert into sessions (id,project_id,process_id,harness,interface_mode,mcp_identity,resume_id,started_at,session_role,resume_status,created_by_actor) values ('session_legacy','project_test','process_legacy','claude','integrated','identity_legacy','legacy_resume',?, 'orchestrator','found','user')`)
        .run(now);
      const legacy = await service.controls('process_legacy');
      assert.deepEqual(legacy.selectors[0]?.options, [{ value: 'sonnet', label: 'Sonnet 5' }], 'an older host still reports native models');
      assert.deepEqual(legacy.commands, [{ name: 'compact' }]);
      assert.deepEqual(legacyMethods, ['controls', 'conversation'], 'the older host falls back to one conversation read');
      database.connection.prepare(`update sessions set exited_at = ? where id = 'session_legacy'`).run(now);
      database.connection.prepare(`update processes set status = 'closed' where id = 'process_legacy'`).run();
    } finally {
      await new Promise<void>((resolve) => legacyHost.close(() => resolve()));
    }

    const reconnected = new ClaudeStreamService(database, runtimeDirectory, process.execPath);
    assert.match(JSON.stringify(await reconnected.conversation('process_test')), /Native Claude reply/);
    await reconnected.stop('process_test');
    // A host that has ended reports a resumable state, not a raw socket error.
    // A named pipe leaves no file behind, so Windows waits for it to close.
    if (process.platform === 'win32') {
      for (let attempt = 0; attempt < 100 && await integratedHostListening(prepared.argv[2]!); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
    } else await waitFor(() => !fs.existsSync(prepared.argv[2]!));
    await assert.rejects(reconnected.conversation('process_test'), /host is no longer running\. Resume the conversation to continue\./);
  } finally {
    database.dispose();
    // Windows cannot remove a directory that an exiting host or CLI still runs in.
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

void main().then(() => console.log('claude stream smoke ok'));

async function waitFor(predicate: () => boolean, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(predicate(), 'condition was not met before the timeout');
}

async function waitForConversation(service: ClaudeStreamService, processId: string, match: RegExp): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const payload = await service.conversation(processId) as Record<string, unknown>;
    if (match.test(JSON.stringify(payload))) return payload;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Conversation never matched ${String(match)}`);
}
