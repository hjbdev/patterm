import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../app/Services/DatabaseService';
import net from 'node:net';
import { CodexAppServerService, CodexRpcClient } from '../app/Services/CodexAppServerService';
import { projectCodexItem, projectCodexPlan, restoreCodexWindowGap, trimCodexWindow, CODEX_MESSAGE_WINDOW, CODEX_CHILD_WINDOW, type CodexConversationState } from '../app/Services/CodexTranscript';
import { elicitationForm } from '../app/Services/McpElicitation';
import { TranscriptImageStore } from '../app/Services/TranscriptImageStore';
import { TurnBusyError, UncertainDeliveryError } from '../app/Services/IntegratedDelivery';
import type { IntegratedConversationEvent } from '../app/Services/IntegratedConversation';
import { IntegratedAgentService } from '../app/Services/IntegratedAgentService';

// A turn/start reply can arrive in the same chunk as the turn's completion.
// prompt() marks the turn active after awaiting the reply, which runs after
// the completion; that must not leave the finished turn active.
async function turnCompletedWithItsReply(): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-codex-turn-'));
  const socketPath = path.join(directory, 'app.sock');
  const server = net.createServer((socket) => {
    let buffer = '';
    let turns = 0;
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        const request = JSON.parse(buffer.slice(0, newline)) as { id: number };
        buffer = buffer.slice(newline + 1);
        const id = `turn_${++turns}`;
        const lines = [
          { jsonrpc: '2.0', id: request.id, result: { turn: { id } } },
          { jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread', turn: { id, status: 'inProgress' } } },
          // The second turn keeps running.
          ...(turns === 1 ? [{ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread', turn: { id, status: 'completed' } } }] : [])
        ];
        socket.write(lines.map((line) => JSON.stringify(line) + '\n').join(''));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const client = await CodexRpcClient.connect(socketPath, () => {});
  try {
    const startTurn = async () => {
      const response = await client.request('turn/start', { threadId: 'thread' }) as { turn: { id: string } };
      client.setActiveTurn('thread', response.turn.id);
    };
    await startTurn();
    assert.equal(client.activeTurn('thread'), null, 'a turn that ended with its reply is not active');
    await startTurn();
    assert.equal(client.activeTurn('thread'), 'turn_2', 'a later turn on the thread is active');
  } finally {
    client.close();
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await turnCompletedWithItsReply();
  assert.equal(projectCodexItem({ type: 'userMessage', id: 'native-user', clientId: 'client-user', content: [] })?.clientMessageId, 'client-user', 'native rows preserve the optimistic message correlation');
  assert.deepEqual(projectCodexItem({
    type: 'userMessage', id: 'user_image', content: [
      { type: 'text', text: 'Describe this image' },
      { type: 'localImage', path: '/private/uploads/cd160179-f074-42cc-87b9-35e55b9d54a8-colours.png' }
    ]
  }), {
    id: 'user_image', role: 'user', kind: 'text', text: 'Describe this image',
    attachments: [{ type: 'localImage', name: 'colours.png' }]
  }, 'Codex image chips use the original filename without exposing a server upload path');
  {
    // With a store, uploaded and viewed images become stored references.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-codex-images-'));
    const imageFile = path.join(directory, 'cd160179-f074-42cc-87b9-35e55b9d54a8-colours.png');
    fs.writeFileSync(imageFile, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
    const images = new TranscriptImageStore(path.join(directory, 'store'));
    const user = projectCodexItem({ type: 'userMessage', id: 'user_image', content: [{ type: 'localImage', path: imageFile }] }, images);
    const sha256 = String(user?.attachments?.[0]?.sha256);
    assert.deepEqual(user?.attachments, [{ type: 'localImage', name: 'colours.png', sha256 }]);
    assert.equal(projectCodexItem({ type: 'imageView', id: 'view', path: imageFile }, images)?.tool?.images?.[0]?.sha256, sha256, 'a viewed image is stored once by hash');
    assert.deepEqual(images.read(sha256), { mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' });
    assert.equal(projectCodexItem({ type: 'imageView', id: 'missing', path: path.join(directory, 'gone.png') }, images)?.tool?.images, undefined, 'a missing file stays a plain read row');
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.deepEqual(projectCodexPlan({ threadId: 't', turnId: 'turn_1', explanation: 'Two steps', plan: [{ step: 'Read', status: 'completed' }, { step: 'Write', status: 'inProgress' }] }), {
    id: 'plan_turn_1', role: 'assistant', kind: 'tool', title: 'Plan', text: 'Two steps',
    tool: { name: 'todowrite', input: { todos: [{ content: 'Read', status: 'completed' }, { content: 'Write', status: 'inProgress' }] }, state: 'completed' }
  }, 'update_plan becomes one checklist row per turn');
  // Subagent rows have their own budget: they never push the agent's rows out.
  {
    const window: CodexConversationState = {
      revision: 0, status: 'idle', truncated: false,
      messages: [
        ...Array.from({ length: CODEX_MESSAGE_WINDOW }, (_, index) => ({ id: `own_${index}`, role: 'assistant' as const, kind: 'text' as const, text: '' })),
        ...Array.from({ length: CODEX_CHILD_WINDOW + 50 }, (_, index) => ({ id: `child_${index}`, role: 'assistant' as const, kind: 'text' as const, text: '', parentId: 'spawn' }))
      ]
    };
    trimCodexWindow(window);
    assert.equal(window.messages.filter((message) => !message.parentId).length, CODEX_MESSAGE_WINDOW, 'every own row survives');
    assert.equal(window.messages.filter((message) => message.parentId).length, CODEX_CHILD_WINDOW);
    assert.equal(window.messages.find((message) => message.parentId)?.id, 'child_50', 'the oldest subagent rows go first');
    assert.equal(window.truncated, false, 'trimming subagent rows does not truncate the agent history');
  }
  {
    // A synthetic notice pushed native row 101 out of the live window. The
    // refreshed listing still holds it, and its cursor points before it, so
    // the row is put back and paging back skips nothing.
    const row = (id: string) => ({ id, role: 'assistant' as const, kind: 'text' as const, text: id });
    const state: CodexConversationState = { revision: 0, status: 'idle', truncated: true, messages: [
      ...Array.from({ length: 199 }, (_, index) => row(`n${102 + index}`)),
      { id: 'notice', role: 'assistant', kind: 'notice', level: 'warning', text: 'Retrying' }
    ] };
    const listing = Array.from({ length: 200 }, (_, index) => row(`n${101 + index}`));
    restoreCodexWindowGap(state, listing);
    assert.deepEqual(state.messages.slice(0, 2).map((message) => message.id), ['n101', 'n102']);
    assert.equal(state.messages.length, 201);
    restoreCodexWindowGap(state, listing);
    assert.equal(state.messages.length, 201, 'restoring is idempotent');
    const current: CodexConversationState = { revision: 0, status: 'idle', truncated: true, messages: listing.slice(0, 50) };
    restoreCodexWindowGap(current, listing);
    assert.equal(current.messages.length, 50, 'a window that already reaches the listing start gains nothing');
  }
  const titled = elicitationForm({ id: 'e', title: 'Connect Linear?', message: 'Linear needs your workspace', source: 'the linear MCP server', schema: { type: 'object', properties: {} } });
  assert.deepEqual([titled.title, titled.detail], ['Connect Linear?', 'Linear needs your workspace\nRequested by the linear MCP server'], 'a display title heads the form and the message stays visible');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-codex-app-server-'));
  const waitFor = async (predicate: () => boolean, timeout = 3_000): Promise<void> => {
    const deadline = Date.now() + timeout;
    while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(predicate(), 'condition was not met before the timeout');
  };
  const executable = path.join(directory, 'codex');
fs.writeFileSync(executable, `#!/usr/bin/env node
const http = require('node:http');
const fs = require('node:fs');
if (process.env.CODEX_ARGV_FILE) fs.writeFileSync(process.env.CODEX_ARGV_FILE, JSON.stringify(process.argv.slice(2)));
const { WebSocketServer } = require('${require.resolve('ws')}');
const target = process.argv.find((value) => value.startsWith('unix://'));
const socketPath = target.slice('unix://'.length);
const items = [];
const childItems = [];
// Newer Codex builds report a native subagent with subAgentActivity rows, and
// a command that outlives its tool call as a background terminal.
if (process.env.NATIVE_TASKS) {
  items.push({turnId:'turn_native',item:{type:'subAgentActivity',id:'call_native',kind:'started',agentThreadId:'thread_native',agentPath:'/root/file_summary'}});
  items.push({turnId:'turn_native',item:{type:'commandExecution',id:'exec_bg',command:"/bin/bash -lc 'ping -c 120 127.0.0.1'",cwd:'/tmp',processId:'77',source:'unifiedExecStartup',status:'inProgress',commandActions:[],aggregatedOutput:'PING 127.0.0.1\\n64 bytes: icmp_seq=1\\n'}});
  items.push({turnId:'turn_native',item:{type:'commandExecution',id:'exec_fg',command:"/bin/bash -lc 'ls'",cwd:'/tmp',processId:'78',source:'unifiedExecStartup',status:'completed',exitCode:0,commandActions:[],aggregatedOutput:'a.txt\\n'}});
  items.push({turnId:'turn_native',item:{type:'subAgentActivity',id:'subagent-completed-native',kind:'completed',agentThreadId:'thread_native',agentPath:'/root/file_summary'}});
}
const nativeItems = Array.from({length:130},(_,index)=>({turnId:'turn_sub',item:{type:'agentMessage',id:'native_' + index,text:'step ' + index}}));
let itemsListCalls = 0;
try { fs.unlinkSync(socketPath); } catch {}
const server = http.createServer();
const wss = new WebSocketServer({ server });
wss.on('connection', (socket) => {
  const notify = (method, params) => socket.send(JSON.stringify({jsonrpc:'2.0', method, params}));
  let initialized = false;
  socket.on('message', (chunk) => {
      const request = JSON.parse(chunk.toString());
      const send = (value) => socket.send(JSON.stringify(value));
      // Client responses to server requests are recorded as transcript rows
      // so the smoke can see exactly what Patterm answered.
      if (request.method === undefined && request.id !== undefined) {
        items.push({turnId:'turn_test',item:{type:'agentMessage',id:'response_' + request.id,text:JSON.stringify(request.error ? {error:request.error.message} : request.result)}});
        return;
      }
      // Like the real app-server, the host's one connection initialises once.
      if (request.method === 'initialize') {
        if (initialized) send({jsonrpc:'2.0', id:request.id, error:{code:-32600, message:'Already initialized'}});
        else send({jsonrpc:'2.0', id:request.id, result:{}});
        initialized = true;
      }
      else if (request.method === 'model/list') send({jsonrpc:'2.0', id:request.id, result:{data:[{id:'gpt-test',displayName:'GPT Test',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'low',description:'Faster'},{reasoningEffort:'medium',description:'Balanced'},{reasoningEffort:'high',description:'Deeper'}],serviceTiers:[{id:'priority',name:'Fast',description:'1.5x speed'}]}]}});
      else if (request.method === 'config/read') send({jsonrpc:'2.0', id:request.id, result:{config:{service_tier:'default'}}});
      else if (request.method === 'thread/start' || request.method === 'thread/resume') {
        send({jsonrpc:'2.0', id:request.id, result:{thread:{id:'thread_test'}}});
        // Codex starts MCP servers right after the thread, before Patterm observes it.
        if (process.env.MCP_FAILURE) {
          notify('mcpServer/startupStatus/updated', {threadId:'thread_test', name:'linear', status:'failed', error:'The linear MCP server is not logged in.', failureReason:null});
          notify('mcpServer/startupStatus/updated', {threadId:'thread_early_child', name:'child-only', status:'failed', error:'x', failureReason:null});
        }
      }
      else if (request.method === 'turn/start' && process.env.MCP_FAILURE) {
        send({jsonrpc:'2.0', id:request.id, result:{turn:{id:'turn_test'}}});
        // Codex retries failed servers on later turns.
        notify('mcpServer/startupStatus/updated', {threadId:'thread_test', name:'linear', status:'failed', error:'The linear MCP server is not logged in.', failureReason:null});
        notify('mcpServer/startupStatus/updated', {threadId:'thread_test', name:'there', status:'failed', error:'refresh token rejected', failureReason:null});
        notify('mcpServer/startupStatus/updated', {threadId:'thread_child', name:'child-only', status:'failed', error:'x', failureReason:null});
      }
      else if (request.method === 'turn/start') {
        if (process.env.REJECT_TURN) {
          send({jsonrpc:'2.0', id:request.id, error:{code:-32602, message:'invalid input'}});
        } else if (process.env.COMPACTING_TURN) {
          // Codex 0.159's reply to input during a compaction turn.
          send({jsonrpc:'2.0', id:request.id, error:{code:-32603, message:'failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }'}});
        } else {
          items.push({turnId:'turn_test',item:{type:'userMessage',id:'user_test',clientId:request.params.clientUserMessageId ?? null,content:request.params.input}});
          if (process.env.HANG_TURN_RESPONSE) {
            // Accepted natively but the reply never arrives; the socket stays up.
          } else {
            items.push({turnId:'turn_test',item:{type:'agentMessage',id:'agent_test',text:'Native Codex reply'}});
            items.push({turnId:'turn_test',item:{type:'agentMessage',id:'turn_echo',text:JSON.stringify(request.params)}});
            send({jsonrpc:'2.0', id:request.id, result:{turn:{id:'turn_test'}}});
            notify('turn/started', {threadId:'thread_test', turn:{id:'turn_test', status:'inProgress', items:[]}});
            notify('item/started', {threadId:'thread_test', turnId:'turn_test', item:{type:'agentMessage', id:'agent_stream', text:''}, startedAtMs: 1});
            notify('item/agentMessage/delta', {threadId:'thread_test', turnId:'turn_test', itemId:'agent_stream', delta:'Streamed '});
            notify('item/agentMessage/delta', {threadId:'thread_test', turnId:'turn_test', itemId:'agent_stream', delta:'reply'});
            notify('item/started', {threadId:'thread_test', turnId:'turn_test', item:{type:'reasoning', id:'reasoning_stream', summary:[]}, startedAtMs: 2});
            notify('item/reasoning/summaryTextDelta', {threadId:'thread_test', turnId:'turn_test', itemId:'reasoning_stream', summaryIndex:0, delta:'Thinking'});
            notify('item/completed', {threadId:'thread_test', turnId:'turn_test', item:{type:'agentMessage', id:'agent_stream', text:'Streamed reply'}, completedAtMs: 3});
            items.push({turnId:'turn_test',item:{type:'agentMessage',id:'agent_stream',text:'Streamed reply'},startedAtMs:1,completedAtMs:3});
            notify('item/started', {threadId:'thread_test', turnId:'turn_test', item:{type:'commandExecution', id:'command_stream', command:'echo test', aggregatedOutput:''}, startedAtMs: 4});
            notify('item/commandExecution/outputDelta', {threadId:'thread_test', turnId:'turn_test', itemId:'command_stream', delta:'output line\\n'});
            notify('item/completed', {threadId:'thread_test', turnId:'turn_test', item:{type:'commandExecution', id:'command_stream', command:'echo test', aggregatedOutput:'output line\\n', status:'completed', exitCode:0, durationMs:5}, completedAtMs: 5});
            items.push({turnId:'turn_test',item:{type:'reasoning',id:'reasoning_stream',summary:['Thinking'],content:[]}});
            items.push({turnId:'turn_test',item:{type:'commandExecution',id:'command_stream',command:'echo test',aggregatedOutput:'output line\\n',status:'completed',exitCode:0,durationMs:5}});
            notify('item/started', {threadId:'thread_test', turnId:'turn_test', item:{type:'fileChange', id:'patch_stream', changes:[], status:'inProgress'}, startedAtMs: 6});
            notify('item/fileChange/patchUpdated', {threadId:'thread_test', turnId:'turn_test', itemId:'patch_stream', changes:[{path:'src/app.ts', kind:'update', diff:'+added'}]});
            notify('item/completed', {threadId:'thread_test', turnId:'turn_test', item:{type:'fileChange', id:'patch_stream', changes:[{path:'src/app.ts', kind:'update', diff:'+added'}], status:'completed'}, completedAtMs: 7});
            items.push({turnId:'turn_test',item:{type:'fileChange',id:'patch_stream',changes:[{path:'src/app.ts',kind:'update',diff:'+added'}],status:'completed'}});
            notify('item/started', {threadId:'thread_test', turnId:'turn_test', item:{type:'mcpToolCall', id:'mcp_stream', server:'patterm', tool:'project.status', status:'inProgress', arguments:{}}, startedAtMs: 8});
            notify('item/completed', {threadId:'thread_test', turnId:'turn_test', item:{type:'mcpToolCall', id:'mcp_stream', server:'patterm', tool:'project.status', status:'completed', arguments:{}, result:{content:[{type:'text',text:'ok'}]}, error:null, durationMs:12}, completedAtMs: 9});
            items.push({turnId:'turn_test',item:{type:'mcpToolCall',id:'mcp_stream',server:'patterm',tool:'project.status',status:'completed',arguments:{},result:{content:[{type:'text',text:'ok'}]},error:null,durationMs:12}});
            notify('item/started', {threadId:'thread_test', turnId:'turn_test', item:{type:'contextCompaction', id:'compact_stream'}, startedAtMs: 10});
            notify('item/completed', {threadId:'thread_test', turnId:'turn_test', item:{type:'contextCompaction', id:'compact_stream'}, completedAtMs: 11});
            items.push({turnId:'turn_test',item:{type:'contextCompaction',id:'compact_stream'}});
            notify('thread/status/changed', {threadId:'thread_test', status:{type:'active'}});
            notify('turn/completed', {threadId:'thread_test', turn:{id:'turn_test', status:'completed', items:[]}});
            notify('thread/status/changed', {threadId:'thread_test', status:{type:'idle'}});
            if (process.env.SUBAGENT_THREADS) {
              const spawn = {type:'collabAgentToolCall',id:'spawn_1',tool:'spawnAgent',status:'completed',senderThreadId:'thread_test',receiverThreadIds:['thread_child'],prompt:'Explore the repo',model:'gpt-test',reasoningEffort:null,agentsStates:{thread_child:{status:'running',message:null}}};
              notify('item/completed', {threadId:'thread_test', turnId:'turn_test', item:spawn, completedAtMs: 30});
              items.push({turnId:'turn_test',item:spawn});
              notify('thread/tokenUsage/updated', {threadId:'thread_test', turnId:'turn_test', tokenUsage:{total:{totalTokens:52000,inputTokens:50000,cachedInputTokens:40000,cacheWriteInputTokens:0,outputTokens:2000,reasoningOutputTokens:500},last:{totalTokens:21000,inputTokens:20000,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:1000,reasoningOutputTokens:0},modelContextWindow:272000}});
              notify('thread/tokenUsage/updated', {threadId:'thread_child', turnId:'turn_child', tokenUsage:{total:{totalTokens:1,inputTokens:1,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:0,reasoningOutputTokens:0},last:{totalTokens:1,inputTokens:1,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:0,reasoningOutputTokens:0},modelContextWindow:1}});
              notify('account/rateLimits/updated', {rateLimits:{limitId:null,limitName:null,normalModelSlug:null,primary:{usedPercent:37,windowDurationMins:300,resetsAt:1790000000},secondary:null,credits:null,individualLimit:null,spendControlReached:null,planType:null,rateLimitReachedType:null}});
              notify('turn/started', {threadId:'thread_child', turn:{id:'turn_child', status:'inProgress', items:[]}});
              notify('item/started', {threadId:'thread_child', turnId:'turn_child', item:{type:'agentMessage', id:'child_msg', text:''}, startedAtMs: 31});
              notify('item/agentMessage/delta', {threadId:'thread_child', turnId:'turn_child', itemId:'child_msg', delta:'Child says hi'});
              notify('turn/completed', {threadId:'thread_child', turn:{id:'turn_child', status:'completed', items:[]}});
              childItems.push({turnId:'turn_child',item:{type:'agentMessage',id:'child_msg',text:'Child says hi'}});
              notify('item/started', {threadId:'thread_unrelated', turnId:'t', item:{type:'agentMessage', id:'stray', text:'not ours'}, startedAtMs: 32});
              notify('error', {threadId:'thread_test', turnId:'turn_test', willRetry:true, error:{message:'Stream disconnected',codexErrorInfo:null,additionalDetails:null,misalignment:null}});
              notify('configWarning', {summary:'Unknown key in config.toml', details:'model_foo', path:'/home/u/.codex/config.toml'});
              notify('model/rerouted', {threadId:'thread_test', turnId:'turn_test', fromModel:'gpt-test', toModel:'gpt-mini', reason:'highRiskCyberActivity'});
            }
            if (process.env.CHILD_REQUESTS) {
              send({jsonrpc:'2.0', id:'child_approval', method:'item/commandExecution/requestApproval', params:{threadId:'thread_child',turnId:'turn_child',itemId:'item_child',command:'rm -rf build',cwd:'/work',reason:'Clean the build'}});
              send({jsonrpc:'2.0', id:'patch_approval', method:'item/fileChange/requestApproval', params:{threadId:'thread_test',turnId:'turn_test',itemId:'patch_stream',reason:'Needs write access',startedAtMs:1}});
              send({jsonrpc:'2.0', id:'elicit_form', method:'mcpServer/elicitation/request', params:{threadId:'thread_child',turnId:null,serverName:'linear',mode:'form',_meta:null,message:'Pick a team',requestedSchema:{type:'object',required:['team'],properties:{team:{type:'string',title:'Team',oneOf:[{const:'eng',title:'Engineering'},{const:'ops',title:'Operations'}]},count:{type:'integer',minimum:1},notify:{type:'boolean',default:true},labels:{type:'array',items:{type:'string',enum:['bug','feature']}}}}}});
              send({jsonrpc:'2.0', id:'elicit_url', method:'mcpServer/elicitation/request', params:{threadId:'thread_test',turnId:null,serverName:'github',mode:'url',_meta:null,message:'Authorise GitHub',url:'https://github.com/login/device',elicitationId:'e1'}});
              send({jsonrpc:'2.0', id:'dynamic_tool', method:'item/tool/call', params:{threadId:'thread_test',turnId:'turn_test',callId:'c1',tool:'custom',arguments:{}}});
            }
            if (!process.env.NO_PENDING) {
              send({jsonrpc:'2.0', id:'approval_test', method:'item/commandExecution/requestApproval', params:{threadId:'thread_test',turnId:'turn_test',itemId:'item_test',command:'echo test',reason:'Run command'}});
              send({jsonrpc:'2.0', id:'question_test', method:'item/tool/requestUserInput', params:{threadId:'thread_test',turnId:'turn_test',itemId:'item_test',questions:[
                {id:'q_colour',header:'Colour',question:'Which colour?',isOther:true,options:[{label:'Red',description:'Warm'}]},
                {id:'q_other',header:'Other',question:'Anything else?',isOther:true,options:[]}
              ]}});
            }
          }
        }
      } else if (request.method === 'thread/items/list') {
        if (process.env.UNSUPPORTED_ITEMS || process.env.UNMATERIALIZED) {
          send({jsonrpc:'2.0', id:request.id, error:{code:-32601, message:'thread/items/list is not supported yet'}});
          return;
        }
        itemsListCalls += 1;
        if (process.env.SEED_STREAM && itemsListCalls === 1) {
          // The native read sees a partial row while deltas (and sometimes the
          // completed text) arrive before its response; the seed merge must not
          // double or lose them.
          items.push({turnId:'turn_test',item:{type:'agentMessage',id:'seed_stream',text:'Seed '}});
          notify('item/started', {threadId:'thread_test', turnId:'turn_test', item:{type:'agentMessage', id:'seed_stream', text:''}, startedAtMs: 20});
          notify('item/agentMessage/delta', {threadId:'thread_test', turnId:'turn_test', itemId:'seed_stream', delta:'Seed '});
          notify('item/agentMessage/delta', {threadId:'thread_test', turnId:'turn_test', itemId:'seed_stream', delta:'text'});
          if (!process.env.SEED_NO_COMPLETION) notify('item/completed', {threadId:'thread_test', turnId:'turn_test', item:{type:'agentMessage', id:'seed_stream', text:'Seed text'}, completedAtMs: 21});
        }
        if (request.params.threadId === 'thread_child') {
          send({jsonrpc:'2.0', id:request.id, result:{data:[...childItems].reverse(),nextCursor:null,backwardsCursor:null}});
          return;
        }
        if (request.params.threadId === 'thread_native') {
          // Codex 0.159 returns a string cursor holding JSON and rejects it
          // parsed back into an object.
          if (request.params.cursor && typeof request.params.cursor === 'object') {
            send({jsonrpc:'2.0', id:request.id, error:{code:-32600, message:'Invalid request: data did not match any variant of untagged enum ThreadItemsListCursor'}});
            return;
          }
          const skip = request.params.cursor ? JSON.parse(request.params.cursor).skip : 0;
          const data = nativeItems.slice(0, nativeItems.length - skip).slice(-request.params.limit).reverse();
          send({jsonrpc:'2.0', id:request.id, result:{data,nextCursor:skip + data.length < nativeItems.length ? JSON.stringify({skip: skip + data.length}) : null,backwardsCursor:null}});
          return;
        }
        const base = process.env.MANY_ITEMS
          ? [...items, ...Array.from({length:250},(_,index)=>({turnId:'turn_test',item:{type:'agentMessage',id:'history_' + index,text:'history ' + index}}))]
          : items;
        const selected = process.env.DELAY_ITEMS && itemsListCalls === 1 ? [] : base;
        const limit = typeof request.params.limit === 'number' ? request.params.limit : selected.length;
        // Like Codex, a descending read returns an opaque object cursor that
        // continues past the rows already returned.
        const skip = request.params.cursor && typeof request.params.cursor === 'object' ? request.params.cursor.skip : 0;
        const descending = request.params.sortDirection === 'desc';
        const data = descending ? selected.slice(0, selected.length - skip).slice(-limit).reverse() : selected.slice(0, limit);
        // STALE_REFRESH names the listing a cursor came from, and slows later
        // listings so concurrent snapshot readers overlap a cursor refresh.
        const nextCursor = descending && skip + data.length < selected.length ? {skip: skip + data.length, ...(process.env.STALE_REFRESH ? {call: itemsListCalls} : {})} : null;
        const reply = {jsonrpc:'2.0', id:request.id, result:{data,nextCursor,backwardsCursor:null}};
        if (process.env.STALE_REFRESH && itemsListCalls > 1) setTimeout(() => send(reply), 150);
        else if (process.env.SEED_STREAM && itemsListCalls === 1) {
          setTimeout(() => {
            send(reply);
            if (process.env.SEED_LIVE_DELTA) notify('item/agentMessage/delta', {threadId:'thread_test', turnId:'turn_test', itemId:'seed_stream', delta:'!'});
          }, 20);
        } else send(reply);
      }
      else if (request.method === 'thread/turns/list') {
        if (process.env.THREAD_READ_FAIL) send({jsonrpc:'2.0', id:request.id, error:{code:-32603, message:'status unavailable'}});
        else if (process.env.UNSUPPORTED_ITEMS) send({jsonrpc:'2.0', id:request.id, error:{code:-32601, message:'thread/turns/list is not supported yet'}});
        // Codex 0.158 before a new thread's first message.
        else if (process.env.UNMATERIALIZED) send({jsonrpc:'2.0', id:request.id, error:{code:-32600, message:'thread thread_test is not materialized yet; thread/turns/list is unavailable before first user message'}});
        else if (process.env.RECONNECT_ACTIVE) send({jsonrpc:'2.0', id:request.id, result:{data:[{id:'turn_live',status:'inProgress',items:[],itemsView:'notLoaded'}],nextCursor:null,backwardsCursor:null}});
        else if (process.env.COMMANDS) send({jsonrpc:'2.0', id:request.id, result:{data:[{id:'turn_done',status:'completed',items:[],itemsView:'notLoaded'}],nextCursor:null,backwardsCursor:null}});
        else send({jsonrpc:'2.0', id:request.id, result:{data:[],nextCursor:null,backwardsCursor:null}});
      }
      else if (request.method === 'thread/read') {
        if (process.env.THREAD_READ_FAIL) send({jsonrpc:'2.0', id:request.id, error:{code:-32603, message:'status unavailable'}});
        else if (process.env.UNSUPPORTED_ITEMS && request.params.includeTurns) send({jsonrpc:'2.0', id:request.id, error:{code:-32601, message:'list_turns is not supported yet'}});
        else if (process.env.UNSUPPORTED_ITEMS) send({jsonrpc:'2.0', id:request.id, result:{thread:{turns:[],status:{type:'idle'}}}});
        else if (process.env.RECONNECT_ACTIVE) send({jsonrpc:'2.0', id:request.id, result:{thread:{turns:[{id:'turn_live',status:'inProgress',items:[]}]}}});
        else if (request.params.threadId === 'thread_child' || request.params.threadId === 'thread_native') send({jsonrpc:'2.0', id:request.id, result:{thread:{id:request.params.threadId,parentThreadId:'thread_test',turns:[]}}});
        else send({jsonrpc:'2.0', id:request.id, result:{thread:{turns:[]}}});
      }
      else if (request.method === 'turn/interrupt') send({jsonrpc:'2.0', id:request.id, result:{}});
      // GPT-Live voice: the answer arrives as a notification after the start reply.
      else if (request.method === 'thread/realtime/start') {
        send({jsonrpc:'2.0', id:request.id, result:{}});
        const threadId = request.params.threadId;
        if (request.params.transport.sdp === 'bad-offer') notify('thread/realtime/error', {threadId, message:JSON.stringify({error:{message:'AVAS requires OpenAI-Alpha: quicksilver=v2.'}})});
        else {
          const { threadId: _thread, transport: _transport, version, voice, outputModality, includeStartupContext: _context, ...profile } = request.params;
          notify('thread/realtime/sdp', {threadId, sdp:'answer:' + JSON.stringify({version, voice:voice ?? null, modality:outputModality, ...profile})});
          notify('thread/realtime/started', {threadId, realtimeSessionId:threadId, version:'v3'});
        }
      }
      else if (request.method === 'thread/realtime/appendText') {
        send({jsonrpc:'2.0', id:request.id, result:{}});
        notify('thread/realtime/transcript/done', {threadId:request.params.threadId, role:'assistant', text:'heard ' + request.params.text});
      }
      else if (request.method === 'thread/realtime/stop') {
        send({jsonrpc:'2.0', id:request.id, result:{}});
        notify('thread/realtime/closed', {threadId:request.params.threadId});
      }
      else if (request.method === 'thread/backgroundTerminals/list') {
        // A new row that trims the full live window, leaving its cursor stale.
        if (process.env.STALE_REFRESH && !fs.existsSync(socketPath + '.staled')) {
          fs.writeFileSync(socketPath + '.staled', '1');
          items.push({turnId:'turn_test',item:{type:'agentMessage',id:'fresh_1',text:'Fresh'}});
          notify('item/completed', {threadId:'thread_test', turnId:'turn_test', item:{type:'agentMessage', id:'fresh_1', text:'Fresh'}, completedAtMs: 50});
        }
        // A row that completes while the snapshot awaits this lookup.
        const running = process.env.NATIVE_TASKS && !fs.existsSync(socketPath + '.terminated');
        const reply = () => send({jsonrpc:'2.0', id:request.id, result:{data:running ? [{itemId:'exec_bg',processId:'77',command:'ping -c 120 127.0.0.1',cwd:'/tmp'}] : [],nextCursor:null}});
        if (process.env.TERMINAL_RACE && !fs.existsSync(socketPath + '.raced')) {
          fs.writeFileSync(socketPath + '.raced', '1');
          notify('item/completed', {threadId:'thread_test', turnId:'turn_test', item:{type:'agentMessage', id:'race_item', text:'Arrived meanwhile'}, completedAtMs: 40});
          setTimeout(reply, 150);
        } else reply();
      }
      else if (request.method === 'thread/backgroundTerminals/terminate') {
        fs.writeFileSync(socketPath + '.terminated', JSON.stringify(request.params));
        send({jsonrpc:'2.0', id:request.id, result:{}});
      }
      else if (request.method === 'thread/compact/start' || request.method === 'review/start' || request.method === 'thread/name/set' || request.method === 'thread/goal/set' || request.method === 'thread/shellCommand' || request.method === 'thread/revert') {
        if (request.method !== 'thread/compact/start') items.push({turnId:'turn_test',item:{type:'agentMessage',id:'command_' + request.method.replace(/\\//g, '_') + '_' + request.id,text:JSON.stringify(request.params)}});
        send({jsonrpc:'2.0', id:request.id, result:{}});
      }
  });
});
server.listen(socketPath);
`, { mode: 0o700 });

  const database = new DatabaseService(directory);
  try {
    database.initialize();
  const now = new Date().toISOString();
  database.connection.prepare('insert into projects (id,name,path,created_at,updated_at) values (?,?,?,?,?)').run('project_test', 'Test', directory, now, now);
  const runtimeDirectory = path.join(directory, 'runtime');
  const argvPath = path.join(directory, 'codex-argv.json');
  process.env.CODEX_ARGV_FILE = argvPath;
  const service = new CodexAppServerService(database, runtimeDirectory);
  const prepared = await service.prepare({
    executable,
    cwd: directory,
    name: 'Codex',
    context: 'Project context',
    mcp: { command: process.execPath, args: ['shim.js'], env: { PATTERM_MCP_SOCKET: '/tmp/mcp.sock', PATTERM_MCP_IDENTITY: 'identity_test' } },
    resumeId: null,
    model: 'gpt-test', reasoning: 'high', serviceTier: 'priority'
  });
  assert.equal(prepared.resumeId, 'thread_test');
  const nativeArgs = JSON.parse(fs.readFileSync(argvPath, 'utf8')) as string[];
  assert.ok(nativeArgs.includes('model="gpt-test"'), 'Integrated Codex pins the selected model before app-server');
  assert.ok(nativeArgs.includes('model_reasoning_effort="high"'), 'Integrated Codex pins the selected effort before app-server');
  assert.ok(nativeArgs.includes('service_tier="priority"'), 'Integrated Codex pins the selected service tier before app-server');
  database.connection.prepare(`insert into processes (id,project_id,kind,name,status,cwd,argv,created_at,updated_at) values ('process_test','project_test','agent','Codex','running',?,?,?,?)`)
    .run(directory, JSON.stringify(prepared.argv), now, now);
  database.connection.prepare(`insert into sessions (id,project_id,process_id,harness,interface_mode,mcp_identity,resume_id,started_at,session_role,resume_status,created_by_actor,model,reasoning,service_tier) values ('session_test','project_test','process_test','codex','integrated','identity_test',?,'${now}','orchestrator','found','user','gpt-test','high','priority')`)
    .run(prepared.resumeId);

  const activityChanges: string[] = [];
  const integrated = new IntegratedAgentService(database, { codex: service }, () => activityChanges.push('changed'));
  assert.equal((await integrated.controls('process_test')).selectors[0]?.value, 'gpt-test');
  assert.equal((await integrated.controls('process_test')).selectors.find((item) => item.id === 'effort')?.value, 'high', 'composer shows the launch preset before any live configuration');
  assert.deepEqual((await integrated.controls('process_test')).selectors.find((item) => item.id === 'effort')?.options.map((item) => item.value), ['low', 'medium', 'high']);
  const speed = async () => (await integrated.controls('process_test')).selectors.find((item) => item.id === 'speed');
  assert.deepEqual((await speed())?.options, [{ value: 'default', label: 'Standard' }, { value: 'priority', label: 'Fast' }]);
  assert.equal((await speed())?.value, 'priority', 'composer shows the launch preset speed over the CLI config');
  await integrated.command('process_test', 'fast', '');
  assert.equal((await speed())?.value, 'default', '/fast toggles Fast mode off');
  await integrated.command('process_test', 'fast', 'on');
  assert.equal((await speed())?.value, 'priority');
  await assert.rejects(integrated.command('process_test', 'fast', 'maybe'), /\/fast on/);
  await assert.rejects(integrated.configure('process_test', 'speed', 'flex'), /Unknown Codex speed/);
  await integrated.configure('process_test', 'model', 'gpt-test');
  await integrated.configure('process_test', 'effort', 'high');
  await integrated.command('process_test', 'compact', '');
  await integrated.command('process_test', 'review', 'Focus on correctness');
  assert.equal((await integrated.prompt('process_test', 'Hello') as { turnId: string }).turnId, 'turn_test');
  assert.equal((database.connection.prepare(`select activity from processes where id = 'process_test'`).get() as { activity: string }).activity, 'working');
  assert.deepEqual(activityChanges, ['changed'], 'prompt notifies the idle -> working transition');
  const first = JSON.stringify(await integrated.conversation('process_test'));
  assert.match(first, /Native Codex reply/);
  assert.match(first, /\\"serviceTier\\":\\"priority\\"/, 'the chosen speed rides on turn/start');
  assert.match(first, /\\"collaborationMode\\":\{\\"mode\\":\\"default\\",\\"settings\\":\{\\"model\\":\\"gpt-test\\"/, 'every turn names its collaboration mode with a model, as the TUI does');
  assert.equal((await integrated.controls('process_test')).selectors.find((item) => item.id === 'mode')?.value, 'default');
  await assert.rejects(integrated.configure('process_test', 'mode', 'pair'), /Unknown Codex mode/);
  await integrated.configure('process_test', 'mode', 'plan');
  assert.equal((await integrated.controls('process_test')).selectors.find((item) => item.id === 'mode')?.value, 'plan');
  await integrated.configure('process_test', 'mode', 'default');
  assert.match(first, /approval_test/);
  assert.match(first, /question_test/);
  assert.equal((database.connection.prepare(`select activity from processes where id = 'process_test'`).get() as { activity: string }).activity, 'permission');
  assert.deepEqual(activityChanges, ['changed', 'changed']);
  await integrated.conversation('process_test');
  assert.deepEqual(activityChanges, ['changed', 'changed'], 'unchanged activity does not notify');
  const pendingQuestions = (JSON.parse(first) as { questions: { data: Array<{ id: string; questions: Array<Record<string, unknown>> }> } }).questions.data[0]!;
  assert.equal(pendingQuestions.id, 'question_test');
  assert.deepEqual(
    pendingQuestions.questions.map((question) => [question.id, question.multiple, question.custom, question.header]),
    [['q_colour', false, true, 'Colour'], ['q_other', false, true, 'Other']],
    'Codex questions keep ids, isOther and native order'
  );
  assert.deepEqual(pendingQuestions.questions[0]?.options, [{ label: 'Red', description: 'Warm' }]);
  await assert.rejects(integrated.replyQuestion('process_test', 'question_test', [['Red']]), /one answer for every question/);
  await integrated.replyQuestion('process_test', 'question_test', [['Red'], ['anything']]);

  // Structured input: filesystem references and non-image attachments ride in
  // the text as native path text, images stay localImage items, and
  // clientUserMessageId is correlation only.
  const sourceFile = path.join(directory, 'source.ts');
  fs.writeFileSync(sourceFile, 'export const answer = 42;');
  const spacedDirectory = path.join(directory, 'src dir');
  fs.mkdirSync(spacedDirectory, { recursive: true });
  const spacedFile = path.join(spacedDirectory, 'source file.ts');
  fs.writeFileSync(spacedFile, 'export const spaced = true;');
  const imageBytes = Buffer.from('89504e470d0a1a0a', 'hex');
  const imageFile = path.join(directory, 'pixel.png');
  fs.writeFileSync(imageFile, imageBytes);
  const documentFile = path.join(directory, 'doc.pdf');
  fs.writeFileSync(documentFile, '%PDF');
  const clientUserMessageId = '33333333-3333-3333-3333-333333333333';
  await service.prompt('process_test', {
    text: 'Look @source.ts',
    references: [
      { path: sourceFile, name: 'source.ts', relativePath: 'source.ts' },
      { path: spacedFile, name: 'source file.ts', relativePath: 'src dir/source file.ts' }
    ],
    attachments: [
      { path: imageFile, name: 'pixel.png', mime: 'image/png', size: imageBytes.length },
      { path: documentFile, name: 'doc.pdf', mime: 'application/pdf', size: 4 }
    ],
    messageId: clientUserMessageId
  });
  const structured = JSON.parse(JSON.stringify(await service.conversation('process_test'))) as { messages: { data: Array<{ id: string; text: string }> } };
  // Every turn emits an echo; the structured one is the newest.
  const turnEcho = JSON.parse(structured.messages.data.filter((message) => message.id === 'turn_echo').at(-1)!.text) as {
    input: Array<Record<string, unknown>>;
    clientUserMessageId?: string;
    effort?: string;
  };
  assert.equal(turnEcho.clientUserMessageId, clientUserMessageId);
  assert.equal(turnEcho.effort, 'high');
  assert.deepEqual(turnEcho.input, [
    { type: 'text', text: `Look source.ts "src dir/source file.ts" ${documentFile}`, text_elements: [] },
    { type: 'localImage', path: imageFile }
  ], 'filesystem references become native path text and images stay localImage items');
  const presetRestoredService = new CodexAppServerService(database, runtimeDirectory);
  await presetRestoredService.prompt('process_test', { text: 'After service restart', references: [], attachments: [] });
  const restoredConversation = JSON.parse(JSON.stringify(await presetRestoredService.conversation('process_test'))) as { messages: { data: Array<{ id: string; text: string }> } };
  const restoredTurn = JSON.parse(restoredConversation.messages.data.filter((message) => message.id === 'turn_echo').at(-1)!.text) as { model?: string; effort?: string };
  assert.equal(restoredTurn.model, 'gpt-test', 'a new bridge instance retains the session launch model');
  assert.equal(restoredTurn.effort, 'high', 'a new bridge instance retains the session launch reasoning');
  presetRestoredService.disconnect();
  assert.ok(!turnEcho.input.some((item) => item.type === 'mention'), 'filesystem paths never use app/plugin mention items');
  // Voice: the browser's offer is answered through the thread, and realtime
  // notifications reach only that thread's listeners.
  const realtimeEvents: string[] = [];
  const releaseRealtime = service.onRealtime('process_test', (event) => realtimeEvents.push(`${event.method}:${String(event.params.text ?? '')}`));
  const voiceAnswer = await service.realtimeStart('process_test', { sdp: 'offer', voice: 'maple' });
  assert.equal(voiceAnswer.sdp, 'answer:{"version":"v3","voice":"maple","modality":"audio"}', 'no profile options sends only the base parameters');
  // Voice profile options reach thread/realtime/start as given.
  const profiled = await service.realtimeStart('process_test', { sdp: 'offer', options: { prompt: 'Voice rules', delegationAckFiller: false, backendReasoningStatus: true } });
  assert.equal(profiled.sdp, 'answer:{"version":"v3","voice":null,"modality":"audio","prompt":"Voice rules","delegationAckFiller":false,"backendReasoningStatus":true}');
  // A brief reaches it as initial items; an empty list is left out.
  const briefed = await service.realtimeStart('process_test', { sdp: 'offer', initialItems: [{ role: 'developer', text: 'Earlier' }] });
  assert.equal(briefed.sdp, 'answer:{"version":"v3","voice":null,"modality":"audio","initialItems":[{"role":"developer","text":"Earlier"}]}');
  assert.equal((await service.realtimeStart('process_test', { sdp: 'offer', initialItems: [] })).sdp, 'answer:{"version":"v3","voice":null,"modality":"audio"}');
  await assert.rejects(service.realtimeStart('process_test', { sdp: 'bad-offer' }), /AVAS requires OpenAI-Alpha/, 'an upstream error rejects with its message');
  await service.realtimeAppendText('process_test', 'a notification');
  await service.realtimeStop('process_test');
  const realtimeDeadline = Date.now() + 2_000;
  while (!realtimeEvents.includes('thread/realtime/closed:') && Date.now() < realtimeDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(realtimeEvents.includes('thread/realtime/started:'));
  assert.ok(realtimeEvents.includes('thread/realtime/transcript/done:heard a notification'));
  assert.ok(realtimeEvents.includes('thread/realtime/closed:'));
  releaseRealtime();
  service.disconnect();
  const reconnected = new CodexAppServerService(database, runtimeDirectory);
  const afterRestart = JSON.stringify(await reconnected.conversation('process_test'));
  assert.match(afterRestart, /Native Codex reply/);
  assert.match(afterRestart, /approval_test/, 'pending approval survives a Patterm client restart');
  await reconnected.replyPermission('process_test', 'approval_test', 'once');
  reconnected.disconnect();
  const restartedCodex = new CodexAppServerService(database, runtimeDirectory);
  const restartedAgents = new IntegratedAgentService(database, { codex: restartedCodex });
  assert.deepEqual(await restartedAgents.reconcile(), { checked: 1, failed: 0, unreachable: 0 }, 'a restarted server reattaches to a live Codex host');
  await new Promise((resolve) => setTimeout(resolve, 300));
  restartedAgents.dispose();
  restartedCodex.disconnect();
  const unreadable = Object.assign(Object.create(reconnected) as CodexAppServerService, { conversation: async () => { throw new Error('read failed'); } });
  const unreadableAgents = new IntegratedAgentService(database, { codex: unreadable });
  assert.deepEqual(await unreadableAgents.reconcile(), { checked: 1, failed: 0, unreachable: 1 }, 'a live host is never marked failed');
  await new Promise((resolve) => setTimeout(resolve, 300));
  unreadableAgents.dispose();
  assert.equal((database.connection.prepare(`select status from processes where id = 'process_test'`).get() as { status: string }).status, 'running');
  await reconnected.stop('process_test');
  const reconciliation = await new IntegratedAgentService(database, { codex: new CodexAppServerService(database, runtimeDirectory) }).reconcile();
  assert.deepEqual(reconciliation, { checked: 1, failed: 1, unreachable: 0 });
  assert.equal((database.connection.prepare(`select status from processes where id = 'process_test'`).get() as { status: string }).status, 'failed');

  // Ambiguous, delayed, and definitive delivery evidence on fresh sessions.
  let launchCount = 0;
  const launch = async (mode: NodeJS.ProcessEnv) => {
    launchCount += 1;
    const scoped = new CodexAppServerService(database, runtimeDirectory, mode, process.execPath, undefined, { requestTimeoutMs: 250 });
    const launched = await scoped.prepare({
      executable,
      cwd: directory,
      name: 'Codex',
      context: 'Project context',
      mcp: { command: process.execPath, args: ['shim.js'], env: { PATTERM_MCP_SOCKET: '/tmp/mcp.sock', PATTERM_MCP_IDENTITY: 'identity_test' } },
      resumeId: null
    });
    const processId = `process_delivery_${launchCount}`;
    database.connection.prepare(`insert into processes (id,project_id,kind,name,status,cwd,argv,created_at,updated_at) values (?, 'project_test','agent','Codex','running',?,?,?,?)`)
      .run(processId, directory, JSON.stringify(launched.argv), now, now);
    database.connection.prepare(`insert into sessions (id,project_id,process_id,harness,interface_mode,mcp_identity,resume_id,started_at,session_role,resume_status,created_by_actor) values (?, 'project_test', ?, 'codex','integrated',?,?, ?, 'orchestrator','found','user')`)
      .run(`session_delivery_${launchCount}`, processId, `identity_delivery_${launchCount}`, launched.resumeId, now);
    return { service: scoped, processId };
  };

  const lost = await launch({ ...process.env, HANG_TURN_RESPONSE: '1' });
  const lostId = '55555555-5555-5555-5555-555555555555';
  await assert.rejects(
    lost.service.prompt(lost.processId, { text: 'lost turn', references: [], attachments: [], messageId: lostId }),
    UncertainDeliveryError
  );
  assert.equal(await lost.service.reconcile(lost.processId, lostId), 'accepted', 'the native clientId proves admission');

  const delayed = await launch({ ...process.env, HANG_TURN_RESPONSE: '1', DELAY_ITEMS: '1' });
  const delayedId = '66666666-6666-6666-6666-666666666666';
  await assert.rejects(
    delayed.service.prompt(delayed.processId, { text: 'delayed', references: [], attachments: [], messageId: delayedId }),
    UncertainDeliveryError
  );
  assert.equal(await delayed.service.reconcile(delayed.processId, delayedId), 'unknown', 'absence from one bounded read is not rejection');
  assert.equal(await delayed.service.reconcile(delayed.processId, delayedId), 'accepted', 'a later read establishes admission');

  const rejected = await launch({ ...process.env, REJECT_TURN: '1' });
  const rejectedId = '77777777-7777-7777-7777-777777777777';
  await assert.rejects(
    rejected.service.prompt(rejected.processId, { text: 'rejected', references: [], attachments: [], messageId: rejectedId }),
    (error: unknown) => error instanceof Error && !(error instanceof UncertainDeliveryError) && /invalid input/.test(error.message),
    'a JSON-RPC error is a definitive rejection'
  );
  assert.equal(await rejected.service.reconcile(rejected.processId, rejectedId), 'unknown');

  // Input during compaction is a definitive rejection Patterm can hold.
  const compacting = await launch({ ...process.env, COMPACTING_TURN: '1' });
  await assert.rejects(
    compacting.service.prompt(compacting.processId, { text: 'during compaction', references: [], attachments: [], messageId: '88888888-8888-8888-8888-888888888888' }),
    (error: unknown) => error instanceof TurnBusyError && error.turnKind === 'compact',
    'a compaction turn rejects input as busy'
  );

  // MCP servers that fail to start are reported once per agent, including
  // failures that arrived before the agent was observed.
  {
    const failing = await launch({ ...process.env, MCP_FAILURE: '1' });
    const failures: Array<{ processId: string; server: string; error: string }> = [];
    failing.service.onMcpStartupFailure((processId, failure) => failures.push({ processId, ...failure }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(failures.length, 0, 'nothing is reported before the agent is observed');
    const release = await failing.service.subscribe(failing.processId, () => {});
    assert.deepEqual(failures, [{ processId: failing.processId, server: 'linear', error: 'The linear MCP server is not logged in.' }], 'an early failure is reported once the agent is observed');
    await failing.service.prompt(failing.processId, { text: 'retry', references: [], attachments: [] });
    await waitFor(() => failures.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(failures.map((failure) => failure.server), ['linear', 'there'], 'a retried failure is not reported again, and subagent threads are ignored');
    release();
    await failing.service.stop(failing.processId);
    failing.service.disconnect();
  }

  // Event-driven stream: batched revisions, stable item identities, ordered
  // deltas, authoritative completion, status and pending transitions.
  const streaming = await launch({ ...process.env });
  const streamed: IntegratedConversationEvent[] = [];
  const unsubscribe = await streaming.service.subscribe(streaming.processId, (event) => streamed.push(event));
  await streaming.service.prompt(streaming.processId, { text: 'stream me', references: [], attachments: [] });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const revisions = streamed.map((event) => event.revision);
  assert.deepEqual(revisions, [...revisions].sort((left, right) => left - right), 'stream revisions are ordered');
  assert.ok(streamed.some((event) => event.kind === 'replace' && event.message?.id === 'agent_stream'), 'item/started projects a replace');
  const deltasFor = (id: string) => streamed.filter((event) => event.kind === 'append' && event.id === id).map((event) => event.delta).join('');
  assert.equal(deltasFor('agent_stream'), 'Streamed reply', 'agent message deltas append in order');
  assert.equal(deltasFor('reasoning_stream'), 'Thinking');
  assert.equal(deltasFor('command_stream'), 'output line\n', 'tool output deltas append in order');
  assert.ok(streamed.some((event) => event.kind === 'replace' && event.message?.id === 'agent_stream' && event.message.text === 'Streamed reply'), 'completion replaces the partial text');
  assert.ok(streamed.some((event) => event.kind === 'append' && event.id === 'reasoning_stream' && event.delta === 'Thinking'));
  // Native item times: item/started gives the start, item/completed the
  // finish, and the completion replace still carries the start.
  const completedAgent = [...streamed].reverse().find((event) => event.kind === 'replace' && event.message?.id === 'agent_stream')?.message;
  assert.deepEqual([completedAgent?.createdAt, completedAgent?.completedAt], [new Date(1).toISOString(), new Date(3).toISOString()], 'Codex rows carry native item times');
  const startedReasoning = streamed.find((event) => event.kind === 'replace' && event.message?.id === 'reasoning_stream')?.message;
  assert.deepEqual([startedReasoning?.createdAt, startedReasoning?.completedAt], [new Date(2).toISOString(), undefined], 'a started item has no finish yet');
  assert.ok(streamed.some((event) => event.kind === 'status' && event.status === 'working'));
  assert.ok(streamed.some((event) => event.kind === 'status' && event.status === 'idle'));
  assert.ok(streamed.some((event) => event.kind === 'pending'), 'pending input changes are surfaced');
  assert.ok(streamed.some((event) => event.kind === 'replace' && event.message?.id === 'patch_stream' && /\+added/.test(event.message.text)), 'patch updates preserve change diffs');
  assert.ok(streamed.some((event) => event.kind === 'replace' && event.message?.id === 'compact_stream' && event.message.kind === 'notice' && event.message.text === 'Context compacted'), 'compaction is a notice, not assistant prose');

  // The subscribed snapshot is projected from the same state the events built,
  // so its boundary and its content agree while deltas keep arriving.
  const streamedSnapshot = await streaming.service.conversation(streaming.processId) as {
    messages: { data: Array<{ id: string; text: string; kind: string; title?: string; tool?: { name: string; input?: Record<string, unknown>; state?: unknown } }> };
    status: string;
    revision: number;
    history_truncated: boolean;
  };
  assert.equal(streamedSnapshot.messages.data.find((message) => message.id === 'agent_stream')?.text, 'Streamed reply', 'the snapshot matches the streamed completion without duplicating text');
  const commandMessage = streamedSnapshot.messages.data.find((message) => message.id === 'command_stream');
  assert.equal(commandMessage?.tool?.name, 'commandExecution');
  assert.deepEqual([(commandMessage as { createdAt?: string } | undefined)?.createdAt, (commandMessage as { completedAt?: string } | undefined)?.completedAt],
    [new Date(4).toISOString(), new Date(5).toISOString()], 'the snapshot keeps streamed item times');
  assert.equal(commandMessage?.tool?.state, 'completed');
  assert.equal(commandMessage?.tool?.input?.exitCode, 0);
  assert.equal(commandMessage?.tool?.input?.durationMs, 5);
  const patchMessage = streamedSnapshot.messages.data.find((message) => message.id === 'patch_stream');
  assert.match(patchMessage?.text ?? '', /src\/app\.ts/);
  assert.equal(patchMessage?.tool?.name, 'fileChange');
  assert.deepEqual(patchMessage?.tool?.input?.changes, [{ path: 'src/app.ts', kind: 'update', diff: '+added' }]);
  const mcpMessage = streamedSnapshot.messages.data.find((message) => message.id === 'mcp_stream');
  assert.equal(mcpMessage?.title, 'patterm: project.status');
  assert.match(mcpMessage?.text ?? '', /ok/);
  assert.equal(streamedSnapshot.messages.data.find((message) => message.id === 'compact_stream')?.kind, 'notice');
  assert.equal(streamedSnapshot.status, 'permission', 'pending native requests take precedence over the completed turn status');
  assert.ok(streamedSnapshot.revision >= Math.max(...revisions), 'the snapshot boundary is at least the newest delivered revision');
  assert.equal(streamedSnapshot.history_truncated, false);
  unsubscribe();

  // A row arriving while the subscribed snapshot awaits its background
  // terminal lookup is left for the next snapshot: rows, cursor, and revision
  // describe one boundary, so paging back from it skips nothing.
  const racing = await launch({ ...process.env, TERMINAL_RACE: '1' });
  const releaseRacing = await racing.service.subscribe(racing.processId, () => {});
  type RaceSnapshot = { messages: { data: Array<{ id: string }> }; revision: number };
  const beforeRace = await racing.service.conversation(racing.processId) as RaceSnapshot;
  assert.ok(!beforeRace.messages.data.some((message) => message.id === 'race_item'), 'a row arriving during the snapshot is not mixed into it');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const afterRace = await racing.service.conversation(racing.processId) as RaceSnapshot;
  assert.ok(afterRace.messages.data.some((message) => message.id === 'race_item'));
  assert.ok(afterRace.revision > beforeRace.revision, 'the next snapshot has a newer boundary');
  releaseRacing();
  await racing.service.stop(racing.processId);

  // Readers arriving while a stale cursor is refreshed wait for the same
  // refresh, so none copies the trimmed window with the old cursor.
  const stale = await launch({ ...process.env, MANY_ITEMS: '1', STALE_REFRESH: '1' });
  const releaseStale = await stale.service.subscribe(stale.processId, () => {});
  type StaleSnapshot = { messages: { data: Array<{ id: string }> }; history_cursor: { next: string } | null };
  await stale.service.conversation(stale.processId);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const [readerA, readerB] = await Promise.all([stale.service.conversation(stale.processId), stale.service.conversation(stale.processId)]) as [StaleSnapshot, StaleSnapshot];
  assert.ok(readerA.messages.data.some((message) => message.id === 'fresh_1'));
  assert.match(readerA.history_cursor?.next ?? '', /"call":2/, 'the stale cursor is refreshed');
  assert.equal(readerB.history_cursor?.next, readerA.history_cursor?.next, 'a concurrent reader waits for the same refresh');
  assert.deepEqual(readerB.messages.data.map((message) => message.id), readerA.messages.data.map((message) => message.id));
  releaseStale();
  await stale.service.stop(stale.processId);
  // Losing the subscriber never stops native execution.
  assert.equal((await streaming.service.prompt(streaming.processId, { text: 'after unsubscribe', references: [], attachments: [] })).turnId, 'turn_test');
  await streaming.service.stop(streaming.processId);
  streaming.service.disconnect();

  // Events received while the initial read is in flight are reconciled into it
  // instead of being dropped: a completion is kept exactly once, and without a
  // completion the partial snapshot plus queued deltas still produce the full
  // text with later deltas applied once.
  const seeding = await launch({ ...process.env, SEED_STREAM: '1' });
  const seedEvents: IntegratedConversationEvent[] = [];
  const releaseSeed = await seeding.service.subscribe(seeding.processId, (event) => seedEvents.push(event));
  const seeded = await seeding.service.conversation(seeding.processId) as { messages: { data: Array<{ id: string; text: string }> } };
  assert.equal(seeded.messages.data.find((message) => message.id === 'seed_stream')?.text, 'Seed text', 'the seed merge keeps the completed text exactly once');
  assert.ok(!seedEvents.some((event) => event.kind === 'append' && event.id === 'seed_stream'), 'seed-window deltas are merged rather than replayed');
  releaseSeed();
  await seeding.service.stop(seeding.processId);
  seeding.service.disconnect();

  const partial = await launch({ ...process.env, SEED_STREAM: '1', SEED_NO_COMPLETION: '1', SEED_LIVE_DELTA: '1' });
  const releasePartial = await partial.service.subscribe(partial.processId, () => {});
  // The last delta streams live, or joins the seed when it arrives in the same
  // chunk as the read's reply; either way the text is the same.
  const partialText = async () => (await partial.service.conversation(partial.processId) as { messages: { data: Array<{ id: string; text: string }> } })
    .messages.data.find((message) => message.id === 'seed_stream')?.text;
  const deadlinePartial = Date.now() + 3_000;
  while (await partialText() !== 'Seed text!' && Date.now() < deadlinePartial) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(await partialText(), 'Seed text!', 'partial text survives without a completion and future deltas apply exactly once');
  releasePartial();
  await partial.service.stop(partial.processId);
  partial.service.disconnect();

  // Codex 0.158 reports a new, empty thread with the same items-list error as
  // older builds. An empty thread is not missing history.
  const fresh = await launch({ ...process.env, UNMATERIALIZED: '1', NO_PENDING: '1' });
  const freshSnapshot = await fresh.service.conversation(fresh.processId) as { history_unavailable: boolean; messages: { data: unknown[] } };
  assert.equal(freshSnapshot.history_unavailable, false, 'a new thread does not claim this Codex version cannot load history');
  assert.deepEqual(freshSnapshot.messages.data, []);
  const releaseFresh = await fresh.service.subscribe(fresh.processId, () => {});
  const freshStreamed = await fresh.service.conversation(fresh.processId) as { history_unavailable: boolean; status: string };
  assert.equal(freshStreamed.history_unavailable, false, 'the streamed snapshot agrees');
  assert.equal(freshStreamed.status, 'idle', 'a new thread is idle, not unknown');
  releaseFresh();
  await fresh.service.stop(fresh.processId);
  fresh.service.disconnect();

  // Codex 0.156.0 accepts a native WebSocket connection and live turns but
  // advertises an items-list method that currently returns this error.
  const unsupported = await launch({ ...process.env, UNSUPPORTED_ITEMS: '1', NO_PENDING: '1' });
  const unsupportedEvents: IntegratedConversationEvent[] = [];
  const releaseUnsupported = await unsupported.service.subscribe(unsupported.processId, (event) => unsupportedEvents.push(event));
  const initialUnsupported = await unsupported.service.conversation(unsupported.processId) as { history_unavailable: boolean; status: string };
  assert.equal(initialUnsupported.history_unavailable, true);
  assert.equal(initialUnsupported.status, 'idle');
  await unsupported.service.prompt(unsupported.processId, { text: 'live despite unavailable history', references: [], attachments: [] });
  await waitFor(() => unsupportedEvents.some((event) => event.kind === 'append' && event.id === 'agent_stream'));
  const liveUnsupported = await unsupported.service.conversation(unsupported.processId) as { messages: { data: Array<{ id: string; text: string }> } };
  assert.equal(liveUnsupported.messages.data.find((message) => message.id === 'agent_stream')?.text, 'Streamed reply');
  releaseUnsupported();
  await unsupported.service.stop(unsupported.processId);
  unsupported.service.disconnect();

  // A dropped control connection is announced and recovered without any
  // explicit read, and an active native turn is not mislabelled idle.
  const reconnecting = await launch({ ...process.env, RECONNECT_ACTIVE: '1', NO_PENDING: '1' });
  const reconnectedEvents: IntegratedConversationEvent[] = [];
  const releaseReconnect = await reconnecting.service.subscribe(reconnecting.processId, (event) => reconnectedEvents.push(event));
  await reconnecting.service.prompt(reconnecting.processId, { text: 'drop me', references: [], attachments: [] });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const internalClients = reconnecting.service as unknown as { clients: Map<string, { close(): void }> };
  for (const client of internalClients.clients.values()) client.close();
  // Connection loss is delivered as soon as the client is gone, not in the
  // 40 ms batch that a reconnect would discard: idle compaction relies on it.
  await new Promise<void>((resolve) => {
    const check = () => internalClients.clients.size === 0 ? resolve() : setImmediate(check);
    check();
  });
  assert.ok(reconnectedEvents.some((event) => event.kind === 'reconnecting'), 'connection loss is delivered before any batch flush');
  await reconnecting.service.controls(reconnecting.processId);
  assert.equal(reconnectedEvents.filter((event) => event.kind === 'reconnecting').length, 1, 'a reconnect forced at once does not lose it');
  await waitFor(() => {
    const lost = reconnectedEvents.findIndex((event) => event.kind === 'reconnecting');
    return lost >= 0 && reconnectedEvents.slice(lost).some((event) => event.kind === 'pending');
  }, 5_000);
  const afterReconnect = await reconnecting.service.conversation(reconnecting.processId) as { messages: { data: Array<{ id: string; text: string; createdAt?: string; completedAt?: string }> }; status: string };
  assert.equal(afterReconnect.messages.data.find((message) => message.id === 'agent_stream')?.text, 'Streamed reply', 'the reseeded snapshot keeps streamed content');
  const listedAgent = afterReconnect.messages.data.find((message) => message.id === 'agent_stream');
  assert.deepEqual([listedAgent?.createdAt, listedAgent?.completedAt], [new Date(1).toISOString(), new Date(3).toISOString()], 'listed items keep their native times');
  assert.equal(afterReconnect.messages.data.find((message) => message.id === 'user_test')?.createdAt, undefined, 'listed items without native times stay unset');
  assert.equal(afterReconnect.status, 'working', 'an active native turn is not mislabelled idle after reconnect');
  const beforeReconnect = reconnectedEvents.length;
  await reconnecting.service.prompt(reconnecting.processId, { text: 'again', references: [], attachments: [] });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(reconnectedEvents.slice(beforeReconnect).some((event) => event.kind === 'status' && event.status === 'working'), 'events flow again after the socket reconnects');
  releaseReconnect();
  await reconnecting.service.stop(reconnecting.processId);
  reconnecting.service.disconnect();

  // Pending native requests are restored from the host on reconnect.
  const restored = await launch({ ...process.env });
  const releaseRestored = await restored.service.subscribe(restored.processId, () => {});
  await restored.service.prompt(restored.processId, { text: 'restore', references: [], attachments: [] });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const restoredClients = restored.service as unknown as { clients: Map<string, { close(): void }> };
  for (const client of restoredClients.clients.values()) client.close();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const restoredSnapshot = await restored.service.conversation(restored.processId) as { permissions: { data: Array<{ id: string }> }; status: string };
  assert.ok(restoredSnapshot.permissions.data.some((permission) => permission.id === 'approval_test'), 'native pending requests are restored after reconnect');
  assert.equal(restoredSnapshot.status, 'permission');
  releaseRestored();
  await restored.service.stop(restored.processId);
  restored.service.disconnect();

  // A session longer than one bounded page still shows its newest rows.
  const many = await launch({ ...process.env, MANY_ITEMS: '1' });
  const manySnapshot = await many.service.conversation(many.processId) as { messages: { data: Array<{ id: string }> }; history_truncated: boolean };
  assert.equal(manySnapshot.history_truncated, true, 'a full page is reported as truncated history');
  assert.ok(manySnapshot.messages.data.some((row) => row.id === 'history_249'), 'the newest row is displayed');
  assert.ok(!manySnapshot.messages.data.some((row) => row.id === 'history_0'), 'the oldest rows are outside the bounded page');
  const manyCursor = (manySnapshot as unknown as { history_cursor: { next: string } | null }).history_cursor;
  assert.ok(manyCursor, 'a full page offers older messages');
  const pagedIds: string[] = [];
  let pageCursor: string | null = manyCursor.next;
  while (pageCursor) {
    const page = await many.service.olderMessages(many.processId, pageCursor) as { messages: { data: Array<{ id: string }> }; cursor: string | null };
    pagedIds.unshift(...page.messages.data.map((row) => row.id));
    pageCursor = page.cursor;
  }
  assert.ok(pagedIds.includes('history_0'), 'paging reaches the start of the thread');
  const allIds = [...pagedIds, ...manySnapshot.messages.data.map((row) => row.id)];
  assert.equal(new Set(allIds).size, allIds.length, 'no row appears on two pages');
  await many.service.stop(many.processId);
  many.service.disconnect();

  // A missing executable fails the launch without an unhandled host crash.
  await assert.rejects(
    new CodexAppServerService(database, runtimeDirectory).prepare({
      executable: path.join(directory, 'does-not-exist-codex'),
      cwd: directory,
      name: 'Missing Codex',
      context: 'Project context',
      mcp: { command: process.execPath, args: ['shim.js'], env: { PATTERM_MCP_SOCKET: '/tmp/mcp.sock', PATTERM_MCP_IDENTITY: 'identity_missing' } },
      resumeId: null
    }),
    /could not start|exited during startup/
  );

  // Subagent threads nest under the spawnAgent row, live and after a reload,
  // and a subagent's turn never settles the parent's.
  const nesting = await launch({ ...process.env, SUBAGENT_THREADS: '1', NO_PENDING: '1' });
  const nestedEvents: IntegratedConversationEvent[] = [];
  const releaseNested = await nesting.service.subscribe(nesting.processId, (event) => nestedEvents.push(event));
  await nesting.service.prompt(nesting.processId, { text: 'delegate', references: [], attachments: [] });
  await waitFor(() => nestedEvents.some((event) => event.kind === 'append' && event.id === 'child_msg'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const taskView = await nesting.service.conversation(nesting.processId) as unknown as { tasks: Array<Record<string, unknown>> };
  assert.deepEqual(taskView.tasks, [{ id: 'thread_child', label: 'Explore the repo', kind: 'subagent', status: 'completed', stoppable: false }], 'a spawned thread is a task; once its own turn ends it is no longer running');
  // The task drawer reads the subagent's own items; only this agent's subagents.
  const childOutput = await nesting.service.taskOutput(nesting.processId, 'thread_child');
  assert.ok(childOutput.format === 'messages');
  assert.deepEqual(childOutput.messages.map((row) => [(row as { id: string }).id, (row as { text: string }).text]), [['child_msg', 'Child says hi']], 'task output is the subagent thread');
  assert.equal((await nesting.service.taskOutput(nesting.processId, 'thread_child', childOutput.version)).format, 'unchanged', 'an unchanged subagent skips its rows');
  await assert.rejects(nesting.service.taskOutput(nesting.processId, 'thread_test'), /does not belong/, 'the main thread is not a task');
  await assert.rejects(nesting.service.taskOutput(nesting.processId, 'thread_other'), /does not belong/, 'another thread is never read');
  assert.equal(childOutput.cursor, null, 'a short subagent has no earlier page');

  // Newer builds: a subAgentActivity subagent and a background terminal are
  // tasks; a finished foreground command is not.
  const native = await launch({ ...process.env, NATIVE_TASKS: '1', NO_PENDING: '1' });
  const nativeView = await native.service.conversation(native.processId) as unknown as { tasks: Array<Record<string, unknown>>; messages: { data: Array<{ id: string; parentId?: string }> } };
  assert.deepEqual(nativeView.tasks, [
    { id: 'thread_native', label: 'file summary', kind: 'subagent', status: 'completed', stoppable: false },
    { id: 'exec_bg', label: 'ping -c 120 127.0.0.1', kind: 'shell', status: 'running', stoppable: true }
  ], 'native subagents and background terminals are tasks');
  assert.ok(nativeView.messages.data.some((row) => row.id === 'native_129' && row.parentId === 'call_native'), 'a native subagent nests under its start row');
  const nativeOutput = await native.service.taskOutput(native.processId, 'thread_native');
  assert.ok(nativeOutput.format === 'messages' && nativeOutput.cursor);
  assert.deepEqual([nativeOutput.messages.length, (nativeOutput.messages[0] as { id: string }).id, (nativeOutput.messages.at(-1) as { id: string }).id], [100, 'native_30', 'native_129'], 'the newest page, oldest first');
  const nativeOlder = await native.service.taskOutput(native.processId, 'thread_native', null, nativeOutput.cursor);
  assert.ok(nativeOlder.format === 'messages');
  assert.deepEqual([nativeOlder.messages.length, (nativeOlder.messages[0] as { id: string }).id, nativeOlder.cursor], [30, 'native_0', null], 'the cursor reads the page before');
  const shellOutput = await native.service.taskOutput(native.processId, 'exec_bg');
  assert.ok(shellOutput.format === 'text');
  assert.equal(shellOutput.text, 'PING 127.0.0.1\n64 bytes: icmp_seq=1\n', 'a background terminal shows its row output');
  await assert.rejects(native.service.taskOutput(native.processId, 'exec_fg'), /does not belong/, 'a foreground command is not a task');
  await native.service.stopTask(native.processId, 'exec_bg');
  const terminateFile = fs.readdirSync(runtimeDirectory, { recursive: true }).map(String).find((name) => name.endsWith('.terminated'));
  assert.deepEqual(terminateFile && JSON.parse(fs.readFileSync(path.join(runtimeDirectory, terminateFile), 'utf8')), { threadId: 'thread_test', processId: '77' }, 'Stop terminates the background terminal');
  const exitedView = await native.service.conversation(native.processId) as unknown as { tasks: Array<Record<string, unknown>> };
  assert.equal(exitedView.tasks.find((task) => task.id === 'exec_bg')?.kind, 'shell', 'a terminal stays a task after it leaves the running list');
  await native.service.stop(native.processId);
  native.service.disconnect();
  const liveSpawn = nestedEvents.find((event) => event.kind === 'replace' && event.message?.id === 'spawn_1')?.message;
  assert.equal(liveSpawn?.tool?.name, 'agent', 'a collab spawn is an agent row, not raw JSON');
  assert.equal(liveSpawn?.title, 'Spawn agent');
  assert.equal(nestedEvents.find((event) => event.kind === 'replace' && event.message?.id === 'child_msg')?.message?.parentId, 'spawn_1', 'subagent rows nest under the spawn');
  assert.ok(nestedEvents.some((event) => event.kind === 'pending'), 'a subagent turn asks the renderer to re-read the task list');
  assert.ok(!nestedEvents.some((event) => event.message?.id === 'stray'), 'threads this agent did not spawn stay out');
  const noticeRows = nestedEvents.flatMap((event) => event.kind === 'replace' && event.message?.kind === 'notice' ? [[event.message.level, event.message.text]] : []);
  assert.ok(noticeRows.some(([level, text]) => level === 'warning' && text === 'Stream disconnected; retrying'), 'a retried error is a warning notice');
  assert.ok(!nestedEvents.some((event) => event.kind === 'error'), 'a retried error does not fail the turn');
  assert.ok(noticeRows.some(([level, text]) => level === 'warning' && text === 'Unknown key in config.toml\nmodel_foo\n/home/u/.codex/config.toml'));
  assert.ok(noticeRows.some(([level, text]) => level === 'info' && text === 'Switched from gpt-test to gpt-mini (highRiskCyberActivity)'));
  const liveSnapshot = await nesting.service.conversation(nesting.processId) as { messages: { data: Array<{ id: string; text: string; parentId?: string }> } };
  assert.equal(liveSnapshot.messages.data.find((row) => row.id === 'child_msg')?.text, 'Child says hi');
  const { lastModelActivityAt: codexActivity, limits: codexLimits, ...codexUsage } = (liveSnapshot as unknown as { usage: Record<string, unknown> & { limits: Array<Record<string, unknown>> } }).usage;
  assert.ok(codexLimits.every(({ observedAt }) => Date.now() - Date.parse(String(observedAt)) < 60_000), 'each quota window is dated when Codex reported it');
  assert.ok(Date.now() - Date.parse(String(codexActivity)) < 60_000, 'a token usage update stamps the latest model activity');
  assert.deepEqual({ ...codexUsage, limits: codexLimits.map(({ observedAt: _, ...limit }) => limit) }, {
    contextTokens: 21_000, contextWindow: 272_000, inputTokens: 50_000, outputTokens: 2_000,
    limits: [{ label: '5h limit', usedPercent: 37, resetsAt: new Date(1790000000 * 1000).toISOString() }]
  }, 'the parent thread usage and the account quota are reported; a subagent thread does not replace them');
  releaseNested();
  const reloaded = new CodexAppServerService(database, runtimeDirectory);
  const reloadedView = await reloaded.conversation(nesting.processId) as { messages: { data: Array<{ id: string; parentId?: string }> } };
  assert.equal(reloadedView.messages.data.find((row) => row.id === 'child_msg')?.parentId, 'spawn_1', 'nesting survives a reload');
  reloaded.disconnect();
  await nesting.service.stop(nesting.processId);
  nesting.service.disconnect();

  // Built-in commands map to thread methods, not prompt text.
  const commands = await launch({ ...process.env, COMMANDS: '1', NO_PENDING: '1' });
  const commandIntegrated = new IntegratedAgentService(database, { codex: commands.service });
  assert.deepEqual((await commandIntegrated.controls(commands.processId)).commands.map((command) => command.name), ['new', 'resume', 'compact', 'fast', 'review', 'undo', 'rename', 'goal', 'shell']);
  await commands.service.command(commands.processId, 'review', 'base main');
  await commands.service.command(commands.processId, 'review', 'commit abc1234');
  await commands.service.command(commands.processId, 'rename', 'Auth refactor');
  await commands.service.command(commands.processId, 'goal', 'Ship the login page');
  await commands.service.command(commands.processId, 'shell', 'git status');
  await commands.service.command(commands.processId, 'undo', '');
  await assert.rejects(commands.service.command(commands.processId, 'rename', ' '), /new name/);
  const commandRows = (JSON.parse(JSON.stringify(await commands.service.conversation(commands.processId))) as { messages: { data: Array<{ id: string; text: string }> } }).messages.data
    .filter((row) => row.id.startsWith('command_')).map((row) => [row.id.replace(/_\d+$/, ''), JSON.parse(row.text)]);
  assert.deepEqual(commandRows, [
    ['command_review_start', { threadId: 'thread_test', target: { type: 'baseBranch', branch: 'main' }, delivery: 'inline' }],
    ['command_review_start', { threadId: 'thread_test', target: { type: 'commit', sha: 'abc1234', title: null }, delivery: 'inline' }],
    ['command_thread_name_set', { threadId: 'thread_test', name: 'Auth refactor' }],
    ['command_thread_goal_set', { threadId: 'thread_test', objective: 'Ship the login page' }],
    ['command_thread_shellCommand', { threadId: 'thread_test', command: 'git status' }],
    ['command_thread_revert', { threadId: 'thread_test', beforeTurnId: 'turn_done' }]
  ]);
  await commands.service.stop(commands.processId);
  commands.service.disconnect();

  // Subagent requests pause the parent turn, so they must be answerable. MCP
  // elicitations become forms, and requests nobody can answer are declined.
  const children = await launch({ ...process.env, CHILD_REQUESTS: '1', NO_PENDING: '1' });
  await children.service.prompt(children.processId, { text: 'delegate', references: [], attachments: [] });
  let childView: { status: string; permissions: { data: Array<{ id: string; action: string }> }; forms: { data: Array<Record<string, unknown>> }; messages: { data: Array<{ id: string; text: string }> } };
  const readChildren = async () => {
    childView = JSON.parse(JSON.stringify(await children.service.conversation(children.processId)));
    return childView;
  };
  const deadline = Date.now() + 3_000;
  while ((await readChildren()).forms.data.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(childView!.status, 'permission');
  const approvals = childView!.permissions.data as Array<{ id: string; action: string; detail?: string; command?: string; cwd?: string; patch?: string }>;
  assert.deepEqual(approvals.map((item) => [item.id, item.action, item.detail, item.command, item.cwd]), [
    ['child_approval', 'Subagent: Run this command?', 'Clean the build', 'rm -rf build', '/work'],
    ['patch_approval', 'Apply these file changes?', 'Needs write access', undefined, undefined]
  ], 'a subagent approval is shown and labelled with its command, reason, and directory');
  assert.equal(approvals[1]?.patch, '+++ src/app.ts\n+added', 'a file change approval previews its diff');
  const [form, urlForm] = childView!.forms.data as Array<{ id: string; title: string; detail: string; declinable: boolean; fields: Array<Record<string, unknown>> }>;
  assert.equal(form!.id, 'elicit_form');
  assert.equal(form!.title, 'Pick a team');
  assert.equal(form!.detail, 'Requested by the linear MCP server');
  assert.equal(form!.declinable, true);
  assert.deepEqual(form!.fields.map((field) => [field.key, field.type, field.required]), [
    ['team', 'string', true], ['count', 'integer', false], ['notify', 'boolean', false], ['labels', 'multiselect', false]
  ], 'MCP schema properties become typed form fields');
  assert.deepEqual(form!.fields[0]!.options, [{ value: 'eng', label: 'Engineering' }, { value: 'ops', label: 'Operations' }]);
  assert.equal(urlForm!.fields[0]!.type, 'external');
  assert.equal(urlForm!.fields[0]!.url, 'https://github.com/login/device');
  const childIntegrated = new IntegratedAgentService(database, { codex: children.service });
  await assert.rejects(childIntegrated.replyForm(children.processId, 'elicit_form', {}), /Answer "Team"/);
  await childIntegrated.replyForm(children.processId, 'elicit_form', { team: 'eng', count: 2, labels: ['bug'] });
  await childIntegrated.replyForm(children.processId, 'elicit_url', {}, 'decline');
  await children.service.replyPermission(children.processId, 'child_approval', 'reject');
  await children.service.replyPermission(children.processId, 'patch_approval', 'once');
  await readChildren();
  const deadlineResponses = Date.now() + 3_000;
  while (!(await readChildren()).messages.data.some((row) => row.id === 'response_child_approval') && Date.now() < deadlineResponses) await new Promise((resolve) => setTimeout(resolve, 25));
  const responses = Object.fromEntries(childView!.messages.data.filter((row) => row.id.startsWith('response_')).map((row) => [row.id, JSON.parse(row.text)]));
  assert.deepEqual(responses.response_elicit_form, { action: 'accept', content: { team: 'eng', count: 2, labels: ['bug'] }, _meta: null });
  assert.deepEqual(responses.response_elicit_url, { action: 'decline', content: null, _meta: null });
  assert.deepEqual(responses.response_child_approval, { decision: 'decline' });
  assert.match(String(responses.response_dynamic_tool?.error), /does not handle item\/tool\/call/, 'an unanswerable request is declined, not left pending');
  assert.equal(childView!.status, 'idle', 'nothing remains pending once every request is answered');
  await children.service.stop(children.processId);
  children.service.disconnect();

  for (const extra of [lost, delayed, rejected, compacting]) {
    await extra.service.stop(extra.processId);
    extra.service.disconnect();
  }
  } finally {
    database.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

void main().then(() => console.log('codex app-server smoke ok'));
