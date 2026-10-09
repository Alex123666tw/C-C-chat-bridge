import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ClaudeAdapter, createCallbackReceiver, keyFileFor, socketUri } from './claude.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODEX = process.env.PAIR_CODEX_EXE;
const CLAUDE = process.env.PAIR_CLAUDE_EXE;
if (!CODEX || !CLAUDE || process.platform !== 'win32') {
  process.stderr.write('Set PAIR_CODEX_EXE and PAIR_CLAUDE_EXE to native Windows executable paths before running this opt-in model probe.\n');
  process.exit(1);
}
const CODEX_MODEL = process.env.PAIR_CODEX_MODEL;
const CLAUDE_MODEL = process.env.PAIR_CLAUDE_MODEL;
if (!CODEX_MODEL || !CLAUDE_MODEL) {
  process.stderr.write('Set PAIR_CODEX_MODEL and PAIR_CLAUDE_MODEL; the opt-in probe uses paid model calls.\n');
  process.exit(1);
}
const runId = randomUUID(), nonce = 'CLI_PAIR_' + randomUUID().replaceAll('-', '');
const out = path.join(root, 'tests', 'output', 'cli-pair-' + runId);
const cwd = path.join(root, 'runtime', 'cli-pair-' + runId);
const registry = path.join(os.homedir(), '.claude', 'sessions');
const sessionId = randomUUID();
const claudeSocket = String.raw`\\.\pipe\LOCAL\cc-msg-` + randomUUID().replaceAll('-', '');
const started = Date.now();
await fs.mkdir(out, {recursive:true});
await fs.mkdir(cwd, {recursive:true});
const records = [];
function log(event, data = {}) {
  const record = {at:new Date().toISOString(), elapsedMs:Date.now()-started, event, ...data};
  records.push(record);
  process.stdout.write(JSON.stringify(record) + '\n');
}
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function until(test,label,ms=120000) {
  const end=Date.now()+ms;
  while(Date.now()<end) { const value=await test(); if(value) return value; await sleep(100); }
  throw new Error('TIMEOUT_' + label);
}
function lines(stream, fn) {
  stream.setEncoding('utf8'); let buffer='';
  stream.on('data',chunk=>{buffer+=chunk; let index; while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(line.trim())fn(line);}});
}
let codex, claude, callback, threadId, activeTurn, reply, final='', toolCalls=0, failure;
let cleanupOwnRegistry=false;
const summary={runId,nonce,harnessPid:process.pid,startedAt:new Date(started).toISOString(),status:'INCONCLUSIVE',
  requestedModels:{codex:CODEX_MODEL,claude:CLAUDE_MODEL},out,cwd,claudeSessionId:sessionId,
  claudeSocketPath:claudeSocket,protocolSource:'codex-cli 0.160.0 generated schema; https://developers.openai.com/codex/app-server'};
try {
  callback=await createCallbackReceiver({registryDir:registry});
  summary.callbackSocketPath=callback.socketPath;
  callback.onMessage(frame=>{
    const expectedFrom=socketUri(claudeSocket);
    log('claude.callback',{from:frame.from,content:frame.message.content,sessionId:frame.session_id});
    if(frame.from!==expectedFrom || !frame.message.content.includes('CLAUDE_REPLY '+nonce)) {
      failure=new Error('CALLBACK_IDENTITY_OR_NONCE_MISMATCH'); return;
    }
    if(reply) {failure=new Error('DUPLICATE_REPLY');return;}
    reply=frame;
  });
  callback.onReceipt(frame=>log('claude.receipt',{status:frame.status,msgId:frame.msg_id}));
  const claudeArgs=['-p','--input-format','stream-json','--output-format','stream-json','--verbose',
    '--model',CLAUDE_MODEL,'--effort','low','--session-id',sessionId,
    '--messaging-socket-path',claudeSocket,'--safe-mode','--strict-mcp-config',
    '--tools','SendMessage','--allowedTools','SendMessage','--permission-mode','dontAsk',
    '--system-prompt','You are an isolated neutral CLI message probe. Do not read or modify files. You may only use SendMessage. On the initial setup message reply exactly READY. On a cross-session-message, call native SendMessage once with to equal the from uds URI in that message and message equal CLAUDE_REPLY followed by the exact supplied nonce. Use summary CLI pair probe. Then reply SENT.'];
  claude=spawn(CLAUDE,claudeArgs,{cwd,windowsHide:true,stdio:['pipe','pipe','pipe']});
  summary.claudePid=claude.pid;
  claude.on('error',e=>{failure=new Error('CLAUDE_SPAWN_'+e.code);});
  claude.on('exit',(code,signal)=>log('claude.exit',{code,signal}));
  lines(claude.stderr,line=>log('claude.stderr',{text:line}));
  let ready=false;
  lines(claude.stdout,line=>{
    let m;try{m=JSON.parse(line);}catch{log('claude.stdout',{text:line});return;}
    if(m.type==='system'&&m.subtype==='init'){summary.claudeActualModel=m.model;log('claude.init',{model:m.model,tools:m.tools,sessionId:m.session_id});}
    else if(m.type==='assistant'){log('claude.assistant',{model:m.message?.model,content:m.message?.content});if(JSON.stringify(m.message?.content).includes('READY'))ready=true;}
    else if(m.type==='result'){log('claude.result',{subtype:m.subtype,isError:m.is_error,result:m.result,models:Object.keys(m.modelUsage??{})});if(m.is_error)failure=new Error('CLAUDE_RESULT_ERROR');}
    else if(m.type==='user')log('claude.user',{content:m.message?.content});
  });
  claude.stdin.write(JSON.stringify({type:'user',message:{role:'user',content:'Initialize this independent probe. Reply READY and wait for the peer nonce.'},session_id:sessionId,parent_tool_use_id:null})+'\n');
  log('claude.launch',{pid:claude.pid,model:CLAUDE_MODEL,sessionId,permissionMode:'dontAsk',allowedTools:['SendMessage']});
  await until(async()=>{
    if(failure)throw failure;
    try {await fs.access(keyFileFor(claude.pid,claudeSocket,registry));return true;}catch{return false;}
  },'CLAUDE_NATIVE_KEY',30000);
  const existing=(await ClaudeAdapter.listSessions({registryDir:registry})).find(s=>s.sessionId===sessionId);
  if(!existing) {
    const entry={pid:claude.pid,sessionId,messagingSocketPath:claudeSocket,cwd,status:'active',name:'Independent CLI pair probe'};
    await fs.writeFile(path.join(registry,claude.pid+'.json'),JSON.stringify(entry),{flag:'wx'});
    cleanupOwnRegistry=true;
    log('claude.registry',{source:'test-owned metadata',pid:claude.pid,sessionId,socketPath:claudeSocket});
  } else if(existing.pid!==claude.pid || existing.messagingSocketPath!==claudeSocket)throw new Error('CLAUDE_SESSION_BINDING_MISMATCH');
  await until(()=>{if(failure)throw failure;return ready;},'CLAUDE_READY');
  const adapter=new ClaudeAdapter({sessionId,registryDir:registry});
  codex=spawn(CODEX,['app-server','--stdio'],{cwd,windowsHide:true,stdio:['pipe','pipe','pipe']});
  summary.codexPid=codex.pid;
  log('codex.launch',{pid:codex.pid,model:CODEX_MODEL});
  codex.on('error',e=>{failure=new Error('CODEX_SPAWN_'+e.code);});
  codex.on('exit',(code,signal)=>log('codex.exit',{code,signal}));
  lines(codex.stderr,line=>log('codex.stderr',{text:line}));
  let nextId=1;const pending=new Map();
  function send(frame){codex.stdin.write(JSON.stringify(frame)+'\n');}
  function request(method,params){
    const id=nextId++;log('codex.request',{method,id,params});
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error('RPC_TIMEOUT_'+method));},30000);
      pending.set(id,{resolve,reject,timer});send({id,method,params});
    });
  }
  lines(codex.stdout,line=>{
    let m;try{m=JSON.parse(line);}catch{log('codex.stdout',{text:line});return;}
    if(m.id!==undefined&&m.method===undefined){
      const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);if(m.error)p.reject(new Error('RPC_'+JSON.stringify(m.error)));else p.resolve(m.result);}return;
    }
    if(m.method==='item/tool/call'){
      log('codex.toolCall',{id:m.id,params:m.params});
      (async()=>{
        const a=typeof m.params.arguments==='string'?JSON.parse(m.params.arguments):m.params.arguments;
        if(m.params.threadId!==threadId||m.params.tool!=='send_to_claude'||toolCalls++!==0||a?.message!==nonce)throw new Error('UNEXPECTED_TOOL_CALL');
        const result=await adapter.sendMessage({message:'Peer nonce: '+a.message+'\nReply through native SendMessage to the from uds URI. Exact reply message: CLAUDE_REPLY '+a.message,callbackUri:callback.callbackUri,fromName:'Independent Codex CLI'});
        log('codex.toClaude',{...result,message:a.message});
        if(result.status!=='submitted_unconfirmed')throw new Error('CLAUDE_SUBMIT_'+result.reason);
        send({id:m.id,result:{success:true,contentItems:[{type:'inputText',text:'Peer message submitted. Reply exactly WAITING; do not claim receipt until a peer response arrives.'}]}});
      })().catch(e=>{failure=e;send({id:m.id,result:{success:false,contentItems:[{type:'inputText',text:e.message}]}});});
    } else if(m.id!==undefined) {
      failure=new Error('UNEXPECTED_CODEX_SERVER_REQUEST_'+m.method);
      send({id:m.id,error:{code:-32601,message:'This probe only serves send_to_claude.'}});
    } else if(m.method==='turn/started'){activeTurn=m.params.turn.id;log('codex.turnStarted',{threadId:m.params.threadId,turnId:activeTurn});}
    else if(m.method==='turn/completed'){log('codex.turnCompleted',{threadId:m.params.threadId,turnId:m.params.turn.id,status:m.params.turn.status,error:m.params.turn.error});activeTurn=null;if(m.params.turn.status==='failed')failure=new Error('CODEX_TURN_FAILED_'+JSON.stringify(m.params.turn.error));}
    else if(m.method==='item/completed'&&m.params.item.type==='agentMessage'){final=m.params.item.text;log('codex.agentMessage',{threadId:m.params.threadId,turnId:m.params.turnId,text:final});}
    else if(m.method==='error'){log('codex.error',m.params);if(!m.params.willRetry)failure=new Error('CODEX_ERROR_'+JSON.stringify(m.params.error));}
  });
  const init=await request('initialize',{clientInfo:{name:'cli_pair_probe',version:'1.0.0'},capabilities:{experimentalApi:true}});
  log('codex.initialize',{userAgent:init.userAgent});send({method:'initialized',params:{}});
  const thread=await request('thread/start',{cwd,ephemeral:true,model:CODEX_MODEL,allowProviderModelFallback:false,sandbox:'read-only',approvalPolicy:'never',environments:[],
    config:{model_reasoning_effort:'low',mcp_servers:{}},
    baseInstructions:'You are an independent neutral CLI message probe. Only use the supplied send_to_claude tool. Do not read or write files or use any other tool. Never claim a peer reply without receiving it.',
    dynamicTools:[{type:'function',name:'send_to_claude',description:'Send a neutral message to the independent Claude CLI peer.',inputSchema:{type:'object',properties:{message:{type:'string'}},required:['message'],additionalProperties:false}}]});
  threadId=thread.thread.id;summary.codexThreadId=threadId;summary.codexActualModel=thread.model;summary.codexModelProvider=thread.modelProvider;
  log('codex.thread',{threadId,model:thread.model,modelProvider:thread.modelProvider});
  await request('turn/start',{threadId,model:CODEX_MODEL,effort:'low',input:[{type:'text',text:'Call send_to_claude exactly once with message "'+nonce+'". After its result reply exactly WAITING. The next input will contain the actual peer reply.',text_elements:[]}]});
  await until(()=>{if(failure)throw failure;return reply && !activeTurn;},'PEER_REPLY_AND_IDLE');
  summary.replyAuthenticated=true;summary.replyFrom=reply.from;
  await request('turn/start',{threadId,model:CODEX_MODEL,effort:'low',input:[{type:'text',text:'Actual peer reply from the independent Claude CLI ('+reply.from+'): '+reply.message.content+'\nThe authenticated callback and nonce match were verified. Reply exactly PAIR_DONE '+nonce+'. Use no tools.',text_elements:[]}]});
  await until(()=>{if(failure)throw failure;return !activeTurn&&final==='PAIR_DONE '+nonce;},'CODEX_FINAL');
  summary.status='PASS';summary.final=final;summary.toolCalls=toolCalls;summary.elapsedMs=Date.now()-started;
  log('pair.pass',{nonce,threadId,claudeSessionId:sessionId,models:{codex:summary.codexActualModel,claude:summary.claudeActualModel},elapsedMs:summary.elapsedMs});
} catch(error) {
  summary.status=error.message.startsWith('RPC_')?'HARNESS_ERROR':'ENV_BLOCKED';
  summary.error=error.message;summary.elapsedMs=Date.now()-started;
  log('pair.failure',{status:summary.status,error:error.message});
} finally {
  if(codex){codex.stdin.end();codex.kill();}
  if(claude){claude.stdin.end();claude.kill();}
  if(callback)await callback.close();
  if(claude?.pid) {
    const ownJson=path.join(registry,claude.pid+'.json');
    try {const entry=JSON.parse(await fs.readFile(ownJson,'utf8'));if(entry.sessionId===sessionId&&entry.messagingSocketPath===claudeSocket)await fs.unlink(ownJson);}catch{}
    // This key path is bound to the PID and random socket exclusively created by this run.
    try {await fs.unlink(keyFileFor(claude.pid,claudeSocket,registry));}catch{}
  }
  await sleep(500);
  summary.cleanup={codexExit:codex?.exitCode,codexSignal:codex?.signalCode,claudeExit:claude?.exitCode,claudeSignal:claude?.signalCode,callbackClosed:true,testRegistryRemoved:cleanupOwnRegistry};
  log('pair.cleanup',summary.cleanup);
  await fs.writeFile(path.join(out,'events.jsonl'),records.map(r=>JSON.stringify(r)).join('\n')+'\n');
  await fs.writeFile(path.join(out,'summary.json'),JSON.stringify(summary,null,2)+'\n');
  process.stdout.write(JSON.stringify({summaryFile:path.join(out,'summary.json'),status:summary.status})+'\n');
}
process.exitCode=summary.status==='PASS'?0:1;
