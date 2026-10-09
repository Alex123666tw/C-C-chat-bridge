import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { promises as fs } from 'node:fs';
import { encodeFrame } from '../src/codex.mjs';

async function cli(args) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), ...args], { stdio: ['ignore','pipe','pipe'] });
  let stdout='', stderr='';
  child.stdout.on('data', value => stdout += value);
  child.stderr.on('data', value => stderr += value);
  const exitCode = await new Promise(resolve => child.once('close', resolve));
  return { exitCode, stdout, stderr };
}

test('subcommand help prints usage without reading config or sending messages', async () => {
  for (const command of ['bridge','claude','codex']) {
    const result = await cli([command, '--help']);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Local chat bridge/);
    assert.equal(result.stderr, '');
  }
});

test('Claude CLI rejects misspelled options and failed sends exit nonzero', async () => {
  const typo = await cli(['claude','sessions','--regsitry-dir','unused']);
  assert.equal(typo.exitCode, 1);
  assert.match(typo.stderr, /Unknown Claude option/);
  const failed = await cli(['claude','send','--session-id',randomUUID(),'--registry-dir',join(tmpdir(),'absent-registry-'+randomUUID())]);
  assert.equal(failed.exitCode, 1);
  assert.equal(JSON.parse(failed.stdout).status, 'failed');
});

test('daemon startup failure cleans its callback key and exits without leaving a receiver', async t => {
  const directory=await fs.mkdtemp(join(tmpdir(),'bridge-startup-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const registry=join(directory,'registry');
  const badState=join(directory,'state-directory');
  await fs.mkdir(registry);
  await fs.mkdir(badState);
  const sessionId=randomUUID();
  const peer=process.platform==='win32'?'\\\\.\\pipe\\startup-peer-'+randomUUID():join(directory,'peer.sock');
  await fs.writeFile(join(registry,process.pid+'.json'),JSON.stringify({pid:process.pid,sessionId,messagingSocketPath:peer}));
  const pipe=process.platform==='win32'?'\\\\.\\pipe\\startup-codex-'+randomUUID():join(directory,'codex.sock');
  const sockets=new Set();
  const server=net.createServer(socket=>{
    sockets.add(socket);
    socket.on('error',()=>{});
    socket.on('close',()=>sockets.delete(socket));
    let buffered=Buffer.alloc(0);
    socket.on('data',chunk=>{
      buffered=Buffer.concat([buffered,chunk]);
      while(buffered.length>=4) {
        const size=buffered.readUInt32LE(0);
        if(buffered.length<size+4)return;
        const request=JSON.parse(buffered.subarray(4,size+4));
        buffered=buffered.subarray(size+4);
        const result=request.method==='tools/list'?{tools:[{name:'list_threads',namespace:'codex_app'}]}:{success:true,contentItems:[{type:'inputText',text:'{}'}]};
        socket.write(encodeFrame({jsonrpc:'2.0',id:request.id,result}));
      }
    });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(pipe,resolve);});
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));});
  const config=join(directory,'config.json');
  await fs.writeFile(config,JSON.stringify({codexOwnerThreadId:'owner',codexTargetThreadId:'target',codexPipePath:pipe,claudeSessionId:sessionId,claudeRegistryDir:registry}));
  const result=await cli(['bridge','serve','--config',config,'--state',badState]);
  assert.equal(result.exitCode,1);
  assert.equal(JSON.parse(result.stderr).status,'failed');
  assert.deepEqual(await fs.readdir(registry),[process.pid+'.json']);
  assert.equal((await fs.stat(badState)).isDirectory(),true);
});
