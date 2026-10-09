import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createBridgeRouter, dispatchAndWait } from '../src/result-relay.mjs';
import { encodeFrame, CodexAdapter } from '../src/codex.mjs';
import { keyFileFor, socketUri } from '../src/claude.mjs';

const owner = 'authorized-owner';
const hostId = 'remote-control:mac-host';
const config = { codexOwnerThreadId:owner, codexTargetThreadId:'mac-target', codexTargetHostId:hostId,
  claudeSessionId:'claude-source', autoReply:true, resultTimeoutMs:20, resultPollMs:1 };
const frame = (id, content) => ({ from:'uds:expected', msg_id:id, message:{content} });
const delegation = marker => ({ type:'functionCallOutput', name:'send_message_to_thread', namespace:'codex_app',
  output:{text:'<codex_delegation>\n<input>'+marker+'</input>\n</codex_delegation>',truncated:false} });
const turn = (id, status, marker, text = 'finished', phase = 'final') => ({ id,status,
  items:[...(marker ? [delegation(marker)] : []),{type:'agentMessage',phase,text}] });
const snap = (status, turns) => ({ thread:{status:{type:status}},turns });
const envelope = snapshot => ({success:true,contentItems:[{type:'inputText',text:JSON.stringify({
  content:[{type:'text',text:JSON.stringify(snapshot)}]})}]});
function timer() {
  let n=0;
  return {now:()=>n,sleep:async ms=>{n+=ms;}};
}

test('callback route waits for existing work, ignores old final/commentary, returns exact new final once and queues the next work', async () => {
  const outgoing=[], reads=[], returns=[], records=[];
  let step=0, dispatches=0;
  const codex = {
    async sendMessage(args) { outgoing.push(args); dispatches++; step=0; return {success:true}; },
    async readThread(args) {
      reads.push(args);
      const marker=outgoing.at(-1)?.prompt.split('\n')[0];
      if (dispatches===0) {
        step++;
        return envelope(step===1 ? snap('active',[turn('old-busy','inProgress',null,'old progress','commentary')])
          : snap('idle',[turn('old-busy','completed',null,'OLD FINAL')]));
      }
      step++;
      const fresh=turn('work-'+dispatches,step===1?'inProgress':'completed',marker,step===1?'WORKING':'RESULT '+dispatches,step===1?'commentary':'final');
      return envelope(snap(step===1?'active':'idle',[fresh,turn('old-busy','completed',null,'OLD FINAL')]));
    },
  };
  const router=createBridgeRouter({config,codex,claude:{async sendMessage(args){returns.push(args);return{status:'submitted_unconfirmed'};}},
    callbackUri:'uds:callback',expectedClaudeFrom:'uds:expected',record:async x=>records.push(x),waitOptions:timer()});
  const first=frame('message-one','first task\n繁體中文');
  router.receive(first); router.receive(first); router.receive(frame('message-two','second task'));
  router.receive({...frame('spoofed','untrusted'),from:'uds:wrong'});
  await router.drained();
  assert.equal(outgoing.length,2);
  assert.equal(returns.length,2);
  assert.equal(outgoing[0].hostId,hostId);
  assert.equal(outgoing[0].threadId,'mac-target');
  assert.ok(outgoing[0].prompt.endsWith('first task\n繁體中文'));
  assert.equal(outgoing[1].hostId,hostId);
  assert.ok(reads.every(args=>args.hostId===hostId && args.includeOutputs===true));
  assert.match(returns[0].message,/RESULT 1/);
  assert.match(returns[1].message,/RESULT 2/);
  assert.ok(!returns.some(x=>/OLD FINAL|WORKING/.test(x.message)));
  assert.ok(returns.every(x=>x.callbackUri==='uds:callback'));
  assert.equal(records.filter(x=>x.event==='codex_work_completed').length,2);
  assert.equal(records.filter(x=>x.event==='source_mismatch').length,1);
});

test('post-send timeout reports actual target state and never sends the task twice', async () => {
  const outgoing=[], returns=[], records=[];
  const codex={async sendMessage(args){outgoing.push(args);return{};},
    async readThread(){return envelope(outgoing.length
      ? snap('active',[turn('own-new','inProgress',outgoing[0].prompt.split('\n')[0],'progress','commentary')])
      : snap('idle',[turn('old','completed',null,'old')]));
    }};
  const router=createBridgeRouter({config,codex,claude:{async sendMessage(args){returns.push(args);return{status:'submitted_unconfirmed'};}},
    callbackUri:'uds:callback',expectedClaudeFrom:'uds:expected',record:async x=>records.push(x),waitOptions:timer()});
  await router.receive(frame('slow','long task'));
  assert.equal(outgoing.length,1);
  assert.equal(returns.length,1);
  assert.match(returns[0].message,/RESULT_TIMEOUT/);
  assert.match(returns[0].message,/"threadStatus":"active"/);
  assert.match(returns[0].message,/"turnId":"own-new"/);
  assert.ok(!returns[0].message.includes('progress'));
  assert.equal(records.find(x=>x.event==='codex_forward_failed').delivery,'accepted');
});

test('busy target timeout sends no work; unrelated new turn, missing final and unknown send never masquerade as a result', async t => {
  for (const kind of ['busy','unrelated','no-final','send-unknown']) await t.test(kind,async()=>{
    let sent=0;
    const codex={
      async sendMessage(){sent++;if(kind==='send-unknown')throw Object.assign(new Error('TIMEOUT'),{code:'TIMEOUT',delivery:'unknown'});return{};},
      async readThread(){
        if(kind==='busy')return envelope(snap('active',[turn('existing','inProgress',null,'still working','commentary')]));
        if(!sent)return envelope(snap('idle',[]));
        return envelope(snap('idle',[turn('new','completed',kind==='no-final'?'MARKER':'OTHER',
          'unrelated answer',kind==='no-final'?'commentary':'final')]));
      },
    };
    await assert.rejects(dispatchAndWait({codex,threadId:'mac-target',hostId,prompt:'MARKER\ntask',marker:'MARKER',
      timeoutMs:3,pollMs:1,...timer()}),error=>{
      assert.equal(error.code,kind==='busy'?'TARGET_BUSY_TIMEOUT':kind==='no-final'?'COMPLETED_WITHOUT_FINAL':kind==='send-unknown'?'TIMEOUT':'RESULT_TIMEOUT');
      assert.equal(error.delivery,kind==='busy'?'not_sent':kind==='send-unknown'?'unknown':'accepted');
      return true;
    });
    assert.equal(sent,kind==='busy'?0:1);
  });
});

test('local default mode keeps its original one-way path without reads or Claude result sends', async () => {
  const sends=[];
  const router=createBridgeRouter({config:{...config,codexTargetHostId:undefined,autoReply:false},
    codex:{async sendMessage(args){sends.push(args);return{};},async readThread(){assert.fail('local route read');}},
    claude:{async sendMessage(){assert.fail('local route auto reply');}},expectedClaudeFrom:'uds:expected'});
  await router.receive(frame('local','local task'));
  assert.equal(sends.length,1);
  assert.ok(!Object.hasOwn(sends[0],'hostId'));
});

test('failed Claude result transport is exposed once, and does not dispatch or replay the Codex work',async()=>{
  const returned=[], output=[], sends=[];
  const codex={async sendMessage(args){sends.push(args);return{};},async readThread(){
    return envelope(sends.length?snap('idle',[turn('new','completed',sends[0].prompt.split('\n')[0],'correct result')]):snap('idle',[]));
  }};
  const router=createBridgeRouter({config,codex,claude:{async sendMessage(args){returned.push(args);return{status:'unknown',reason:'TRANSPORT_TIMEOUT'};}},
    callbackUri:'uds:callback',expectedClaudeFrom:'uds:expected',output:x=>output.push(x)});
  await router.receive(frame('one','task'));
  assert.equal(sends.length,1);
  assert.equal(returned.length,1);
  assert.equal(output.at(-1).status,'unknown');
  assert.equal(output.at(-1).outcome,'completed');
});

async function fakeNativePipe(t, handler) {
  const pipePath=process.platform==='win32'?'\\\\.\\pipe\\bridge-route-'+randomUUID():join(tmpdir(),'bridge-route-'+randomUUID()+'.sock');
  const sockets=new Set();
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));
    let buffer=Buffer.alloc(0);
    socket.on('data',chunk=>{
      buffer=Buffer.concat([buffer,chunk]);
      while(buffer.length>=4){
        const length=buffer.readUInt32LE(0);if(buffer.length<length+4)return;
        const request=JSON.parse(buffer.subarray(4,length+4));buffer=buffer.subarray(length+4);
        const reply=result=>socket.write(encodeFrame({jsonrpc:'2.0',id:request.id,result}));
        const result=handler(request,reply);if(result!==undefined)reply(result);
      }
    });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(pipePath,resolve);});
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));});
  return pipePath;
}
async function runCli(args,input='') {
  const cli=fileURLToPath(new URL('../src/cli.mjs',import.meta.url));
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[cli,...args],{stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
    child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}));child.stdin.end(input);
  });
}

test('normal bind/request CLI works without Claude session or daemon and routes native owner/host plus exact final',async t=>{
  const dir=await fs.mkdtemp(join(tmpdir(),'bridge-request-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const requests=[];let prompt;
  const pipe=await fakeNativePipe(t,request=>{
    if(request.method==='tools/list')return{tools:[
      {name:'read_thread',namespace:'codex_app'},{name:'send_message_to_thread',namespace:'codex_app'}]};
    requests.push(request.params);
    if(request.params.tool==='send_message_to_thread'){prompt=request.params.arguments.prompt;return{success:true,contentItems:[{type:'inputText',text:'accepted'}]};}
    assert.ok(request.params.arguments.maxOutputCharsPerItem <= 20000);
    assert.ok(request.params.arguments.turnLimit <= 10);
    return envelope(prompt?snap('idle',[turn('fresh-work','completed',prompt.split('\n')[0],'CLI FINAL\n繁體中文','final_answer'),
      turn('baseline','completed',null,'OLD FINAL')]):snap('idle',[turn('baseline','completed',null,'OLD FINAL')]));
  });
  const configPath=join(dir,'config.json');
  const bound=await runCli(['bridge','bind','--owner-thread',owner,'--target-thread','mac-target','--target-host-id',hostId,
    '--pipe',pipe,'--config',configPath,'--result-timeout-ms','1000','--poll-ms','1']);
  assert.equal(bound.code,0,bound.stderr);
  assert.ok(!Object.hasOwn(JSON.parse(await fs.readFile(configPath,'utf8')),'claudeSessionId'));
  await fs.writeFile(configPath, '\uFEFF' + await fs.readFile(configPath,'utf8'), 'utf8');
  const result=await runCli(['bridge','request','--config',configPath],'test actual bytes\n$() "quotes"');
  assert.equal(result.code,0,result.stderr);
  const body=JSON.parse(result.stdout);
  assert.equal(body.status,'completed');
  assert.equal(body.text,'CLI FINAL\n繁體中文');
  assert.equal(body.hostId,hostId);assert.equal(body.turnId,'fresh-work');
  assert.ok(prompt.endsWith('test actual bytes\n$() "quotes"'));
  assert.ok(requests.every(x=>x.threadId===owner && x.arguments.hostId===hostId && x.arguments.threadId==='mac-target'));
  assert.ok(requests.filter(x=>x.tool==='read_thread').every(x=>x.arguments.includeOutputs===true));
  assert.equal(requests.filter(x=>x.tool==='send_message_to_thread').length,1);
  const serving=await runCli(['bridge','serve','--config',configPath]);
  assert.equal(serving.code,1);
  assert.match(serving.stderr,/serve requires a Claude session/);
});

test('baseline read failure is not a dispatched work, even when read transport reports unknown',async()=>{
  let sends=0;
  await assert.rejects(dispatchAndWait({codex:{async readThread(){throw Object.assign(new Error('read timeout'),{code:'TIMEOUT',delivery:'unknown'});},
    async sendMessage(){sends++;}},threadId:'target',prompt:'marker\ntask',marker:'marker'}),error=>error.delivery==='not_sent' && error.code==='TIMEOUT');
  assert.equal(sends,0);
});
test('normal read CLI passes same-chat cursor, and unsupported native limits are rejected locally',async t=>{
  const requests=[];
  const pipe=await fakeNativePipe(t,request=>{
    requests.push(request);
    if(request.method==='tools/list')return{tools:[{name:'read_thread',namespace:'codex_app'}]};
    assert.equal(request.params.threadId,owner);
    assert.deepEqual(request.params.arguments,{threadId:'older-chat',hostId,cursor:'opaque-older-page',turnLimit:10});
    return envelope(snap('idle',[turn('older-turn','completed',null,'older final','final_answer')]));
  });
  const base=['codex','read','--owner-thread',owner,'--pipe',pipe,'--target-thread','older-chat','--host-id',hostId];
  const read=await runCli([...base,'--limit','10','--cursor','opaque-older-page']);
  assert.equal(read.code,0,read.stderr);
  assert.equal(JSON.parse(read.stdout).status,'ok');
  const before=requests.length;
  const tooManyTurns=await runCli([...base,'--limit','11']);
  assert.equal(tooManyTurns.code,1);
  assert.equal(JSON.parse(tooManyTurns.stderr).code,'INVALID_INPUT');
  const tooManyThreads=await runCli(['codex','threads','--owner-thread',owner,'--pipe',pipe,'--limit','51']);
  assert.equal(tooManyThreads.code,1);
  assert.equal(JSON.parse(tooManyThreads.stderr).code,'INVALID_INPUT');
  assert.equal(requests.length,before,'Invalid limits must not even discover the native tool catalog');
  const adapter=new CodexAdapter({pipePath:pipe,ownerThreadId:owner});t.after(()=>adapter.close());
  assert.throws(()=>adapter.listThreads({limit:51}),error=>error.code==='INVALID_INPUT');
  assert.throws(()=>adapter.readThread({threadId:'older-chat',turnLimit:11}),error=>error.code==='INVALID_INPUT');
  assert.throws(()=>adapter.readThread({threadId:'older-chat',maxOutputCharsPerItem:20001}),error=>error.code==='INVALID_INPUT');
  assert.equal(requests.length,before);
});

test('native result waiting handles repeated envelopes and stable turn IDs while refusing incomplete or conflicting results', async t => {
  for (const kind of ['repeated-envelope', 'marker-no-longer-visible', 'new-marker-turn', 'incomplete-final',
    'conflicting-envelope', 'wrong-baseline-target', 'wrong-result-target']) {
    await t.test(kind, async t => {
      let sends = 0, resultReads = 0;
      const marker = 'NATIVE_WAIT_REQUEST';
      const pipe = await fakeNativePipe(t, request => {
        if (request.method === 'tools/list') return { tools: [
          { name: 'read_thread', namespace: 'codex_app' }, { name: 'send_message_to_thread', namespace: 'codex_app' }] };
        assert.equal(request.params.threadId, owner);
        assert.equal(request.params.arguments.hostId, hostId);
        if (request.params.tool === 'send_message_to_thread') {
          sends++;
          assert.equal(request.params.arguments.prompt, marker + '\nactual task');
          return { success: true, contentItems: [] };
        }
        let snapshot;
        if (!sends) snapshot = snap('idle', []);
        else {
          resultReads++;
          snapshot = snap('idle', [turn('own-turn', 'completed', marker, 'FULL FINAL')]);
          if (['marker-no-longer-visible', 'new-marker-turn'].includes(kind)) {
            snapshot = resultReads === 1 ? snap('active', [turn('own-turn', 'inProgress', marker, 'working', 'commentary')])
              : snap('idle', [turn(kind === 'new-marker-turn' ? 'other-turn' : 'own-turn', 'completed',
                kind === 'new-marker-turn' ? marker : null, 'FULL FINAL')]);
          }
          if (kind === 'incomplete-final') snapshot.turns[0].items.push({ type: 'agentMessage', phase: 'final' });
        }
        snapshot.thread.id = kind === 'wrong-baseline-target' || (kind === 'wrong-result-target' && sends)
          ? 'different-chat' : 'mac-target';
        if (kind === 'repeated-envelope' || (kind === 'conflicting-envelope' && sends)) {
          const second = kind === 'repeated-envelope' ? snapshot : snap('idle', []);
          return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({
            structuredContent: snapshot, content: [{ type: 'text', text: JSON.stringify(second) }],
          }) }] };
        }
        return envelope(snapshot);
      });
      const codex = new CodexAdapter({ pipePath: pipe, ownerThreadId: owner, timeoutMs: 1000 });
      t.after(() => codex.close());
      const request = dispatchAndWait({ codex, threadId: 'mac-target', hostId, prompt: marker + '\nactual task', marker,
        timeoutMs: 20, pollMs: 1, ...timer() });
      if (['repeated-envelope', 'marker-no-longer-visible'].includes(kind)) {
        assert.deepEqual(await request, { status: 'completed', turnId: 'own-turn', text: 'FULL FINAL' });
      } else {
        const codes = { 'new-marker-turn': 'AMBIGUOUS_WORK_TURN', 'incomplete-final': 'COMPLETED_WITHOUT_FINAL',
          'conflicting-envelope': 'INVALID_THREAD_SNAPSHOT', 'wrong-baseline-target': 'TARGET_THREAD_MISMATCH',
          'wrong-result-target': 'TARGET_THREAD_MISMATCH' };
        await assert.rejects(request, error => error.code === codes[kind] &&
          error.delivery === (kind === 'wrong-baseline-target' ? 'not_sent' : 'accepted'));
      }
      assert.equal(sends, kind === 'wrong-baseline-target' ? 0 : 1, 'No uncertain request is resent');
    });
  }
});

test('normal serve stops authenticated new messages before draining previously queued work and cleans its own resources', { timeout: 10000 }, async t => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'bridge-stop-'));
  const registry = join(dir, 'registry'), configPath = join(dir, 'config.json'), statePath = join(dir, 'state.json');
  await fs.mkdir(registry);
  const sessionId = randomUUID();
  const peer = process.platform === 'win32' ? '\\\\.\\pipe\\bridge-stop-peer-' + randomUUID() : join(dir, 'peer.sock');
  await fs.writeFile(join(registry, process.pid + '.json'), JSON.stringify({ pid: process.pid, sessionId, messagingSocketPath: peer }));
  let child, callback, releaseFirst;
  let exited;
  t.after(async () => {
    releaseFirst?.(); callback?.destroy();
    child?.kill();
    if (exited) await exited;
    await fs.rm(dir, { recursive: true, force: true });
  });
  const dispatched = [];
  let firstStarted;
  const first = new Promise(resolve => { firstStarted = resolve; });
  const pipe = await fakeNativePipe(t, (request, reply) => {
    if (request.method === 'tools/list') return { tools: ['list_threads', 'send_message_to_thread'].map(name => ({ name, namespace: 'codex_app' })) };
    assert.equal(request.params.threadId, owner);
    if (request.params.tool === 'list_threads') return { success: true, contentItems: [] };
    assert.equal(request.params.tool, 'send_message_to_thread');
    assert.equal(request.params.arguments.threadId, 'isolated-target');
    dispatched.push(request.params.arguments.prompt.split('\n').at(-1));
    if (dispatched.length === 1) {
      releaseFirst = () => { releaseFirst = undefined; reply({ success: true, contentItems: [] }); };
      firstStarted();
      return;
    }
    return { success: true, contentItems: [] };
  });
  await fs.writeFile(configPath, JSON.stringify({ codexOwnerThreadId: owner, codexTargetThreadId: 'isolated-target',
    codexPipePath: pipe, claudeSessionId: sessionId, claudeRegistryDir: registry, autoReply: false }));
  const moduleUrl = new URL('../src/cli.mjs', import.meta.url).href;
  // IPC only delivers the stop signal on Windows; the normal CLI, serve, receiver and router run unchanged.
  const bootstrap = "process.on('message',()=>{process.emit('SIGINT');process.send('stopped');});" +
    'const {main}=await import(' + JSON.stringify(moduleUrl) + ');process.exitCode=await main(process.argv.slice(1));process.disconnect();';
  child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap, '--', 'bridge', 'serve', '--config', configPath, '--state', statePath],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const lines = createInterface({ input: child.stdout });
  const ready = await new Promise(resolve => lines.on('line', line => {
    const value = JSON.parse(line);
    if (value.status === 'ready') resolve(value);
  }));
  const callbackPath = decodeURIComponent(ready.callbackUri.slice(4));
  const callbackKey = keyFileFor(child.pid, callbackPath, registry);
  const { peerToken } = JSON.parse(await fs.readFile(callbackKey, 'utf8'));
  callback = net.createConnection(callbackPath); callback.on('error', () => {});
  const closedCallback = new Promise(resolve => callback.once('close', () => resolve(true)));
  await new Promise(resolve => callback.once('connect', resolve));
  callback.write(JSON.stringify({ type: 'auth', token: peerToken }) + '\n');
  const send = (id, content) => callback.write(JSON.stringify({ type: 'user', from: socketUri(peer), msg_id: id,
    message: { role: 'user', content } }) + '\n');
  send('first', 'first-before-stop'); await first;
  send('second', 'queued-before-stop');
  // A receipt on the same socket proves the receiver already queued the preceding message.
  callback.write(JSON.stringify({ type: 'control', action: 'peer_message_status', from: socketUri(peer),
    status: 'received', orig_msg_id: 'queue-barrier' }) + '\n');
  const eventsPath = join(dir, 'events.jsonl');
  for (let n = 0; ; n++) {
    if ((await fs.readFile(eventsPath, 'utf8')).includes('queue-barrier')) break;
    assert.ok(n < 100, 'Receiver did not process the queued second message');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const stopped = new Promise(resolve => child.once('message', resolve));
  child.send('stop'); await stopped;
  send('third', 'received-after-stop');
  let closeTimer;
  const stoppedReceiving = await Promise.race([closedCallback,
    new Promise(resolve => { closeTimer = setTimeout(() => resolve(false), 1000); })]);
  clearTimeout(closeTimer);
  releaseFirst();
  assert.equal(await exited, 0, stderr);
  const records = (await fs.readFile(eventsPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(stoppedReceiving, true, 'Stopping must close authenticated callbacks before waiting for existing work');
  assert.deepEqual(dispatched, ['first-before-stop', 'queued-before-stop']);
  assert.ok(!records.some(record => record.event === 'claude_message_received' && record.msgId === 'third'));
  assert.equal(records.filter(record => record.event === 'codex_native_accepted').length, 2);
  await assert.rejects(fs.stat(statePath), error => error.code === 'ENOENT');
  assert.deepEqual(await fs.readdir(registry), [process.pid + '.json'], 'Only the bridge callback key is removed');
  assert.equal(stderr, '');
});
