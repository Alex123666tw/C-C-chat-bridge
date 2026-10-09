import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { CodexAdapter, NativePipeClient, encodeFrame, MAX_FRAME_BYTES } from '../src/codex.mjs';

const catalog = { tools: ['list_threads', 'read_thread', 'send_message_to_thread'].map(name => ({ name, namespace: 'codex_app', inputSchema: {} })) };
const ok = { success: true, contentItems: [{ type: 'inputText', text: '{"received":true}' }] };

async function fakePipe(t, handler) {
  const pipePath = process.platform === 'win32' ? '\\\\.\\pipe\\chat-bridge-test-' + randomUUID() : join(tmpdir(), 'chat-bridge-' + randomUUID() + '.sock');
  const sockets = new Set();
  const requests = [];
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    let buffered = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const size = buffered.readUInt32LE(0);
        if (buffered.length < size + 4) return;
        const request = JSON.parse(buffered.subarray(4, size + 4));
        buffered = buffered.subarray(size + 4);
        requests.push(request);
        handler(request, socket);
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipePath, resolve); });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { pipePath, requests };
}
function reply(socket, request, result) { socket.write(encodeFrame({ jsonrpc: '2.0', id: request.id, result })); }

test('native tool call survives fragmented frames and keeps source separate from destination', async t => {
  const endpoint = await fakePipe(t, (request, socket) => {
    if (request.method === 'tools/list') {
      assert.deepEqual(request.params, { threadStartKind: 'all' });
      const frame = encodeFrame({ jsonrpc: '2.0', id: request.id, result: catalog });
      socket.write(frame.subarray(0, 2));
      setTimeout(() => { if (!socket.destroyed) socket.write(frame.subarray(2, 11)); }, 5);
      setTimeout(() => { if (!socket.destroyed) socket.write(frame.subarray(11)); }, 10);
    } else reply(socket, request, ok);
  });
  const adapter = new CodexAdapter({ pipePath: endpoint.pipePath, ownerThreadId: 'authorized-owner', timeoutMs: 1000 });
  t.after(() => adapter.close());
  assert.deepEqual(await adapter.sendMessage({ threadId: 'existing-target', prompt: '繁體中文\nsecond line "quote" $()' }), ok);
  const params = endpoint.requests[1].params;
  assert.equal(params.threadId, 'authorized-owner');
  assert.equal(params.callerSource, 'codex');
  assert.equal(params.namespace, 'codex_app');
  assert.equal(params.tool, 'send_message_to_thread');
  assert.deepEqual(params.arguments, { threadId: 'existing-target', prompt: '繁體中文\nsecond line "quote" $()' });
  assert.match(params.callId, /^mcp-call-/);
  assert.match(params.turnId, /^mcp-turn-/);
  assert.ok(!Object.hasOwn(params.arguments, 'model'));
  assert.ok(!Object.hasOwn(params.arguments, 'thinking'));
});

test('CLI stdin retains message bytes and invalid destination sends nothing', async t => {
  const endpoint = await fakePipe(t, (request, socket) => reply(socket, request, request.method === 'tools/list' ? catalog : ok));
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  async function run(args, input) {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => stdout += chunk);
      child.stderr.on('data', chunk => stderr += chunk);
      child.once('error', reject);
      child.once('close', code => resolve({ code, stdout, stderr }));
      child.stdin.end(input);
    });
  }
  const message = '橋接測試\nquotes: "hello"; shell: $()\n';
  const valid = await run(['codex', 'send', '--owner-thread', 'owner', '--pipe', endpoint.pipePath, '--target-thread', 'target'], message);
  assert.equal(valid.code, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).status, 'accepted');
  const actualMessage = endpoint.requests[1].params.arguments.prompt;
  assert.match(actualMessage, /^\[跨模型橋接訊息｜外部CLI｜/);
  assert.equal(actualMessage.slice(actualMessage.indexOf('\n') + 1), message);
  const invalid = await run(['codex', 'send', '--owner-thread', 'owner', '--pipe', endpoint.pipePath], message);
  assert.equal(invalid.code, 1);
  assert.equal(JSON.parse(invalid.stderr).delivery, 'not_sent');
  assert.equal(endpoint.requests.length, 2);
  const noOwner = await run(['codex', 'tools', '--pipe', endpoint.pipePath], '');
  assert.equal(noOwner.code, 1);
  assert.equal(endpoint.requests.length, 2);
});

test('RPC and tool rejections are errors, never successful sends', async t => {
  for (const kind of ['rpc', 'tool']) {
    await t.test(kind, async t => {
      const endpoint = await fakePipe(t, (request, socket) => {
        if (request.method === 'tools/list') return reply(socket, request, catalog);
        if (kind === 'rpc') socket.write(encodeFrame({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'source rejected' } }));
        else reply(socket, request, { success: false, contentItems: [{ type: 'inputText', text: 'target rejected' }] });
      });
      const adapter = new CodexAdapter({ pipePath: endpoint.pipePath, ownerThreadId: 'owner', timeoutMs: 1000 });
      t.after(() => adapter.close());
      await assert.rejects(adapter.sendMessage({ threadId: 'target', prompt: 'hi' }), error => error.delivery === 'failed' && /rejected/.test(error.message));
      assert.equal(endpoint.requests.filter(request => request.method === 'tools/call').length, 1);
    });
  }
});

test('post-send timeout is unknown and does not retry', async t => {
  const endpoint = await fakePipe(t, (request, socket) => {
    if (request.method === 'tools/list') reply(socket, request, catalog);
  });
  const adapter = new CodexAdapter({ pipePath: endpoint.pipePath, ownerThreadId: 'owner', timeoutMs: 100 });
  t.after(() => adapter.close());
  await assert.rejects(adapter.sendMessage({ threadId: 'target', prompt: 'hi' }), error => error.code === 'TIMEOUT' && error.delivery === 'unknown');
  assert.equal(endpoint.requests.filter(request => request.method === 'tools/call').length, 1);
});

test('oversized native frames stop the request without interpreting success', async t => {
  const endpoint = await fakePipe(t, (_request, socket) => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_FRAME_BYTES + 1);
    socket.write(header);
  });
  const client = new NativePipeClient(endpoint.pipePath, { timeoutMs: 1000 });
  t.after(() => client.close());
  await assert.rejects(client.request('tools/list', { threadStartKind: 'all' }), error => error.code === 'INVALID_RESPONSE' && error.delivery === 'unknown');
  assert.throws(() => encodeFrame({ message: 'x'.repeat(MAX_FRAME_BYTES) }), error => error.code === 'FRAME_TOO_LARGE');
});

test('ambiguous tool catalogs prevent dispatch; malformed replies remain unknown instead of accepted or failed', async t => {
  for (const kind of ['catalog-collision', 'rpc-conflict', 'invalid-content']) {
    await t.test(kind, async t => {
      const endpoint = await fakePipe(t, (request, socket) => {
        if (request.method === 'tools/list') return reply(socket, request, kind === 'catalog-collision'
          ? { tools: [...catalog.tools, { name: 'send_message_to_thread', namespace: 'other_provider' }] } : catalog);
        if (kind === 'rpc-conflict') socket.write(encodeFrame({ jsonrpc: '2.0', id: request.id,
          result: ok, error: { code: -32603, message: 'conflicting outcome' } }));
        else reply(socket, request, { success: true, contentItems: [null] });
      });
      const adapter = new CodexAdapter({ pipePath: endpoint.pipePath, ownerThreadId: 'owner', timeoutMs: 1000 });
      t.after(() => adapter.close());
      await assert.rejects(adapter.sendMessage({ threadId: 'target', prompt: 'one task' }), error =>
        error.code === 'INVALID_RESPONSE' && error.delivery === (kind === 'catalog-collision' ? 'not_sent' : 'unknown'));
      assert.equal(endpoint.requests.filter(request => request.method === 'tools/call').length, kind === 'catalog-collision' ? 0 : 1);
    });
  }
});

test('native timeout cannot overflow into an immediate timer', () => {
  assert.throws(() => new NativePipeClient('unused-pipe', { timeoutMs: 2147483648 }), error => error.code === 'INVALID_INPUT');
});
