import { readFile, writeFile, appendFile, mkdir, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexAdapter } from './codex.mjs';
import { createBridgeRouter, dispatchAndWait } from './result-relay.mjs';

function opts(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || argv[i+1] === undefined || argv[i+1].startsWith('--') || Object.hasOwn(o, argv[i].slice(2))) throw new Error('Invalid or duplicate option');
    o[argv[i].slice(2)] = argv[i+1];
  }
  return o;
}
async function textInput(o) {
  if (o['message-file']) return readFile(o['message-file'], 'utf8');
  if (process.stdin.isTTY) throw new Error('Supply --message-file or piped stdin');
  const parts=[];
  for await (const b of process.stdin) parts.push(Buffer.from(b));
  return Buffer.concat(parts).toString('utf8');
}
const output = value => process.stdout.write(JSON.stringify(value) + '\n');
function positive(value, name) {
  if (!/^[1-9][0-9]*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Error(name + ' must be a positive integer');
  return Number(value);
}
function boolean(value) {
  if (value !== 'true' && value !== 'false') throw new Error('--auto-reply must be true or false');
  return value === 'true';
}
function overrides(o) {
  const config = {};
  if (o['target-host-id'] !== undefined) config.codexTargetHostId = o['target-host-id'];
  if (o['auto-reply'] !== undefined) config.autoReply = boolean(o['auto-reply']);
  if (o['result-timeout-ms'] !== undefined) config.resultTimeoutMs = positive(o['result-timeout-ms'], '--result-timeout-ms');
  if (o['poll-ms'] !== undefined) config.resultPollMs = positive(o['poll-ms'], '--poll-ms');
  return config;
}
function validate(config, withClaude = false) {
  for (const key of ['codexOwnerThreadId', 'codexTargetThreadId', 'codexPipePath']) {
    if (typeof config[key] !== 'string' || !config[key].trim()) throw new Error('Explicit owner, target and native pipe are required');
  }
  if (withClaude && !config.claudeSessionId) throw new Error('serve requires a Claude session');
  if (config.codexTargetHostId !== undefined && (typeof config.codexTargetHostId !== 'string' || !config.codexTargetHostId.trim())) throw new Error('Target host must be non-empty');
  if (config.autoReply !== undefined && typeof config.autoReply !== 'boolean') throw new Error('autoReply must be boolean');
  if (config.resultTimeoutMs !== undefined) positive(config.resultTimeoutMs, 'resultTimeoutMs');
  if (config.resultPollMs !== undefined) positive(config.resultPollMs, 'resultPollMs');
  if (config.resultPollMs > 2147483647) throw new Error('resultPollMs exceeds the timer range');
  return config;
}
async function loadConfig(path, o = {}) {
  const config = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
  config.codexPipePath ??= process.env.CODEX_APP_TOOLS_PIPE_PATH;
  return validate({ ...config, ...overrides(o) });
}

export async function serve(configPath, statePath, options = {}) {
  const config = validate(await loadConfig(configPath, options), true);
  const { createCallbackReceiver, ClaudeAdapter, socketUri } = await import('./claude.mjs');
  const matches = (await ClaudeAdapter.listSessions({registryDir:config.claudeRegistryDir})).filter(x=>x.sessionId===config.claudeSessionId);
  if (matches.length !== 1) throw new Error('Claude source session is unavailable or ambiguous');
  const expectedClaudeFrom = socketUri(matches[0].messagingSocketPath);
  const codex = new CodexAdapter({ pipePath: config.codexPipePath, ownerThreadId: config.codexOwnerThreadId });
  let receiver;
  let ownsState = false;
  let stopHandler;
  try {
  await codex.listTools();
  await codex.listThreads({ limit: 1 });
  receiver = await createCallbackReceiver({ registryDir: config.claudeRegistryDir });
  const claude = new ClaudeAdapter({sessionId:config.claudeSessionId, registryDir:config.claudeRegistryDir});
  const state = { pid: process.pid, claudeSessionId: config.claudeSessionId,
    claudeRegistryDir: config.claudeRegistryDir, codexTargetThreadId: config.codexTargetThreadId,
    codexTargetHostId: config.codexTargetHostId, autoReply: config.autoReply ?? false,
    callbackUri: receiver.callbackUri, createdAt: new Date().toISOString() };
  await mkdir(dirname(statePath), {recursive:true});
  const eventsPath = resolve(dirname(statePath), 'events.jsonl');
  async function record(value) { await appendFile(eventsPath, JSON.stringify({time:new Date().toISOString(),...value})+'\n','utf8'); }
  const router = createBridgeRouter({config,codex,claude,callbackUri:receiver.callbackUri,expectedClaudeFrom,record,output});
  const receipts = new Set();
  receiver.onReceipt(frame => {
    if (frame.from !== expectedClaudeFrom) return;
    const task = record({event:'claude_receipt',status:frame.status,msgId:frame.msg_id,originalMsgId:frame.orig_msg_id,reason:frame.reason,statusDetail:frame.status_detail})
      .catch(e => output({status:'error',code:'RECEIPT_RECORD_FAILED',error:e.message}));
    receipts.add(task); task.finally(()=>receipts.delete(task));
  });
  receiver.onMessage(frame => { router.receive(frame); });
  await writeFile(statePath,JSON.stringify(state,null,2)+'\n','utf8');
  ownsState = true;
  await record({event:'bridge_ready',...state});
  output({status:'ready',statePath,...state});
  await new Promise(resolveStop=>{
    stopHandler = resolveStop;
    process.once('SIGINT',stopHandler); process.once('SIGTERM',stopHandler);
  });
  await router.drained();
  await Promise.all(receipts);
  } finally {
    if (stopHandler) { process.off('SIGINT',stopHandler); process.off('SIGTERM',stopHandler); }
    try { await receiver?.close(); }
    finally { codex.close(); if (ownsState) await unlink(statePath).catch(()=>{}); }
  }
}

export async function runBridgeCli(argv) {
  const [command,...rest]=argv; const o=opts(rest);
  const allowed = new Set(['owner-thread','target-thread','session-id','pipe','config','state','registry-dir',
    'message-file','target-host-id','auto-reply','result-timeout-ms','poll-ms']);
  for (const name of Object.keys(o)) if (!allowed.has(name)) throw new Error('Unknown bridge option: --'+name);
  if (command==='bind') {
    const config=validate({codexOwnerThreadId:o['owner-thread'],codexTargetThreadId:o['target-thread'],
      ...(o['session-id'] ? {claudeSessionId:o['session-id']} : {}),
      ...(o['registry-dir'] ? {claudeRegistryDir:o['registry-dir']} : {}),
      codexPipePath:o.pipe??process.env.CODEX_APP_TOOLS_PIPE_PATH,...overrides(o)});
    const destination=resolve(o.config??'runtime/config.json');
    await mkdir(dirname(destination),{recursive:true});
    await writeFile(destination,JSON.stringify(config,null,2)+'\n','utf8');
    output({status:'bound',configPath:destination,codexOwnerThreadId:config.codexOwnerThreadId,
      codexTargetThreadId:config.codexTargetThreadId,codexTargetHostId:config.codexTargetHostId,
      claudeSessionId:config.claudeSessionId,autoReply:config.autoReply??false});return;
  }
  if (command==='request') {
    const config=await loadConfig(resolve(o.config??'runtime/config.json'),o);
    const content=await textInput(o);
    if (!content.trim()) throw new Error('request requires a non-empty message');
    const id=randomUUID();
    const marker=`[跨模型橋接工作｜外部 CLI｜來源 Codex 聊天 ${config.codexOwnerThreadId}｜訊息 ${id}]`;
    const codex=new CodexAdapter({pipePath:config.codexPipePath,ownerThreadId:config.codexOwnerThreadId});
    try {
      const completed=await dispatchAndWait({codex,threadId:config.codexTargetThreadId,hostId:config.codexTargetHostId,
        prompt:marker+'\n'+content,marker,timeoutMs:config.resultTimeoutMs,pollMs:config.resultPollMs});
      output({...completed,msgId:id,threadId:config.codexTargetThreadId,hostId:config.codexTargetHostId});
    } catch (error) {
      output({status:error.delivery==='not_sent'||error.delivery==='failed'?'failed':'unknown',
        msgId:id,threadId:config.codexTargetThreadId,hostId:config.codexTargetHostId,
        delivery:error.delivery??'unknown',code:error.code??'ERROR',error:error.message,observed:error.observed});
      process.exitCode=1;
    } finally {codex.close();}
    return;
  }
  if (command==='serve') return serve(resolve(o.config??'runtime/config.json'),resolve(o.state??'runtime/state.json'),o);
  if (command==='status') {
    const state=JSON.parse(await readFile(resolve(o.state??'runtime/state.json'),'utf8'));
    let status='running';let reason;
    try{process.kill(state.pid,0);}catch(e){status=e.code==='ESRCH'?'stopped':'unknown';reason=e.code??'PROCESS_VISIBILITY_UNAVAILABLE';}
    output({status,...state,...(reason?{reason}: {})});return;
  }
  if (command==='send') {
    const state=JSON.parse(await readFile(resolve(o.state??'runtime/state.json'),'utf8'));
    try {process.kill(state.pid,0);} catch(e) {if(e.code==='ESRCH')throw new Error('Bridge process is stopped; start it before sending');}
    const {ClaudeAdapter}=await import('./claude.mjs');
    const adapter=new ClaudeAdapter({sessionId:state.claudeSessionId,registryDir:o['registry-dir']??state.claudeRegistryDir});
    const result=await adapter.sendMessage({message:await textInput(o),callbackUri:state.callbackUri,fromName:'Codex bridge',fromMode:'prompting'});
    output(result);
    if (result.status==='failed'||result.status==='unknown') process.exitCode=1;
    return;
  }
  throw new Error('Expected bridge bind|request|serve|status|send');
}
export async function runClaudeCli(argv) {
  const [command,...rest]=argv; const o=opts(rest);const {ClaudeAdapter}=await import('./claude.mjs');
  const allowed = new Set(command === 'sessions' ? ['registry-dir'] : ['session-id', 'registry-dir', 'message-file', 'callback-uri']);
  for (const name of Object.keys(o)) if (!allowed.has(name)) throw new Error('Unknown Claude option: --'+name);
  if(command==='sessions'){output({status:'ok',sessions:await ClaudeAdapter.listSessions({registryDir:o['registry-dir']})});return;}
  if(command==='send'){
    const adapter=new ClaudeAdapter({sessionId:o['session-id'],registryDir:o['registry-dir']});
    const result=await adapter.sendMessage({message:await textInput(o),callbackUri:o['callback-uri'],fromName:'Codex bridge',fromMode:'prompting'});
    output(result);
    if (result.status==='failed'||result.status==='unknown') process.exitCode=1;
    return;
  }
  throw new Error('Expected claude sessions|send');
}
