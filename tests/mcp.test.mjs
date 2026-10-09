import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFile, unlink, mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { keyFileFor } from '../src/claude.mjs';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { encodeFrame } from '../src/codex.mjs';

const objectSchema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = { type: 'string', minLength: 1 };
const positive = { type: 'integer', minimum: 1 };
const nativeTools = [
  ['list_threads', objectSchema({ limit: { ...positive, maximum: 50 } })],
  ['read_thread', objectSchema({ threadId: str, hostId: str, cursor: str, turnLimit: { ...positive, maximum: 10 }, includeOutputs: { type: 'boolean' }, maxOutputCharsPerItem: { ...positive, maximum: 20000 } }, ['threadId'])],
  ['list_archived_threads', objectSchema({ cursor: str, hostId: str, limit: { ...positive, maximum: 50 }, source: { type: 'string', enum: ['codex', 'chatgpt'] } })],
  ['wait_threads', objectSchema({ targets: { type: 'array' }, timeoutMs: { type: 'integer', minimum: 0 } }, ['targets'])],
  ['send_message_to_thread', objectSchema({ threadId: str, hostId: str, prompt: str, model: str, thinking: str }, ['threadId', 'prompt'])],
  ['get_usage_limits', objectSchema()], ['create_thread', objectSchema()], ['capture_screen_context', objectSchema()],
].map(([name, inputSchema]) => ({ name, namespace: 'codex_app', description: 'Native description for ' + name, inputSchema }));
const catalog = { tools: nativeTools };
const fullNative = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({
  pinnedThreads: [{ threadId: 'cloud-chat', kind: 'chatgpt' }], threads: [{ threadId: 'mac-chat', hostId: 'remote-mac' }],
  opaqueNativeField: { exact: '保留全部\n完整原工具結果' }, nextCursor: 'native-next',
}) }], otherNativeField: { untouched: true } };
const nativeResult = value => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] });
const reply = (socket, request, value) => socket.write(encodeFrame({ jsonrpc: '2.0', id: request.id, result: value }));
async function fakeNativePipe(t, handler) {
  const pipePath = process.platform === 'win32' ? '\\\\.\\pipe\\chat-mcp-test-' + randomUUID() : join(tmpdir(), 'chat-mcp-' + randomUUID() + '.sock');
  const sockets = new Set(), requests = [];
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
        if (request.method === 'tools/list') reply(socket, request, catalog);
        else handler(request, socket);
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipePath, resolve); });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { pipePath, requests };
}
async function consumer(t, endpoint, { cli = false, provider = false, initVersion = '2025-11-25', configPath, providerOptions } = {}) {
  const moduleUrl = new URL('../src/mcp-server.mjs', import.meta.url).href;
  // This remains an actual child stdio consumer. The injection only replaces Claude local discovery.
  const bootstrap = 'const m=await import(' + JSON.stringify(moduleUrl) + ');const config=await m.loadMcpConfig(process.argv.slice(1));await m.serveMcp(config,{providers:' +
    (providerOptions ? '[(await import(' + JSON.stringify(new URL('../src/claude-chats.mjs', import.meta.url).href) + ')).createClaudeChatProvider(' + JSON.stringify(providerOptions) + ')]' : provider ? "[{tools:async()=>[{name:'claude_read_chat',description:'Fixture Claude chat',inputSchema:{type:'object',properties:{chatId:{type:'string',minLength:1}},required:['chatId'],additionalProperties:false}}],call:async(name,args)=>args.chatId==='failed'?{status:'failed',delivery:'not_sent',reason:'fixture failure'}:args.chatId==='unknown'?{status:'unknown',delivery:'unknown',reason:'fixture uncertainty'}:({name,args,full:'Claude完整對話'})}]" : '[]') + '});';
  const args = configPath ? ['--config', configPath] : ['--owner-thread', 'authorized-owner', '--pipe', endpoint.pipePath, '--target-thread', 'default-target', '--host-id', 'remote-default', '--result-timeout-ms', '80', '--poll-ms', '1'];
  const child = spawn(process.execPath, cli ? [fileURLToPath(new URL('../src/mcp-server.mjs', import.meta.url)), ...args] : ['--input-type=module', '-e', bootstrap, '--', ...args],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CODEX_APP_TOOLS_PIPE_PATH: '', CODEX_OWNER_THREAD_ID: '' } });
  let stderr = '';
  const messages = [], events = new EventEmitter(), waiters = new Map();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const value = JSON.parse(line); // Any stdout diagnostic fails the consumer.
    messages.push(value);
    if (waiters.has(value.id)) { waiters.get(value.id)(value); waiters.delete(value.id); }
    events.emit('message', value);
  });
  child.stderr.on('data', data => stderr += data.toString());
  const closed = new Promise(resolve => child.once('close', code => resolve(code)));
  t.after(async () => {
    child.stdin.end();
    await Promise.race([closed, new Promise(resolve => setTimeout(() => { child.kill(); resolve(); }, 1000).unref())]);
  });
  let id = 0;
  function request(method, params, requestId = ++id) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(requestId); reject(new Error('stdio response timeout: ' + method + ' stderr=' + stderr)); }, 3000);
      waiters.set(requestId, value => { clearTimeout(timer); resolve(value); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, ...(params === undefined ? {} : { params }) }) + '\n');
    });
  }
  const notification = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }) + '\n');
  const initialize = async () => {
    const response = await request('initialize', { protocolVersion: initVersion, capabilities: {}, clientInfo: { name: 'stdio-test-consumer', version: '1' } });
    notification('notifications/initialized');
    return response;
  };
  return { child, request, notification, initialize, messages, events, closed, stderr: () => stderr };
}

test('stdio lifecycle, negotiation, native chat schemas, notifications and protocol errors', async t => {
  const endpoint = await fakeNativePipe(t, (request, socket) => reply(socket, request, fullNative));
  const client = await consumer(t, endpoint, { initVersion: 'future-version' });
  assert.equal((await client.request('tools/list')).error.code, -32000);
  const initialized = await client.initialize();
  assert.equal(initialized.result.protocolVersion, '2025-11-25');
  assert.deepEqual(initialized.result.capabilities, { tools: { listChanged: false } });
  const listed = (await client.request('tools/list')).result.tools;
  assert.deepEqual(listed.map(tool => tool.name).sort(), [
    'codex_list_threads', 'codex_read_thread', 'codex_list_archived_threads', 'codex_wait_threads', 'codex_send_message_to_thread', 'codex_request',
  ].sort());
  for (const original of nativeTools.slice(0, 5)) {
    const exposed = listed.find(tool => tool.name === 'codex_' + original.name);
    assert.deepEqual(exposed.inputSchema, original.inputSchema);
    assert.ok(exposed.description.startsWith(original.description));
  }
  client.notification('notifications/unknown', { ignored: true });
  const before = client.messages.length;
  assert.deepEqual((await client.request('ping', undefined, 'text-request-id')).result, {});
  assert.equal(client.messages.length, before + 1);
  assert.equal((await client.request('unknown')).error.code, -32601);
  assert.equal((await client.request('tools/call', { name: 'codex_create_thread', arguments: {} })).error.code, -32602);
  assert.equal((await client.request('tools/call', { name: 'codex_native_catalog', arguments: {} })).error.code, -32602);
  assert.equal((await client.request('tools/call', { name: 'codex_list_threads', arguments: [] })).error.code, -32602);
  const parsed = new Promise(resolve => client.events.once('message', resolve));
  client.child.stdin.write('invalid JSON\n');
  assert.deepEqual(await parsed, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON message' } });
  assert.equal(endpoint.requests.filter(item => item.method === 'tools/call').length, 0);
  assert.equal(client.stderr(), '');
});

test('full native responses, host/cursor and wait targets travel unchanged; native bounds are retained', async t => {
  const endpoint = await fakeNativePipe(t, (request, socket) => reply(socket, request, fullNative));
  const client = await consumer(t, endpoint);
  await client.initialize();
  const calls = [
    ['codex_list_threads', { limit: 50 }],
    ['codex_read_thread', { threadId: 'chatgpt-chat', hostId: 'remote-mac', cursor: 'exact-cursor', turnLimit: 10, includeOutputs: true, maxOutputCharsPerItem: 20000 }],
    ['codex_list_archived_threads', { cursor: 'archive-cursor', source: 'codex', hostId: 'remote-mac', limit: 50 }],
    ['codex_list_archived_threads', { source: 'chatgpt', cursor: 'cloud-cursor' }],
    ['codex_wait_threads', { targets: [{ threadId: 'target', hostId: 'remote-mac', afterCursor: 'wait-cursor' }], timeoutMs: 0 }],
  ];
  for (const [name, args] of calls) {
    const response = await client.request('tools/call', { name, arguments: args });
    assert.deepEqual(response.result.structuredContent, fullNative);
    assert.deepEqual(JSON.parse(response.result.content[0].text), fullNative);
    const native = endpoint.requests.at(-1).params;
    assert.equal(native.threadId, 'authorized-owner');
    assert.deepEqual(native.arguments, args);
  }
  const before = endpoint.requests.length;
  for (const [name, args] of [
    ['codex_list_threads', { limit: 51 }], ['codex_list_threads', { cursor: 'invented-cursor' }],
    ['codex_read_thread', { threadId: 'target', maxOutputCharsPerItem: 20001 }],
  ]) assert.equal((await client.request('tools/call', { name, arguments: args })).result.isError, true);
  assert.equal(endpoint.requests.length, before);
});

test('send explicitly attributes MCP and owner, preserves prompt bytes and returns accepted only', async t => {
  const endpoint = await fakeNativePipe(t, (request, socket) => reply(socket, request, fullNative));
  const client = await consumer(t, endpoint);
  await client.initialize();
  const prompt = '繁體中文\n引號 "hello" 與 $()\n';
  const response = await client.request('tools/call', { name: 'codex_send_message_to_thread',
    arguments: { threadId: 'mac-destination', hostId: 'remote-mac', prompt, model: 'native-model', thinking: 'high' } });
  assert.equal(response.result.structuredContent.status, 'accepted');
  assert.deepEqual(response.result.structuredContent.native, fullNative);
  const native = endpoint.requests.at(-1).params;
  assert.equal(native.threadId, 'authorized-owner');
  assert.equal(native.arguments.threadId, 'mac-destination');
  assert.equal(native.arguments.hostId, 'remote-mac');
  assert.equal(native.arguments.model, 'native-model');
  assert.equal(native.arguments.thinking, 'high');
  assert.match(native.arguments.prompt, /^\[跨模型橋接工作｜外部 MCP｜來源 Codex owner authorized-owner｜訊息 /);
  assert.equal(native.arguments.prompt.slice(native.arguments.prompt.indexOf('\n') + 1), prompt);
  assert.equal(endpoint.requests.filter(item => item.params?.tool === 'send_message_to_thread').length, 1);
});

test('request uses configured remote target and returns only marker-bound new final, never the old or unrelated answer', async t => {
  let sentPrompt, reads = 0;
  const old = { id: 'old-turn', status: 'completed', items: [{ type: 'agentMessage', phase: 'final', text: 'OLD_UNRELATED' }] };
  const final = '本次完整 final\n保留原文與換行。';
  const endpoint = await fakeNativePipe(t, (request, socket) => {
    if (request.params.tool === 'send_message_to_thread') { sentPrompt = request.params.arguments.prompt; return reply(socket, request, fullNative); }
    assert.equal(request.params.tool, 'read_thread');
    assert.ok(request.params.arguments.maxOutputCharsPerItem <= 20000, 'request relay must respect native read schema');
    reads++;
    const own = sentPrompt ? { id: 'new-own-turn', status: 'completed', items: [
      { type: 'functionCallOutput', name: 'send_message_to_thread', namespace: 'codex_app', output: { text: sentPrompt } },
      { type: 'agentMessage', phase: 'final', text: final },
    ] } : undefined;
    reply(socket, request, nativeResult({ thread: { status: { type: 'idle' } },
      turns: own ? [own, { ...old, id: 'new-unrelated-turn' }, old] : [old] }));
  });
  const client = await consumer(t, endpoint);
  await client.initialize();
  const response = await client.request('tools/call', { name: 'codex_request', arguments: { prompt: '取得本次結果' } });
  assert.equal(response.result.structuredContent.status, 'completed');
  assert.equal(response.result.structuredContent.text, final);
  assert.equal(response.result.structuredContent.turnId, 'new-own-turn');
  assert.equal(response.result.structuredContent.threadId, 'default-target');
  assert.equal(response.result.structuredContent.hostId, 'remote-default');
  assert.equal(reads, 2);
  for (const item of endpoint.requests.filter(item => item.params?.tool)) {
    assert.equal(item.params.arguments.threadId, 'default-target');
    assert.equal(item.params.arguments.hostId, 'remote-default');
  }
});

test('native failures and missing final are tool errors; accepted unknown is not automatically resent', async t => {
  let mode = 'reject', sentPrompt;
  const endpoint = await fakeNativePipe(t, (request, socket) => {
    if (mode === 'reject') return reply(socket, request, { success: false, contentItems: [{ type: 'inputText', text: 'native rejected' }] });
    if (request.params.tool === 'send_message_to_thread') { sentPrompt = request.params.arguments.prompt; return reply(socket, request, fullNative); }
    reply(socket, request, nativeResult({ thread: { status: { type: sentPrompt ? 'active' : 'idle' } }, turns: sentPrompt ? [{
      id: 'own-incomplete', status: 'inProgress', items: [{ type: 'functionCallOutput', name: 'send_message_to_thread', namespace: 'codex_app', output: { text: sentPrompt } }],
    }] : [] }));
  });
  const client = await consumer(t, endpoint);
  await client.initialize();
  const rejected = await client.request('tools/call', { name: 'codex_read_thread', arguments: { threadId: 'target' } });
  assert.equal(rejected.result.isError, true);
  assert.equal(rejected.result.structuredContent.delivery, 'failed');
  assert.equal(rejected.result.structuredContent.code, 'TOOL_FAILED');
  mode = 'unfinished';
  const unknown = await client.request('tools/call', { name: 'codex_request', arguments: { prompt: 'no final', timeoutMs: 30, pollMs: 1 } });
  assert.equal(unknown.result.isError, true);
  assert.equal(unknown.result.structuredContent.status, 'unknown');
  assert.equal(unknown.result.structuredContent.delivery, 'accepted');
  assert.equal(unknown.result.structuredContent.code, 'RESULT_TIMEOUT');
  assert.equal(endpoint.requests.filter(item => item.params?.tool === 'send_message_to_thread').length, 1);
});

test('provider injection exposes the other chat view over the same real stdio protocol', async t => {
  const endpoint = await fakeNativePipe(t, (request, socket) => reply(socket, request, fullNative));
  const client = await consumer(t, endpoint, { provider: true, initVersion: '2024-11-05' });
  assert.equal((await client.initialize()).result.protocolVersion, '2024-11-05');
  const listed = await client.request('tools/list');
  assert.ok(listed.result.tools.some(tool => tool.name === 'claude_read_chat'));
  const response = await client.request('tools/call', { name: 'claude_read_chat', arguments: { chatId: 'claude-session' } });
  assert.deepEqual(response.result.structuredContent, { name: 'claude_read_chat', args: { chatId: 'claude-session' }, full: 'Claude完整對話' });
  for (const status of ['failed', 'unknown']) {
    const failed = await client.request('tools/call', { name: 'claude_read_chat', arguments: { chatId: status } });
    assert.equal(failed.result.isError, true);
    assert.equal(failed.result.structuredContent.status, status);
  }
  assert.equal(endpoint.requests.filter(item => item.method === 'tools/call').length, 0);
});

test('actual executable starts from config without a Claude session, loads both chat providers and exits cleanly on EOF', async t => {
  const endpoint = await fakeNativePipe(t, (request, socket) => reply(socket, request, fullNative));
  const configPath = join(tmpdir(), 'chat-mcp-config-' + randomUUID() + '.json');
  await writeFile(configPath, '\uFEFF' + JSON.stringify({ codexOwnerThreadId: 'authorized-owner', codexPipePath: endpoint.pipePath,
    codexTargetThreadId: 'default-target', codexTargetHostId: 'remote-default' }), 'utf8');
  t.after(() => unlink(configPath));
  const client = await consumer(t, endpoint, { cli: true, configPath });
  await client.initialize();
  const response = await client.request('tools/list');
  assert.ok(response.result, JSON.stringify(response));
  const listed = response.result.tools;
  assert.ok(listed.some(tool => tool.name === 'codex_read_thread'));
  assert.ok(listed.some(tool => tool.name === 'claude_list_chats'));
  assert.ok(listed.some(tool => tool.name === 'claude_read_chat'));
  assert.ok(listed.some(tool => tool.name === 'claude_send_message'));
  client.child.stdin.end();
  assert.equal(await client.closed, 0);
  assert.equal(client.stderr(), '');
  assert.equal(endpoint.requests.filter(item => item.method === 'tools/call').length, 0);
});

test('EOF during a real Claude provider send drains creation and removes only its own callback resources', async t => {
  const endpoint = await fakeNativePipe(t, (request, socket) => reply(socket, request, fullNative));
  const root = await mkdtemp(join(tmpdir(), 'chat-mcp-claude-'));
  const registryDir = join(root, 'registry'), projectsDir = join(root, 'projects');
  await mkdir(registryDir); await mkdir(projectsDir);
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionId = randomUUID();
  const socketPath = process.platform === 'win32' ? '\\\\.\\pipe\\LOCAL\\cc-msg-' + randomBytes(16).toString('hex') : join(root, 'claude.sock');
  const token = randomBytes(16).toString('hex');
  await writeFile(join(registryDir, process.pid + '.json'), JSON.stringify({ pid: process.pid, sessionId, messagingSocketPath: socketPath }), 'utf8');
  await writeFile(keyFileFor(process.pid, socketPath, registryDir), JSON.stringify({ peerToken: token }), 'utf8');
  const before = (await readdir(registryDir)).sort();
  const frames = [], sockets = new Set();
  const native = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    let buffer = ''; socket.setEncoding('utf8');
    socket.on('data', chunk => { buffer += chunk; const lines = buffer.split('\n'); buffer = lines.pop(); for (const line of lines) frames.push(JSON.parse(line)); });
  });
  await new Promise((resolve, reject) => { native.once('error', reject); native.listen(socketPath, resolve); });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => native.close(resolve)); });
  const client = await consumer(t, endpoint, { providerOptions: { registryDir, projectsDir, timeoutMs: 1000 } });
  await client.initialize();
  await client.request('tools/list');
  // EOF occurs while the actual provider's callback receiver is being created, not after a stub close.
  client.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 900, method: 'tools/call',
    params: { name: 'claude_send_message', arguments: { sessionId, message: 'isolated fixture send' } } }) + '\n');
  client.child.stdin.end();
  assert.equal(await client.closed, 0);
  assert.equal(client.stderr(), '');
  assert.deepEqual((await readdir(registryDir)).sort(), before);
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0], { type: 'auth', token });
  assert.equal(frames[1].session_id, sessionId);
  assert.match(frames[1].message.content, /外部 MCP｜來源 Codex owner authorized-owner/);
  assert.ok(frames[1].message.content.includes('\n' + 'isolated fixture send' + '\n</cross-session-message>'));
  assert.ok(!JSON.stringify(client.messages).includes(token));
});
